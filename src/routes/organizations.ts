import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { organizationMembers, organizations } from "../db/schema.js";
import {
  getCurrentMembership,
  insertActivity,
  requestedOrgId,
  requireOrgRole,
} from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { parseBody, parseParams } from "../utils/validation.js";

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || `org-${Date.now()}`;
}

export async function registerOrganizationRoutes(app: FastifyInstance) {
  app.get("/v1/org/current", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(
      app.db,
      request.auth!.userId,
      requestedOrgId(request),
    );
    return data(membership);
  });

  app.post("/v1/orgs", { preHandler: app.requireAuth }, async (request) => {
    const body = parseBody(
      request,
      z.object({
        name: z.string().min(1).max(160),
        locale: z.string().default("ar-JO"),
        timezone: z.string().default("Asia/Amman"),
      }),
    );

    const [organization] = await app.db
      .insert(organizations)
      .values({
        ...body,
        slug: `${slugify(body.name)}-${Date.now().toString(36)}`,
        createdBy: request.auth!.userId,
      })
      .returning();
    if (!organization) throw errors.unavailable("Unable to create organization");

    await app.db.insert(organizationMembers).values({
      orgId: organization.id,
      userId: request.auth!.userId,
      role: "owner",
    });

    await insertActivity(app.db, {
      orgId: organization.id,
      userId: request.auth!.userId,
      entityType: "organization",
      entityId: organization.id,
      action: "created",
    });

    return data(organization);
  });

  app.patch("/v1/orgs/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    await requireOrgRole(app.db, request.auth!.userId, ["owner", "partner"], id);
    const patch = parseBody(
      request,
      z.object({
        name: z.string().min(1).max(160).optional(),
        locale: z.string().optional(),
        timezone: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );

    const [organization] = await app.db
      .update(organizations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(organizations.id, id))
      .returning();
    if (!organization) throw errors.notFound("Organization not found");

    await insertActivity(app.db, {
      orgId: id,
      userId: request.auth!.userId,
      entityType: "organization",
      entityId: id,
      action: "updated",
    });

    return data(organization);
  });
}
