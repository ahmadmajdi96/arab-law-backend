import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organizationInvites, organizationMembers, organizations, users } from "../db/schema.js";
import { getRequestMembership, insertActivity, requireOrgRole } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { parseBody, parseParams } from "../utils/validation.js";

export async function registerTeamRoutes(app: FastifyInstance) {
  app.get("/v1/team", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const members = await app.db
      .select({
        membership: organizationMembers,
        user: {
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          avatarUrl: users.avatarUrl,
          status: users.status,
        },
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, membership.orgId));

    return data(members);
  });

  app.post("/v1/team/invites", { preHandler: app.requireAuth }, async (request) => {
    const { membership, organization } = await requireOrgRole(app.db, request.auth!.userId, [
      "owner",
      "partner",
    ]);
    const body = parseBody(
      request,
      z.object({
        email: z
          .string()
          .email()
          .transform((value) => value.toLowerCase()),
        role: z.enum(["owner", "partner", "associate", "paralegal", "client"]).default("associate"),
      }),
    );

    const token = nanoid(48);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [invite] = await app.db
      .insert(organizationInvites)
      .values({
        orgId: membership.orgId,
        email: body.email,
        role: body.role,
        token,
        invitedBy: request.auth!.userId,
        expiresAt,
      })
      .returning();
    if (!invite) throw errors.unavailable("Unable to create invite");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "organization_invite",
      entityId: invite.id,
      action: "created",
      metadata: { email: body.email, role: body.role },
    });

    return data({
      ...invite,
      organizationName: organization.name,
      inviteUrl: `/accept-invite?token=${token}`,
    });
  });

  app.patch("/v1/team/:id/role", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await requireOrgRole(app.db, request.auth!.userId, ["owner", "partner"]);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        role: z.enum(["owner", "partner", "associate", "paralegal", "client"]),
      }),
    );

    const [updated] = await app.db
      .update(organizationMembers)
      .set({ role: body.role, updatedAt: new Date() })
      .where(eq(organizationMembers.id, id))
      .returning();

    if (!updated || updated.orgId !== membership.orgId)
      throw errors.notFound("Team member not found");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "organization_member",
      entityId: id,
      action: "role_updated",
    });

    return data(updated);
  });

  app.delete("/v1/team/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await requireOrgRole(app.db, request.auth!.userId, ["owner", "partner"]);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [removed] = await app.db
      .delete(organizationMembers)
      .where(eq(organizationMembers.id, id))
      .returning();

    if (!removed || removed.orgId !== membership.orgId)
      throw errors.notFound("Team member not found");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "organization_member",
      entityId: id,
      action: "removed",
    });

    return data(removed);
  });
}
