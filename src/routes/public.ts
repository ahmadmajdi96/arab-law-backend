import { performance } from "node:perf_hooks";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "undici";
import { z } from "zod";
import { env } from "../config/env.js";
import { documentShares, documents, payments, taxInvoices } from "../db/schema.js";
import { enqueueJob } from "../queues/index.js";
import { estimateTokens, novitaChatCompletionsUrl } from "../services/ai-gateway.js";
import { aiRequestDuration, aiRequestsTotal, aiTokensTotal } from "../services/metrics.js";
import { markOverdueInvoices } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { verifyHmacSha256 } from "../utils/security.js";
import { data } from "../utils/serialize.js";
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
        reference: z.string().optional(),
        provider_payload: z.record(z.unknown()).optional(),
      }),
    );

    const [payment] = await app.db
      .insert(payments)
      .values({
        invoiceId: body.invoice_id,
        orgId: body.org_id,
        amount: String(body.amount),
        method: body.method,
        paidAt: body.paid_at ? new Date(body.paid_at) : new Date(),
        reference: body.reference,
        providerPayload: body.provider_payload,
      })
      .returning();

    await app.db
      .update(taxInvoices)
      .set({ status: "paid", paidAmount: String(body.amount), updatedAt: new Date() })
      .where(and(eq(taxInvoices.id, body.invoice_id), eq(taxInvoices.orgId, body.org_id)));

    return data(payment);
  });

  app.post("/api/public/cron/mark-overdue", { preHandler: app.requireCron }, async () => {
    const updated = await markOverdueInvoices(app.db);
    await enqueueJob("billing", "overdue-sweep", {});
    return data({ ok: true, updated });
  });

  app.post("/api/public/cron/send-reminders", { preHandler: app.requireCron }, async () => {
    const job = await enqueueJob("notifications", "send-due-reminders", {
      requestedAt: new Date().toISOString(),
    });
    return data(job);
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
      aiTokensTotal.inc({ feature, model: body.model, direction: "completion" }, completionTokens);

      if (response.statusCode >= 400) {
        throw errors.upstream("Novita smoke request failed", {
          statusCode: response.statusCode,
          payload,
        });
      }

      return data({
        ok: true,
        model: body.model,
        latencyMs: Math.round(latencySeconds * 1000),
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
        },
        text: payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? "",
      });
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

    return data(payload);
  });

  app.get("/share/:token", async (request, reply) => {
    const { token } = parseParams(request, z.object({ token: z.string().min(16) }));
    const [share] = await app.db
      .select()
      .from(documentShares)
      .where(eq(documentShares.token, token))
      .limit(1);

    if (!share || share.expiresAt.getTime() < Date.now()) {
      return reply.code(404).send({ error: { code: "SHARE_NOT_FOUND" } });
    }

    const [document] = await app.db
      .select()
      .from(documents)
      .where(eq(documents.id, share.documentId))
      .limit(1);
    if (!document) return reply.code(404).send({ error: { code: "DOCUMENT_NOT_FOUND" } });

    const signedUrl = await app.storage.signedDownloadUrl({
      key: document.storagePath,
      filename: document.name,
      download: share.allowDownload,
      expiresIn: 300,
    });

    return reply.redirect(signedUrl);
  });
}
