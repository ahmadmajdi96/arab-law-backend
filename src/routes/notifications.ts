import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notifications } from "../db/schema.js";
import { getRequestMembership } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.get("/v1/notifications", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(
      request,
      z.object({ unread: z.coerce.boolean().optional(), ...paginationSchema }),
    );
    const filters = [
      eq(notifications.orgId, membership.orgId),
      eq(notifications.userId, request.auth!.userId),
    ];
    if (query.unread) filters.push(isNull(notifications.readAt));

    const rows = await app.db
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return data(rows);
  });

  app.post("/v1/notifications/:id/read", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [notification] = await app.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.orgId, membership.orgId),
          eq(notifications.userId, request.auth!.userId),
        ),
      )
      .returning();
    if (!notification) throw errors.notFound("Notification not found");
    return data(notification);
  });

  app.post("/v1/notifications/read-all", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const rows = await app.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.orgId, membership.orgId),
          eq(notifications.userId, request.auth!.userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return data({ updated: rows.length });
  });

  app.post("/v1/notifications", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        user_id: z.string().uuid(),
        title: z.string().min(1),
        body: z.string().min(1),
        kind: z.string().default("info"),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [notification] = await app.db
      .insert(notifications)
      .values({
        orgId: membership.orgId,
        userId: body.user_id,
        title: body.title,
        body: body.body,
        kind: body.kind,
        metadata: body.metadata ?? {},
      })
      .returning();
    return data(notification);
  });
}
