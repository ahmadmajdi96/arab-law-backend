import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { callAiGateway, getCaseContext } from "../services/ai-gateway.js";
import { getCurrentMembership, unwrap } from "../utils/supabase.js";
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
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        query: z.string().min(3),
        language: z.enum(["ar", "en"]).default("ar"),
        model: z.string().optional(),
      }),
    );

    const ai = await callAiGateway({
      admin: app.supabaseAdmin,
      orgId: membership.org_id,
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
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const legalCase = await getCaseContext(request.supabase!, params.caseId);
    const ai = await callAiGateway({
      admin: app.supabaseAdmin,
      orgId: membership.org_id,
      userId: request.auth!.userId,
      feature: "case.summarize",
      messages: [
        {
          role: "system",
          content:
            "Summarize the case file for a lawyer. Include facts, procedural posture, risks, missing information, and next actions. Do not invent facts.",
        },
        { role: "user", content: JSON.stringify(legalCase) },
      ],
      metadata: { case_id: params.caseId },
    });

    return { data: { summary: ai.text }, usage: ai.usage };
  });

  app.post("/v1/ai/cases/:caseId/next-steps", { preHandler: app.requireAuth }, async (request) => {
    const params = z.object({ caseId: z.string().uuid() }).parse(request.params);
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const legalCase = await getCaseContext(request.supabase!, params.caseId);
    const ai = await callAiGateway({
      admin: app.supabaseAdmin,
      orgId: membership.org_id,
      userId: request.auth!.userId,
      feature: "case.next_steps",
      messages: [
        {
          role: "system",
          content:
            "Suggest practical next steps for a Jordanian legal matter. Return ordered actions, deadlines to consider, documents needed, and risk notes.",
        },
        { role: "user", content: JSON.stringify(legalCase) },
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
      const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
      const document = unwrap(
        await request.supabase!.from("documents").select("*").eq("id", documentId).single(),
      ) as any;
      const signed = await request
        .supabase!.storage.from("documents")
        .createSignedUrl(document.storage_path, 300);
      if (signed.error) throw signed.error;

      const ai = await callAiGateway({
        admin: app.supabaseAdmin,
        orgId: membership.org_id,
        userId: request.auth!.userId,
        feature: "document.extract_text",
        messages: [
          {
            role: "system",
            content:
              "Extract text from the provided document URL. Preserve structure where possible. If OCR is not possible, explain why.",
          },
          { role: "user", content: signed.data.signedUrl },
        ],
        metadata: { document_id: documentId },
      });

      return { data: { text: ai.text }, usage: ai.usage };
    },
  );

  app.post("/v1/courtroom/simulations", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        case_id: z.string().uuid(),
        scenario: z.string().min(1),
        role: z.enum(["plaintiff", "defendant", "judge", "witness"]),
      }),
    );
    const simulation = unwrap(
      await request
        .supabase!.from("courtroom_simulations")
        .insert({
          ...body,
          org_id: membership.org_id,
          user_id: request.auth!.userId,
          transcript: [],
        })
        .select("*")
        .single(),
    );
    return { data: simulation };
  });

  app.post(
    "/v1/courtroom/simulations/:id/turn",
    { preHandler: app.requireAuth },
    async (request) => {
      const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = parseBody(request, z.object({ user_message: z.string().min(1) }));
      const simulation = unwrap(
        await request.supabase!.from("courtroom_simulations").select("*").eq("id", id).single(),
      ) as any;
      const transcript = Array.isArray(simulation.transcript) ? simulation.transcript : [];

      const ai = await callAiGateway({
        admin: app.supabaseAdmin,
        orgId: membership.org_id,
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
        metadata: { simulation_id: id, case_id: simulation.case_id },
      });

      const updatedTranscript = [
        ...transcript,
        { role: "user", content: body.user_message, at: new Date().toISOString() },
        { role: "assistant", content: ai.text, at: new Date().toISOString() },
      ];

      const updated = unwrap(
        await request
          .supabase!.from("courtroom_simulations")
          .update({ transcript: updatedTranscript })
          .eq("id", id)
          .select("*")
          .single(),
      );

      return { data: updated, usage: ai.usage };
    },
  );

  app.get("/v1/ai/usage", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const query = parseQuery(
      request,
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }),
    );
    let builder = app.supabaseAdmin
      .from("ai_usage_events")
      .select("*")
      .eq("org_id", membership.org_id)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (query.from) builder = builder.gte("created_at", query.from);
    if (query.to) builder = builder.lte("created_at", query.to);
    const events = unwrap(await builder) as any[];
    const totals = events.reduce(
      (sum, event) => ({
        prompt_tokens: sum.prompt_tokens + Number(event.prompt_tokens ?? 0),
        completion_tokens: sum.completion_tokens + Number(event.completion_tokens ?? 0),
        total_tokens: sum.total_tokens + Number(event.total_tokens ?? 0),
      }),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    );

    return { data: { totals, events } };
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
