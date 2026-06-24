import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { nanoid } from "nanoid";
import { z } from "zod";
import { env } from "../config/env.js";
import { liveSessions, meetings } from "../db/schema.js";
import { getRequestMembership } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { parseBody, parseParams } from "../utils/validation.js";

async function meetingToken(input: {
  room: string;
  userId: string;
  orgId: string;
  role?: string | undefined;
}) {
  return new SignJWT({
    room: input.room,
    org_id: input.orgId,
    role: input.role ?? "participant",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(env.MEETING_TOKEN_SECRET));
}

export async function registerMeetingRoutes(app: FastifyInstance) {
  app.post("/v1/meetings", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        case_id: z.string().uuid().optional(),
        starts_at: z.string().datetime().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const room = `room_${nanoid(18)}`;
    const [meeting] = await app.db
      .insert(meetings)
      .values({
        orgId: membership.orgId,
        caseId: body.case_id,
        room,
        title: body.title,
        startsAt: body.starts_at ? new Date(body.starts_at) : new Date(),
        hostUserId: request.auth!.userId,
        createdBy: request.auth!.userId,
        metadata: body.metadata ?? {},
      })
      .returning();

    return data({
      meeting,
      token: await meetingToken({
        room,
        userId: request.auth!.userId,
        orgId: membership.orgId,
        role: "host",
      }),
    });
  });

  app.post("/v1/meetings/:room/join", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { room } = parseParams(request, z.object({ room: z.string().min(1) }));
    const [meeting] = await app.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.room, room), eq(meetings.orgId, membership.orgId)))
      .limit(1);
    if (!meeting) throw errors.notFound("Meeting not found");

    return data({
      meeting,
      token: await meetingToken({
        room,
        userId: request.auth!.userId,
        orgId: membership.orgId,
      }),
    });
  });

  app.post("/v1/meetings/:id/end", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [meeting] = await app.db
      .update(meetings)
      .set({ status: "ended", endedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(meetings.id, id), eq(meetings.orgId, membership.orgId)))
      .returning();
    if (!meeting) throw errors.notFound("Meeting not found");
    return data(meeting);
  });

  app.post("/v1/live-sessions", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1),
        case_id: z.string().uuid().optional(),
      }),
    );
    const [session] = await app.db
      .insert(liveSessions)
      .values({
        orgId: membership.orgId,
        caseId: body.case_id,
        title: body.title,
        createdBy: request.auth!.userId,
      })
      .returning();
    return data(session);
  });

  app.post("/v1/live-sessions/:id/transcript", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        speaker: z.string().min(1),
        text: z.string().min(1),
        at: z.string().datetime().optional(),
      }),
    );
    const [session] = await app.db
      .select()
      .from(liveSessions)
      .where(and(eq(liveSessions.id, id), eq(liveSessions.orgId, membership.orgId)))
      .limit(1);
    if (!session) throw errors.notFound("Live session not found");

    const transcript = [
      ...(session.transcript ?? []),
      { ...body, at: body.at ?? new Date().toISOString(), user_id: request.auth!.userId },
    ];
    const [updated] = await app.db
      .update(liveSessions)
      .set({ transcript, updatedAt: new Date() })
      .where(eq(liveSessions.id, id))
      .returning();
    return data(updated);
  });
}
