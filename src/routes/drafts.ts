import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { drafts } from "../db/schema.js";
import { callAiGateway, getCaseContext } from "../services/ai-gateway.js";
import { getRequestMembership } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data, toApi } from "../utils/serialize.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

export async function registerDraftRoutes(app: FastifyInstance) {
  app.get("/v1/drafts", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(
      request,
      z.object({ caseId: z.string().uuid().optional(), ...paginationSchema }),
    );
    const filters = [eq(drafts.orgId, membership.orgId)];
    if (query.caseId) filters.push(eq(drafts.caseId, query.caseId));
    const rows = await app.db
      .select()
      .from(drafts)
      .where(and(...filters))
      .orderBy(desc(drafts.updatedAt))
      .limit(query.limit)
      .offset(query.offset);
    return data(rows);
  });

  app.post("/v1/drafts", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        kind: z.string().default("memo"),
        content: z.string().default(""),
        case_id: z.string().uuid().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [draft] = await app.db
      .insert(drafts)
      .values({
        orgId: membership.orgId,
        title: body.title,
        kind: body.kind,
        content: body.content,
        caseId: body.case_id,
        createdBy: request.auth!.userId,
        metadata: body.metadata ?? {},
      })
      .returning();
    return data(draft);
  });

  app.post("/v1/drafts/generate", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        kind: z.string().default("memo"),
        prompt: z.string().min(1),
        case_id: z.string().uuid().optional(),
        model: z.string().optional(),
      }),
    );
    const context = body.case_id
      ? await getCaseContext(app.db, membership.orgId, body.case_id)
      : undefined;
    const ai = await callAiGateway({
      db: app.db,
      orgId: membership.orgId,
      userId: request.auth!.userId,
      feature: "draft.generate",
      model: body.model,
      messages: [
        {
          role: "system",
          content:
            "Draft a clear legal document for a Jordanian law practice. Use professional structure and avoid unsupported citations.",
        },
        {
          role: "user",
          content: JSON.stringify({ prompt: body.prompt, kind: body.kind, case_context: context }),
        },
      ],
      metadata: { case_id: body.case_id },
    });

    const [draft] = await app.db
      .insert(drafts)
      .values({
        orgId: membership.orgId,
        caseId: body.case_id,
        title: body.title,
        kind: body.kind,
        content: ai.text,
        createdBy: request.auth!.userId,
        metadata: { generated: true },
      })
      .returning();

    return { data: toApi(draft), usage: ai.usage };
  });

  app.get("/v1/drafts/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [draft] = await app.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.orgId, membership.orgId)))
      .limit(1);
    if (!draft) throw errors.notFound("Draft not found");
    return data(draft);
  });

  app.patch("/v1/drafts/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1).optional(),
        content: z.string().optional(),
        status: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [draft] = await app.db
      .update(drafts)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(drafts.id, id), eq(drafts.orgId, membership.orgId)))
      .returning();
    if (!draft) throw errors.notFound("Draft not found");
    return data(draft);
  });

  app.delete("/v1/drafts/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [draft] = await app.db
      .delete(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.orgId, membership.orgId)))
      .returning();
    if (!draft) throw errors.notFound("Draft not found");
    return data(draft);
  });
}
