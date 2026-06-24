import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, unwrap } from "../utils/supabase.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.get("/v1/notifications", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        unreadOnly: z.coerce.boolean().default(false),
        ...paginationSchema,
      }),
    );

    await getCurrentMembership(request.supabase!, request.auth!.userId);
    let builder = request
      .supabase!.from("notifications")
      .select("*")
      .eq("user_id", request.auth!.userId)
      .order("created_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);
    if (query.unreadOnly) builder = builder.is("read_at", null);

    return { data: unwrap(await builder) };
  });

  app.post("/v1/notifications/:id/read", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const notification = unwrap(
      await request
        .supabase!.from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", request.auth!.userId)
        .select("*")
        .single(),
    );
    return { data: notification };
  });

  app.post("/v1/notifications/read-all", { preHandler: app.requireAuth }, async (request) => {
    const notifications = unwrap(
      await request
        .supabase!.from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("user_id", request.auth!.userId)
        .is("read_at", null)
        .select("*"),
    );
    return { data: notifications };
  });

  app.post("/v1/notifications", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        user_id: z.string().uuid(),
        kind: z.string().min(1),
        title: z.string().min(1),
        body: z.string().min(1),
        link: z.string().optional(),
        scheduled_at: z.string().datetime().optional(),
      }),
    );
    const notification = unwrap(
      await request
        .supabase!.from("notifications")
        .insert({ ...body, org_id: membership.org_id })
        .select("*")
        .single(),
    );
    return { data: notification };
  });
}
