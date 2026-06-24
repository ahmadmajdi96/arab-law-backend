import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { organizationInvites, organizationMembers, organizations, users } from "../db/schema.js";
import { hashPassword, signAccessToken, verifyPassword } from "../services/auth.js";
import { getCurrentMembership, insertActivity } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data, toApi } from "../utils/serialize.js";
import { parseBody } from "../utils/validation.js";

const emailSchema = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(10).max(200);

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || `org-${Date.now()}`;
}

async function issueAuthResponse(user: typeof users.$inferSelect) {
  const accessToken = await signAccessToken({ userId: user.id, email: user.email });
  return {
    user: toApi({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      status: user.status,
    }),
    access_token: accessToken,
    token_type: "Bearer",
  };
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/v1/auth/register", async (request) => {
    const body = parseBody(
      request,
      z.object({
        email: emailSchema,
        password: passwordSchema,
        full_name: z.string().min(1).max(160).optional(),
        organization_name: z.string().min(1).max(160).optional(),
      }),
    );

    const [existing] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing) throw errors.conflict("An account with this email already exists");

    const passwordHash = await hashPassword(body.password);
    const [createdUser] = await app.db
      .insert(users)
      .values({
        email: body.email,
        passwordHash,
        fullName: body.full_name,
      })
      .returning();

    if (!createdUser) throw errors.unavailable("Unable to create user");

    const orgName = body.organization_name ?? `${body.full_name ?? body.email}'s Organization`;
    const [organization] = await app.db
      .insert(organizations)
      .values({
        name: orgName,
        slug: `${slugify(orgName)}-${createdUser.id.slice(0, 8)}`,
        createdBy: createdUser.id,
      })
      .returning();

    if (!organization) throw errors.unavailable("Unable to create organization");

    await app.db.insert(organizationMembers).values({
      orgId: organization.id,
      userId: createdUser.id,
      role: "owner",
    });

    await insertActivity(app.db, {
      orgId: organization.id,
      userId: createdUser.id,
      entityType: "organization",
      entityId: organization.id,
      action: "created",
    });

    return { data: await issueAuthResponse(createdUser) };
  });

  app.post("/v1/auth/login", async (request) => {
    const body = parseBody(
      request,
      z.object({
        email: emailSchema,
        password: z.string().min(1).max(200),
      }),
    );

    const [user] = await app.db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user || user.status !== "active") {
      throw errors.unauthorized("Invalid email or password");
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) throw errors.unauthorized("Invalid email or password");

    await app.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

    return { data: await issueAuthResponse(user) };
  });

  app.get("/v1/auth/me", { preHandler: app.requireAuth }, async (request) => {
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, request.auth!.userId))
      .limit(1);
    if (!user) throw errors.unauthorized();

    const memberships = await app.db
      .select({
        membership: organizationMembers,
        organization: organizations,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, user.id));

    return data({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        status: user.status,
      },
      memberships,
    });
  });

  app.post("/v1/auth/refresh", { preHandler: app.requireAuth }, async (request) => {
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, request.auth!.userId))
      .limit(1);
    if (!user) throw errors.unauthorized();
    return { data: await issueAuthResponse(user) };
  });

  app.post("/v1/auth/accept-invite", { preHandler: app.requireAuth }, async (request) => {
    const body = parseBody(request, z.object({ token: z.string().min(24) }));
    const [invite] = await app.db
      .select()
      .from(organizationInvites)
      .where(
        and(eq(organizationInvites.token, body.token), eq(organizationInvites.status, "pending")),
      )
      .limit(1);

    if (!invite || invite.expiresAt.getTime() < Date.now()) {
      throw errors.notFound("Invite not found or expired");
    }

    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, request.auth!.userId))
      .limit(1);
    if (!user) throw errors.unauthorized();
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw errors.forbidden("Invite email does not match authenticated user");
    }

    await app.db
      .insert(organizationMembers)
      .values({
        orgId: invite.orgId,
        userId: user.id,
        role: invite.role,
      })
      .onConflictDoNothing();

    await app.db
      .update(organizationInvites)
      .set({ status: "accepted", acceptedBy: user.id, acceptedAt: new Date() })
      .where(eq(organizationInvites.id, invite.id));

    const membership = await getCurrentMembership(app.db, user.id, invite.orgId);
    return data(membership);
  });
}
