import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { callAiGateway } from "../services/ai-gateway.js";
import { getCurrentMembership, unwrap } from "../utils/supabase.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const draftSchema = z.object({
  kind: z.enum(["pleading", "contract", "letter", "memo", "other"]),
  title: z.string().min(1).max(240),
  case_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
  body: z.string().default(""),
  language: z.enum(["ar", "en"]).default("ar"),
});

export async function registerDraftRoutes(app: FastifyInstance) {
  app.get("/v1/drafts", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        caseId: z.string().uuid().optional(),
        clientId: z.string().uuid().optional(),
        ...paginationSchema,
      }),
    );
    let builder = request
      .supabase!.from("drafts")
      .select("*")
      .order("updated_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);
    if (query.caseId) builder = builder.eq("case_id", query.caseId);
    if (query.clientId) builder = builder.eq("client_id", query.clientId);
    return { data: unwrap(await builder) };
  });

  app.post("/v1/drafts", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(request, draftSchema);
    const draft = unwrap(
      await request
        .supabase!.from("drafts")
        .insert({
          ...body,
          org_id: membership.org_id,
          created_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );
    return { data: draft };
  });

  app.post("/v1/drafts/generate", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        kind: z.enum(["pleading", "contract", "letter", "memo", "other"]),
        title: z.string().min(1),
        facts: z.string().min(1),
        instructions: z.string().optional(),
        case_id: z.string().uuid().optional(),
        client_id: z.string().uuid().optional(),
        language: z.enum(["ar", "en"]).default("ar"),
      }),
    );

    const ai = await callAiGateway({
      admin: app.supabaseAdmin,
      orgId: membership.org_id,
      userId: request.auth!.userId,
      feature: "draft.generate",
      messages: [
        {
          role: "system",
          content:
            "You are a senior legal drafting assistant for Jordanian law. Draft precise, professional legal text. Do not invent citations. If facts are missing, leave bracketed placeholders.",
        },
        {
          role: "user",
          content: JSON.stringify(body),
        },
      ],
      metadata: { kind: body.kind, case_id: body.case_id },
    });

    const draft = unwrap(
      await request
        .supabase!.from("drafts")
        .insert({
          org_id: membership.org_id,
          case_id: body.case_id,
          client_id: body.client_id,
          kind: body.kind,
          title: body.title,
          body: ai.text,
          language: body.language,
          created_by: request.auth!.userId,
          ai_usage: ai.usage,
        })
        .select("*")
        .single(),
    );

    return { data: draft, usage: ai.usage };
  });

  app.get("/v1/drafts/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const draft = unwrap(await request.supabase!.from("drafts").select("*").eq("id", id).single());
    return { data: draft };
  });

  app.patch("/v1/drafts/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const patch = parseBody(request, draftSchema.partial());
    const draft = unwrap(
      await request.supabase!.from("drafts").update(patch).eq("id", id).select("*").single(),
    );
    return { data: draft };
  });

  app.delete("/v1/drafts/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const draft = unwrap(
      await request.supabase!.from("drafts").delete().eq("id", id).select("*").single(),
    );
    return { data: draft };
  });
}
