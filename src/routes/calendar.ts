import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, insertActivity, unwrap } from "../utils/supabase.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const appointmentSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(["hearing", "meeting", "call", "task", "other"]).default("meeting"),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime().optional(),
  owner_id: z.string().uuid().optional(),
  case_id: z.string().uuid().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
});

const deadlineSchema = z.object({
  title: z.string().min(1).max(200),
  due_at: z.string().datetime(),
  case_id: z.string().uuid().optional(),
  kind: z.string().min(1),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  assignee_id: z.string().uuid().optional(),
  reminder_offsets: z.array(z.number().int()).default([]),
});

export async function registerCalendarRoutes(app: FastifyInstance) {
  app.get("/v1/appointments", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        from: z.string().datetime(),
        to: z.string().datetime(),
        ownerId: z.string().uuid().optional(),
        caseId: z.string().uuid().optional(),
      }),
    );

    let builder = request
      .supabase!.from("appointments")
      .select("*")
      .gte("starts_at", query.from)
      .lte("starts_at", query.to)
      .order("starts_at", { ascending: true });

    if (query.ownerId) builder = builder.eq("owner_id", query.ownerId);
    if (query.caseId) builder = builder.eq("case_id", query.caseId);
    return { data: unwrap(await builder) };
  });

  app.post("/v1/appointments", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(request, appointmentSchema);
    const appointment = unwrap(
      await request
        .supabase!.from("appointments")
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
      entity_type: "appointment",
      entity_id: (appointment as any).id,
      action: "created",
    });

    return { data: appointment };
  });

  app.patch("/v1/appointments/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const patch = parseBody(request, appointmentSchema.partial());
    const appointment = unwrap(
      await request.supabase!.from("appointments").update(patch).eq("id", id).select("*").single(),
    );
    return { data: appointment };
  });

  app.delete("/v1/appointments/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const appointment = unwrap(
      await request.supabase!.from("appointments").delete().eq("id", id).select("*").single(),
    );
    return { data: appointment };
  });

  app.get("/v1/deadlines", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        caseId: z.string().uuid().optional(),
        status: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        ...paginationSchema,
      }),
    );

    let builder = request
      .supabase!.from("deadlines")
      .select("*")
      .order("due_at", { ascending: true })
      .range(query.offset, query.offset + query.limit - 1);

    if (query.caseId) builder = builder.eq("case_id", query.caseId);
    if (query.status) builder = builder.eq("status", query.status);
    if (query.from) builder = builder.gte("due_at", query.from);
    if (query.to) builder = builder.lte("due_at", query.to);

    return { data: unwrap(await builder) };
  });

  app.post("/v1/deadlines", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(request, deadlineSchema);
    const deadline = unwrap(
      await request
        .supabase!.from("deadlines")
        .insert({
          ...body,
          org_id: membership.org_id,
          assignee_id: body.assignee_id ?? request.auth!.userId,
          status: "open",
        })
        .select("*")
        .single(),
    ) as any;

    for (const offset of body.reminder_offsets) {
      const scheduledAt = new Date(new Date(body.due_at).getTime() - offset * 60_000);
      await request.supabase!.from("notifications").insert({
        org_id: membership.org_id,
        user_id: body.assignee_id ?? request.auth!.userId,
        kind: "deadline_reminder",
        title: body.title,
        body: `Reminder for deadline due at ${body.due_at}`,
        link: `/deadlines/${deadline.id}`,
        scheduled_at: scheduledAt.toISOString(),
      });
    }

    return { data: deadline };
  });

  app.patch("/v1/deadlines/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const patch = parseBody(
      request,
      deadlineSchema.partial().extend({ status: z.string().optional() }),
    );
    const deadline = unwrap(
      await request.supabase!.from("deadlines").update(patch).eq("id", id).select("*").single(),
    );
    return { data: deadline };
  });

  app.post("/v1/deadlines/:id/complete", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const deadline = unwrap(
      await request
        .supabase!.from("deadlines")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .single(),
    );
    return { data: deadline };
  });
}
