import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { nanoid } from "nanoid";
import { z } from "zod";
import { env } from "../config/env.js";
import { getCurrentMembership, unwrap } from "../utils/supabase.js";
import { parseBody, parseParams } from "../utils/validation.js";

async function mintMeetingToken(payload: Record<string, unknown>) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("6h")
    .sign(new TextEncoder().encode(env.MEETING_TOKEN_SECRET));
}

export async function registerMeetingRoutes(app: FastifyInstance) {
  app.post("/v1/meetings", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        title: z.string().min(1).max(200),
        scheduled_at: z.string().datetime(),
        attendees: z.array(z.string().uuid()).default([]),
        case_id: z.string().uuid().optional(),
      }),
    );

    const room = nanoid(24);
    const token = await mintMeetingToken({
      org_id: membership.org_id,
      room,
      host_user_id: request.auth!.userId,
      attendees: body.attendees,
    });

    const meeting = unwrap(
      await request
        .supabase!.from("meetings")
        .insert({
          ...body,
          org_id: membership.org_id,
          room,
          room_token: token,
          created_by: request.auth!.userId,
          status: "scheduled",
        })
        .select("*")
        .single(),
    );

    return { data: { ...(meeting as unknown as Record<string, unknown>), room_token: token } };
  });

  app.post("/v1/meetings/:room/join", { preHandler: app.requireAuth }, async (request) => {
    const { room } = parseParams(request, z.object({ room: z.string().min(8) }));
    const meeting = unwrap(
      await request.supabase!.from("meetings").select("*").eq("room", room).single(),
    ) as any;
    const token = await mintMeetingToken({
      org_id: meeting.org_id,
      room,
      user_id: request.auth!.userId,
    });

    return { data: { meeting, room_token: token } };
  });

  app.post("/v1/meetings/:id/end", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const meeting = unwrap(
      await request
        .supabase!.from("meetings")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .single(),
    );
    return { data: meeting };
  });

  app.post("/v1/live-sessions", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        case_id: z.string().uuid().optional(),
        title: z.string().min(1),
      }),
    );
    const session = unwrap(
      await request
        .supabase!.from("live_sessions")
        .insert({
          ...body,
          org_id: membership.org_id,
          created_by: request.auth!.userId,
          transcript: [],
        })
        .select("*")
        .single(),
    );
    return { data: session };
  });

  app.post("/v1/live-sessions/:id/transcript", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        chunk: z.string().min(1),
        speaker: z.string().optional(),
      }),
    );
    const session = unwrap(
      await request.supabase!.from("live_sessions").select("*").eq("id", id).single(),
    ) as any;
    const transcript = Array.isArray(session.transcript) ? session.transcript : [];
    const updated = unwrap(
      await request
        .supabase!.from("live_sessions")
        .update({
          transcript: [
            ...transcript,
            { ...body, at: new Date().toISOString(), user_id: request.auth!.userId },
          ],
        })
        .eq("id", id)
        .select("*")
        .single(),
    );
    return { data: updated };
  });
}
