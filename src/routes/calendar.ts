import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appointments, deadlines, notifications } from "../db/schema.js";
import { getRequestMembership, insertActivity } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

export async function registerCalendarRoutes(app: FastifyInstance) {
  app.get("/v1/appointments", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(request, z.object({ ...paginationSchema }));
    const rows = await app.db
      .select()
      .from(appointments)
      .where(eq(appointments.orgId, membership.orgId))
      .orderBy(desc(appointments.startsAt))
      .limit(query.limit)
      .offset(query.offset);
    return data(rows);
  });

  app.post("/v1/appointments", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime().optional(),
        case_id: z.string().uuid().optional(),
        client_id: z.string().uuid().optional(),
        owner_id: z.string().uuid().optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [appointment] = await app.db
      .insert(appointments)
      .values({
        orgId: membership.orgId,
        title: body.title,
        startsAt: new Date(body.starts_at),
        endsAt: body.ends_at ? new Date(body.ends_at) : undefined,
        caseId: body.case_id,
        clientId: body.client_id,
        ownerId: body.owner_id ?? request.auth!.userId,
        location: body.location,
        notes: body.notes,
        metadata: body.metadata ?? {},
      })
      .returning();

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "appointment",
      entityId: appointment?.id,
      action: "created",
    });

    return data(appointment);
  });

  app.patch("/v1/appointments/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1).optional(),
        starts_at: z.string().datetime().optional(),
        ends_at: z.string().datetime().optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [appointment] = await app.db
      .update(appointments)
      .set({
        title: body.title,
        startsAt: body.starts_at ? new Date(body.starts_at) : undefined,
        endsAt: body.ends_at ? new Date(body.ends_at) : undefined,
        location: body.location,
        notes: body.notes,
        metadata: body.metadata,
        updatedAt: new Date(),
      })
      .where(and(eq(appointments.id, id), eq(appointments.orgId, membership.orgId)))
      .returning();
    if (!appointment) throw errors.notFound("Appointment not found");
    return data(appointment);
  });

  app.delete("/v1/appointments/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [appointment] = await app.db
      .delete(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.orgId, membership.orgId)))
      .returning();
    if (!appointment) throw errors.notFound("Appointment not found");
    return data(appointment);
  });

  app.get("/v1/deadlines", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(
      request,
      z.object({ status: z.string().optional(), ...paginationSchema }),
    );
    const filters = [eq(deadlines.orgId, membership.orgId)];
    if (query.status) filters.push(eq(deadlines.status, query.status));
    const rows = await app.db
      .select()
      .from(deadlines)
      .where(and(...filters))
      .orderBy(desc(deadlines.dueAt))
      .limit(query.limit)
      .offset(query.offset);
    return data(rows);
  });

  app.post("/v1/deadlines", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        due_at: z.string().datetime(),
        case_id: z.string().uuid().optional(),
        assignee_id: z.string().uuid().optional(),
        priority: z.string().default("normal"),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const assigneeId = body.assignee_id ?? request.auth!.userId;
    const [deadline] = await app.db
      .insert(deadlines)
      .values({
        orgId: membership.orgId,
        title: body.title,
        dueAt: new Date(body.due_at),
        caseId: body.case_id,
        assigneeId,
        priority: body.priority,
        metadata: body.metadata ?? {},
      })
      .returning();

    await app.db.insert(notifications).values({
      orgId: membership.orgId,
      userId: assigneeId,
      title: "New deadline",
      body: body.title,
      kind: "deadline",
      metadata: { deadline_id: deadline?.id },
    });

    return data(deadline);
  });

  app.patch("/v1/deadlines/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1).optional(),
        due_at: z.string().datetime().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [deadline] = await app.db
      .update(deadlines)
      .set({
        title: body.title,
        dueAt: body.due_at ? new Date(body.due_at) : undefined,
        status: body.status,
        priority: body.priority,
        metadata: body.metadata,
        updatedAt: new Date(),
      })
      .where(and(eq(deadlines.id, id), eq(deadlines.orgId, membership.orgId)))
      .returning();
    if (!deadline) throw errors.notFound("Deadline not found");
    return data(deadline);
  });

  app.post("/v1/deadlines/:id/complete", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [deadline] = await app.db
      .update(deadlines)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(deadlines.id, id), eq(deadlines.orgId, membership.orgId)))
      .returning();
    if (!deadline) throw errors.notFound("Deadline not found");
    return data(deadline);
  });
}
