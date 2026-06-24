import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { caseEvents, caseMembers, caseNotes, caseParties, cases } from "../db/schema.js";
import { getRequestMembership, insertActivity } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const caseBody = z.object({
  client_id: z.string().uuid().optional(),
  title: z.string().min(1).max(240),
  case_number: z.string().optional(),
  type: z.string().default("general"),
  status: z.string().default("open"),
  court: z.string().optional(),
  judge: z.string().optional(),
  opponent: z.string().optional(),
  opened_at: z.string().datetime().optional(),
  closed_at: z.string().datetime().optional(),
  responsible_lawyer: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function registerCaseRoutes(app: FastifyInstance) {
  app.get("/v1/cases", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(
      request,
      z.object({
        status: z.string().optional(),
        clientId: z.string().uuid().optional(),
        ...paginationSchema,
      }),
    );
    const filters = [eq(cases.orgId, membership.orgId)];
    if (query.status) filters.push(eq(cases.status, query.status));
    if (query.clientId) filters.push(eq(cases.clientId, query.clientId));

    const rows = await app.db
      .select()
      .from(cases)
      .where(and(...filters))
      .orderBy(desc(cases.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return data(rows);
  });

  app.get("/v1/cases/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [legalCase] = await app.db
      .select()
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.orgId, membership.orgId)))
      .limit(1);
    if (!legalCase) throw errors.notFound("Case not found");

    const [parties, notes, events, members] = await Promise.all([
      app.db.select().from(caseParties).where(eq(caseParties.caseId, id)),
      app.db
        .select()
        .from(caseNotes)
        .where(eq(caseNotes.caseId, id))
        .orderBy(desc(caseNotes.createdAt)),
      app.db
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.caseId, id))
        .orderBy(desc(caseEvents.startsAt)),
      app.db.select().from(caseMembers).where(eq(caseMembers.caseId, id)),
    ]);

    return data({ ...legalCase, parties, notes, events, members });
  });

  app.post("/v1/cases", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(request, caseBody);
    const [legalCase] = await app.db
      .insert(cases)
      .values({
        orgId: membership.orgId,
        clientId: body.client_id,
        title: body.title,
        caseNumber: body.case_number,
        type: body.type,
        status: body.status,
        court: body.court,
        judge: body.judge,
        opponent: body.opponent,
        openedAt: body.opened_at ? new Date(body.opened_at) : new Date(),
        closedAt: body.closed_at ? new Date(body.closed_at) : undefined,
        ownerId: request.auth!.userId,
        responsibleLawyer: body.responsible_lawyer ?? request.auth!.userId,
        metadata: body.metadata ?? {},
      })
      .returning();
    if (!legalCase) throw errors.unavailable("Unable to create case");

    await app.db.insert(caseMembers).values({
      orgId: membership.orgId,
      caseId: legalCase.id,
      userId: request.auth!.userId,
      role: "owner",
    });

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "case",
      entityId: legalCase.id,
      action: "created",
    });

    return data(legalCase);
  });

  app.patch("/v1/cases/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(request, caseBody.partial());
    const [legalCase] = await app.db
      .update(cases)
      .set({
        clientId: body.client_id,
        title: body.title,
        caseNumber: body.case_number,
        type: body.type,
        status: body.status,
        court: body.court,
        judge: body.judge,
        opponent: body.opponent,
        openedAt: body.opened_at ? new Date(body.opened_at) : undefined,
        closedAt: body.closed_at ? new Date(body.closed_at) : undefined,
        responsibleLawyer: body.responsible_lawyer,
        metadata: body.metadata,
        updatedAt: new Date(),
      })
      .where(and(eq(cases.id, id), eq(cases.orgId, membership.orgId)))
      .returning();
    if (!legalCase) throw errors.notFound("Case not found");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "case",
      entityId: id,
      action: "updated",
    });

    return data(legalCase);
  });

  app.delete("/v1/cases/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [legalCase] = await app.db
      .delete(cases)
      .where(and(eq(cases.id, id), eq(cases.orgId, membership.orgId)))
      .returning();
    if (!legalCase) throw errors.notFound("Case not found");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "case",
      entityId: id,
      action: "deleted",
    });

    return data(legalCase);
  });

  app.post("/v1/cases/:id/parties", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        name: z.string().min(1),
        role: z.string().min(1),
        contact: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [party] = await app.db
      .insert(caseParties)
      .values({ orgId: membership.orgId, caseId: id, ...body, metadata: body.metadata ?? {} })
      .returning();
    return data(party);
  });

  app.post("/v1/cases/:id/notes", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        body: z.string().min(1),
        visibility: z.string().default("internal"),
      }),
    );
    const [note] = await app.db
      .insert(caseNotes)
      .values({
        orgId: membership.orgId,
        caseId: id,
        userId: request.auth!.userId,
        body: body.body,
        visibility: body.visibility,
      })
      .returning();
    return data(note);
  });

  app.post("/v1/cases/:id/sessions", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        kind: z.string().default("session"),
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime().optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [event] = await app.db
      .insert(caseEvents)
      .values({
        orgId: membership.orgId,
        caseId: id,
        title: body.title,
        kind: body.kind,
        startsAt: new Date(body.starts_at),
        endsAt: body.ends_at ? new Date(body.ends_at) : undefined,
        location: body.location,
        notes: body.notes,
        metadata: body.metadata ?? {},
      })
      .returning();
    return data(event);
  });

  app.post("/v1/cases/:id/members", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        user_id: z.string().uuid(),
        role: z.string().default("member"),
      }),
    );
    const [member] = await app.db
      .insert(caseMembers)
      .values({
        orgId: membership.orgId,
        caseId: id,
        userId: body.user_id,
        role: body.role,
      })
      .onConflictDoUpdate({
        target: [caseMembers.caseId, caseMembers.userId],
        set: { role: body.role },
      })
      .returning();
    return data(member);
  });
}
