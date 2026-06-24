import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "undici";
import { z } from "zod";
import { env } from "../config/env.js";
import { enqueueJob } from "../queues/index.js";
import { estimateTokens, novitaChatCompletionsUrl } from "../services/ai-gateway.js";
import { aiRequestDuration, aiRequestsTotal, aiTokensTotal } from "../services/metrics.js";
import { errors } from "../utils/errors.js";
import { verifyHmacSha256 } from "../utils/security.js";
import { unwrap, unwrapNullable } from "../utils/supabase.js";
import { parseBody, parseParams } from "../utils/validation.js";

export async function registerPublicRoutes(app: FastifyInstance) {
  app.post("/api/public/webhooks/payments", async (request, reply) => {
    const raw = (request as any).rawBody ?? JSON.stringify(request.body ?? {});
    const signature =
      request.headers["x-signature"]?.toString() ??
      request.headers["x-webhook-signature"]?.toString();

    if (!verifyHmacSha256({ payload: raw, signature, secret: env.PAYMENT_WEBHOOK_SECRET })) {
      return reply.code(401).send({ error: { code: "INVALID_SIGNATURE" } });
    }

    const body = parseBody(
      request,
      z.object({
        invoice_id: z.string().uuid(),
        org_id: z.string().uuid(),
        amount: z.number().positive(),
        method: z.string().default("webhook"),
        paid_at: z.string().datetime().optional(),
        ref: z.string().optional(),
        provider_payload: z.record(z.unknown()).optional(),
      }),
    );

    const payment = unwrap(
      await app.supabaseAdmin
        .from("payments")
        .insert({
          ...body,
          paid_at: body.paid_at ?? new Date().toISOString(),
        })
        .select("*")
        .single(),
    );

    await app.supabaseAdmin
      .from("tax_invoices")
      .update({ status: "paid" })
      .eq("id", body.invoice_id)
      .eq("org_id", body.org_id);

    return { data: payment };
  });

  app.post("/api/public/cron/mark-overdue", { preHandler: app.requireCron }, async () => {
    const result = await app.supabaseAdmin.rpc("mark_invoices_overdue");
    if (result.error) throw result.error;
    await enqueueJob("billing", "overdue-sweep", {});
    return { data: { ok: true, result: result.data } };
  });

  app.post("/api/public/cron/send-reminders", { preHandler: app.requireCron }, async () => {
    const job = await enqueueJob("notifications", "send-due-reminders", {
      requestedAt: new Date().toISOString(),
    });
    return { data: job };
  });

  app.post(
    "/api/public/monitoring/novita-smoke",
    { preHandler: app.requireCron },
    async (request) => {
      if (!env.NOVITA_API_KEY) {
        throw errors.unavailable("NOVITA_API_KEY is required for Novita smoke monitoring");
      }

      const body = parseBody(
        request,
        z
          .object({
            model: z.string().default(env.AI_DEFAULT_MODEL),
            prompt: z
              .string()
              .min(1)
              .max(500)
              .default("Reply with exactly: arab.law monitoring ok"),
            max_tokens: z.number().int().min(1).max(64).default(16),
          })
          .default({}),
      );
      const feature = "monitoring.novita_smoke";
      const started = performance.now();

      try {
        const response = await httpRequest(novitaChatCompletionsUrl(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.NOVITA_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: body.model,
            max_tokens: body.max_tokens,
            temperature: 0,
            messages: [
              {
                role: "system",
                content: "You are a monitoring smoke test. Keep the response very short.",
              },
              {
                role: "user",
                content: body.prompt,
              },
            ],
          }),
        });

        const payload = (await response.body.json()) as any;
        const status = response.statusCode >= 400 ? "error" : "success";
        const latencySeconds = (performance.now() - started) / 1000;
        const usage = payload?.usage ?? {};
        const promptTokens = Number(usage.prompt_tokens ?? estimateTokens(body.prompt));
        const completionTokens = Number(
          usage.completion_tokens ?? estimateTokens(payload?.choices?.[0]?.message?.content ?? ""),
        );

        aiRequestsTotal.inc({ feature, model: body.model, status });
        aiRequestDuration.observe({ feature, model: body.model, status }, latencySeconds);
        aiTokensTotal.inc({ feature, model: body.model, direction: "prompt" }, promptTokens);
        aiTokensTotal.inc(
          { feature, model: body.model, direction: "completion" },
          completionTokens,
        );

        if (response.statusCode >= 400) {
          throw errors.upstream("Novita smoke request failed", {
            statusCode: response.statusCode,
            payload,
          });
        }

        return {
          data: {
            ok: true,
            model: body.model,
            latency_ms: Math.round(latencySeconds * 1000),
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
            },
            text: payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? "",
          },
        };
      } catch (error) {
        if (error instanceof Error && error.name !== "AppError") {
          aiRequestsTotal.inc({ feature, model: body.model, status: "error" });
        }
        throw error;
      }
    },
  );

  app.get("/api/elevenlabs/scribe-token", { preHandler: app.requireAuth }, async (request) => {
    if (!env.ELEVENLABS_API_KEY) {
      throw errors.unavailable("ELEVENLABS_API_KEY is required to mint Scribe tokens");
    }

    const response = await httpRequest(env.ELEVENLABS_SCRIBE_TOKEN_URL, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_id: request.auth!.userId,
        ttl_seconds: 300,
      }),
    });

    const payload = (await response.body.json()) as unknown;
    if (response.statusCode >= 400) {
      throw errors.upstream("ElevenLabs token minting failed", payload);
    }

    return { data: payload };
  });

  app.get("/share/:token", async (request, reply) => {
    const { token } = parseParams(request, z.object({ token: z.string().min(16) }));
    const share = unwrapNullable(
      await app.supabaseAdmin.from("document_shares").select("*").eq("token", token).maybeSingle(),
    ) as any;

    if (!share || new Date(share.expires_at).getTime() < Date.now()) {
      return reply.code(404).send({ error: { code: "SHARE_NOT_FOUND" } });
    }

    const document = unwrap(
      await app.supabaseAdmin.from("documents").select("*").eq("id", share.document_id).single(),
    ) as any;
    const signed = await app.supabaseAdmin.storage
      .from("documents")
      .createSignedUrl(document.storage_path, 300, {
        download: Boolean(share.allow_download),
      });

    if (signed.error) throw signed.error;
    return reply.redirect(signed.data.signedUrl);
  });
}
