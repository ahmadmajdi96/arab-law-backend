import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, insertActivity, unwrap } from "../utils/supabase.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const clientBodySchema = z.object({
  name: z.string().min(2).max(200),
  type: z.enum(["individual", "company"]),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  national_id: z.string().max(100).optional(),
  address: z.string().max(500).optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  owner_id: z.string().uuid().optional(),
});

export async function registerClientRoutes(app: FastifyInstance) {
  app.get("/v1/clients", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        q: z.string().optional(),
        type: z.enum(["individual", "company"]).optional(),
        tag: z.string().optional(),
        ...paginationSchema,
      }),
    );

    let builder = request
      .supabase!.from("clients")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);

    if (query.q) builder = builder.ilike("name", `%${query.q}%`);
    if (query.type) builder = builder.eq("type", query.type);
    if (query.tag) builder = builder.contains("tags", [query.tag]);

    return { data: unwrap(await builder) };
  });

  app.get("/v1/clients/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const client = unwrap(
      await request
        .supabase!.from("clients")
        .select("*, client_interactions(*), cases(id, title, status, opened_at)")
        .eq("id", id)
        .single(),
    );
    return { data: client };
  });

  app.post("/v1/clients", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(request, clientBodySchema);
    const client = unwrap(
      await request
        .supabase!.from("clients")
        .insert({
          ...body,
          org_id: membership.org_id,
          owner_id: body.owner_id ?? request.auth!.userId,
        })
        .select("*")
        .single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "client",
      entity_id: (client as any).id,
      action: "created",
    });

    return { data: client };
  });

  app.patch("/v1/clients/:id", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const patch = parseBody(request, clientBodySchema.partial());
    const client = unwrap(
      await request.supabase!.from("clients").update(patch).eq("id", id).select("*").single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "client",
      entity_id: id,
      action: "updated",
      meta: { fields: Object.keys(patch) },
    });

    return { data: client };
  });

  app.delete("/v1/clients/:id", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const client = unwrap(
      await request
        .supabase!.from("clients")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "client",
      entity_id: id,
      action: "deleted",
    });

    return { data: client };
  });

  app.post("/v1/clients/:id/interactions", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        kind: z.enum(["call", "email", "meeting", "note"]),
        body: z.string().min(1),
        occurred_at: z.string().datetime().optional(),
      }),
    );
    const interaction = unwrap(
      await request
        .supabase!.from("client_interactions")
        .insert({
          ...body,
          client_id: id,
          org_id: membership.org_id,
          user_id: request.auth!.userId,
        })
        .select("*")
        .single(),
    );

    return { data: interaction };
  });
}
