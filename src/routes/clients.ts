import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clientInteractions, clients } from "../db/schema.js";
import { getRequestMembership, insertActivity } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const clientBody = z.object({
  name: z.string().min(1).max(240),
  type: z.string().default("individual"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  national_id: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  owner_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function registerClientRoutes(app: FastifyInstance) {
  app.get("/v1/clients", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(
      request,
      z.object({
        q: z.string().optional(),
        ...paginationSchema,
      }),
    );

    const filters = [eq(clients.orgId, membership.orgId)];
    if (query.q) {
      filters.push(or(ilike(clients.name, `%${query.q}%`), ilike(clients.email, `%${query.q}%`))!);
    }

    const rows = await app.db
      .select()
      .from(clients)
      .where(and(...filters))
      .orderBy(desc(clients.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    return data(rows);
  });

  app.get("/v1/clients/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [client] = await app.db
      .select()
      .from(clients)
      .where(and(eq(clients.id, id), eq(clients.orgId, membership.orgId)))
      .limit(1);
    if (!client) throw errors.notFound("Client not found");
    return data(client);
  });

  app.post("/v1/clients", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(request, clientBody);
    const [client] = await app.db
      .insert(clients)
      .values({
        orgId: membership.orgId,
        ownerId: body.owner_id ?? request.auth!.userId,
        name: body.name,
        type: body.type,
        email: body.email,
        phone: body.phone,
        nationalId: body.national_id,
        address: body.address,
        notes: body.notes,
        metadata: body.metadata ?? {},
      })
      .returning();
    if (!client) throw errors.unavailable("Unable to create client");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "client",
      entityId: client.id,
      action: "created",
    });

    return data(client);
  });

  app.patch("/v1/clients/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(request, clientBody.partial());
    const [client] = await app.db
      .update(clients)
      .set({
        name: body.name,
        type: body.type,
        email: body.email,
        phone: body.phone,
        nationalId: body.national_id,
        address: body.address,
        notes: body.notes,
        ownerId: body.owner_id,
        metadata: body.metadata,
        updatedAt: new Date(),
      })
      .where(and(eq(clients.id, id), eq(clients.orgId, membership.orgId)))
      .returning();
    if (!client) throw errors.notFound("Client not found");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "client",
      entityId: id,
      action: "updated",
    });

    return data(client);
  });

  app.delete("/v1/clients/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [client] = await app.db
      .delete(clients)
      .where(and(eq(clients.id, id), eq(clients.orgId, membership.orgId)))
      .returning();
    if (!client) throw errors.notFound("Client not found");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "client",
      entityId: id,
      action: "deleted",
    });

    return data(client);
  });

  app.post("/v1/clients/:id/interactions", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        channel: z.string().default("note"),
        summary: z.string().min(1),
        occurred_at: z.string().datetime().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );

    const [interaction] = await app.db
      .insert(clientInteractions)
      .values({
        orgId: membership.orgId,
        clientId: id,
        userId: request.auth!.userId,
        channel: body.channel,
        summary: body.summary,
        occurredAt: body.occurred_at ? new Date(body.occurred_at) : new Date(),
        metadata: body.metadata ?? {},
      })
      .returning();
    if (!interaction) throw errors.unavailable("Unable to create interaction");
    return data(interaction);
  });
}
