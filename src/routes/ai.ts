import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiUsageEvents, courtroomSimulations, documents } from "../db/schema.js";
import { callAiGateway, getCaseContext } from "../services/ai-gateway.js";
import { getRequestMembership } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data, toApi } from "../utils/serialize.js";
import { parseBody, parseQuery } from "../utils/validation.js";

const jordanLawSystemPrompt = `
You are a Jordanian legal research assistant. Restrict analysis to Jordanian law and clearly separate:
1. direct statutory or official-source support,
2. case-law or interpretive support,
3. practical legal reasoning.
Prefer the Jordanian Constitution, Civil Code 1976, Penal Code 1960, Civil Procedure Law, Companies Law, Labor Law, Cassation Court rulings, Official Gazette materials, and court/regulator publications.
If you cannot verify a source, say so and do not fabricate article numbers, case numbers, dates, or citations.
`.trim();

export async function registerAiRoutes(app: FastifyInstance) {
  app.post("/v1/ai/research/jordan", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        query: z.string().min(3),
        language: z.enum(["ar", "en"]).default("ar"),
        model: z.string().optional(),
      }),
    );

    const ai = await callAiGateway({
      db: app.db,
      orgId: membership.orgId,
      userId: request.auth!.userId,
      feature: "legal_research.jordan",
      model: body.model,
      messages: [
        { role: "system", content: jordanLawSystemPrompt },
        {
          role: "user",
          content: `Language: ${body.language}\nResearch question:\n${body.query}\n\nReturn JSON with answer, citations[], confidence, and caveats.`,
        },
      ],
      responseFormat: "json",
    });

    return {
      data: safeJson(ai.text),
      usage: ai.usage,
    };
  });

  app.post("/v1/ai/cases/:caseId/summarize", { preHandler: app.requireAuth }, async (request) => {
    const params = z.object({ caseId: z.string().uuid() }).parse(request.params);
    const { membership } = await getRequestMembership(app.db, request);
    const legalCase = await getCaseContext(app.db, membership.orgId, params.caseId);
    const ai = await callAiGateway({
      db: app.db,
      orgId: membership.orgId,
      userId: request.auth!.userId,
      feature: "case.summarize",
      messages: [
        {
          role: "system",
          content:
            "Summarize the case file for a lawyer. Include facts, procedural posture, risks, missing information, and next actions. Do not invent facts.",
        },
        { role: "user", content: JSON.stringify(toApi(legalCase)) },
      ],
      metadata: { case_id: params.caseId },
    });

    return { data: { summary: ai.text }, usage: ai.usage };
  });

  app.post("/v1/ai/cases/:caseId/next-steps", { preHandler: app.requireAuth }, async (request) => {
    const params = z.object({ caseId: z.string().uuid() }).parse(request.params);
    const { membership } = await getRequestMembership(app.db, request);
    const legalCase = await getCaseContext(app.db, membership.orgId, params.caseId);
    const ai = await callAiGateway({
      db: app.db,
      orgId: membership.orgId,
      userId: request.auth!.userId,
      feature: "case.next_steps",
      messages: [
        {
          role: "system",
          content:
            "Suggest practical next steps for a Jordanian legal matter. Return ordered actions, deadlines to consider, documents needed, and risk notes.",
        },
        { role: "user", content: JSON.stringify(toApi(legalCase)) },
      ],
      responseFormat: "json",
      metadata: { case_id: params.caseId },
    });

    return { data: safeJson(ai.text), usage: ai.usage };
  });

  app.post(
    "/v1/ai/documents/:documentId/extract-text",
    { preHandler: app.requireAuth },
    async (request) => {
      const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);
      const { membership } = await getRequestMembership(app.db, request);
      const [document] = await app.db
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.orgId, membership.orgId)))
        .limit(1);
      if (!document) throw errors.notFound("Document not found");

      const signedUrl = await app.storage.signedDownloadUrl({
        key: document.storagePath,
        filename: document.name,
        expiresIn: 300,
      });

      const ai = await callAiGateway({
        db: app.db,
        orgId: membership.orgId,
        userId: request.auth!.userId,
        feature: "document.extract_text",
        messages: [
          {
            role: "system",
            content:
              "Extract text from the provided document URL. Preserve structure where possible. If OCR is not possible, explain why.",
          },
          { role: "user", content: signedUrl },
        ],
        metadata: { document_id: documentId },
      });

      return { data: { text: ai.text }, usage: ai.usage };
    },
  );

  app.post("/v1/courtroom/simulations", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        case_id: z.string().uuid(),
        scenario: z.string().min(1),
        role: z.enum(["plaintiff", "defendant", "judge", "witness"]),
      }),
    );
    const [simulation] = await app.db
      .insert(courtroomSimulations)
      .values({
        orgId: membership.orgId,
        caseId: body.case_id,
        scenario: body.scenario,
        role: body.role,
        userId: request.auth!.userId,
        transcript: [],
      })
      .returning();
    return data(simulation);
  });

  app.post(
    "/v1/courtroom/simulations/:id/turn",
    { preHandler: app.requireAuth },
    async (request) => {
      const { membership } = await getRequestMembership(app.db, request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = parseBody(request, z.object({ user_message: z.string().min(1) }));
      const [simulation] = await app.db
        .select()
        .from(courtroomSimulations)
        .where(
          and(eq(courtroomSimulations.id, id), eq(courtroomSimulations.orgId, membership.orgId)),
        )
        .limit(1);
      if (!simulation) throw errors.notFound("Simulation not found");

      const transcript = Array.isArray(simulation.transcript) ? simulation.transcript : [];
      const ai = await callAiGateway({
        db: app.db,
        orgId: membership.orgId,
        userId: request.auth!.userId,
        feature: "courtroom.simulate_turn",
        messages: [
          {
            role: "system",
            content:
              "You are a courtroom simulator for Jordanian legal practice. Stay in role, challenge weak arguments, and keep replies concise and realistic.",
          },
          {
            role: "user",
            content: JSON.stringify({
              scenario: simulation.scenario,
              role: simulation.role,
              transcript,
              user_message: body.user_message,
            }),
          },
        ],
        metadata: { simulation_id: id, case_id: simulation.caseId },
      });

      const updatedTranscript = [
        ...transcript,
        { role: "user", content: body.user_message, at: new Date().toISOString() },
        { role: "assistant", content: ai.text, at: new Date().toISOString() },
      ];

      const [updated] = await app.db
        .update(courtroomSimulations)
        .set({ transcript: updatedTranscript, updatedAt: new Date() })
        .where(eq(courtroomSimulations.id, id))
        .returning();

      return { data: toApi(updated), usage: ai.usage };
    },
  );

  app.get("/v1/ai/usage", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(
      request,
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }),
    );
    const filters = [eq(aiUsageEvents.orgId, membership.orgId)];
    if (query.from) filters.push(gte(aiUsageEvents.createdAt, new Date(query.from)));
    if (query.to) filters.push(lte(aiUsageEvents.createdAt, new Date(query.to)));

    const events = await app.db
      .select()
      .from(aiUsageEvents)
      .where(and(...filters))
      .orderBy(desc(aiUsageEvents.createdAt))
      .limit(1000);
    const totals = events.reduce(
      (sum, event) => ({
        prompt_tokens: sum.prompt_tokens + Number(event.promptTokens ?? 0),
        completion_tokens: sum.completion_tokens + Number(event.completionTokens ?? 0),
        total_tokens: sum.total_tokens + Number(event.totalTokens ?? 0),
      }),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    );

    return { data: { totals, events: toApi(events) } };
  });
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return {
      answer: text,
      citations: [],
      confidence: "unknown",
      caveats: ["Non-JSON AI response"],
    };
  }
}
