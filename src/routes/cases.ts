import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, insertActivity, unwrap } from "../utils/supabase.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const caseBodySchema = z.object({
  title: z.string().min(2).max(240),
  client_id: z.string().uuid(),
  court: z.string().optional(),
  court_number: z.string().optional(),
  case_type: z.string().optional(),
  status: z.enum(["open", "pending", "closed", "archived"]).default("open"),
  opened_at: z.string().datetime().optional(),
  responsible_lawyer: z.string().uuid().optional(),
  summary: z.string().optional(),
});

export async function registerCaseRoutes(app: FastifyInstance) {
  app.get("/v1/cases", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        status: z.string().optional(),
        clientId: z.string().uuid().optional(),
        q: z.string().optional(),
        ...paginationSchema,
      }),
    );
    let builder = request
      .supabase!.from("cases")
      .select("*, clients(id, name, type)")
      .order("created_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);

    if (query.status) builder = builder.eq("status", query.status);
    if (query.clientId) builder = builder.eq("client_id", query.clientId);
    if (query.q) builder = builder.ilike("title", `%${query.q}%`);

    return { data: unwrap(await builder) };
  });

  app.get("/v1/cases/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const legalCase = unwrap(
      await request
        .supabase!.from("cases")
        .select(
          "*, clients(*), case_members(*, profiles(full_name)), case_parties(*), case_notes(*), case_events(*)",
        )
        .eq("id", id)
        .single(),
    );
    return { data: legalCase };
  });

  app.post("/v1/cases", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(request, caseBodySchema);
    const legalCase = unwrap(
      await request
        .supabase!.from("cases")
        .insert({
          ...body,
          org_id: membership.org_id,
          owner_id: request.auth!.userId,
          responsible_lawyer: body.responsible_lawyer ?? request.auth!.userId,
        })
        .select("*")
        .single(),
    );

    await request.supabase!.from("case_members").insert({
      org_id: membership.org_id,
      case_id: (legalCase as any).id,
      user_id: request.auth!.userId,
      role: "lead",
    });

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "case",
      entity_id: (legalCase as any).id,
      action: "created",
    });

    return { data: legalCase };
  });

  app.patch("/v1/cases/:id", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const patch = parseBody(request, caseBodySchema.partial());
    const legalCase = unwrap(
      await request.supabase!.from("cases").update(patch).eq("id", id).select("*").single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "case",
      entity_id: id,
      action: "updated",
      meta: { fields: Object.keys(patch) },
    });

    return { data: legalCase };
  });

  app.delete("/v1/cases/:id", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const legalCase = unwrap(
      await request.supabase!.from("cases").delete().eq("id", id).select("*").single(),
    );
    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "case",
      entity_id: id,
      action: "deleted",
    });
    return { data: legalCase };
  });

  app.post("/v1/cases/:id/parties", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        role: z.enum(["plaintiff", "defendant", "witness", "expert", "other"]),
        name: z.string().min(1),
        details: z.record(z.unknown()).optional(),
      }),
    );
    const party = unwrap(
      await request
        .supabase!.from("case_parties")
        .insert({ ...body, org_id: membership.org_id, case_id: id })
        .select("*")
        .single(),
    );
    return { data: party };
  });

  app.post("/v1/cases/:id/notes", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(request, z.object({ body: z.string().min(1) }));
    const note = unwrap(
      await request
        .supabase!.from("case_notes")
        .insert({
          org_id: membership.org_id,
          case_id: id,
          body: body.body,
          user_id: request.auth!.userId,
        })
        .select("*")
        .single(),
    );
    return { data: note };
  });

  app.post("/v1/cases/:id/sessions", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        scheduled_at: z.string().datetime(),
        location: z.string().optional(),
        outcome: z.string().optional(),
      }),
    );
    const session = unwrap(
      await request
        .supabase!.from("case_events")
        .insert({ ...body, org_id: membership.org_id, case_id: id })
        .select("*")
        .single(),
    );
    return { data: session };
  });

  app.post("/v1/cases/:id/members", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        user_id: z.string().uuid(),
        role: z.enum(["lead", "collab", "viewer"]).default("collab"),
      }),
    );
    const member = unwrap(
      await request
        .supabase!.from("case_members")
        .insert({ ...body, org_id: membership.org_id, case_id: id })
        .select("*")
        .single(),
    );
    return { data: member };
  });
}
