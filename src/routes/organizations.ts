import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, insertActivity, requireOrgRole, unwrap } from "../utils/supabase.js";
import { parseBody, parseParams } from "../utils/validation.js";

const createOrganizationSchema = z.object({
  name: z.string().min(2).max(160),
  type: z.enum(["firm", "solo", "corporate"]).default("firm"),
  country: z.string().length(2).default("JO"),
  language: z.enum(["ar", "en"]).default("ar"),
});

const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(160).optional(),
  branding: z.record(z.unknown()).optional(),
  tax: z.record(z.unknown()).optional(),
  prefixes: z.record(z.unknown()).optional(),
  language: z.enum(["ar", "en"]).optional(),
});

export async function registerOrganizationRoutes(app: FastifyInstance) {
  app.get("/v1/org/current", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const organization = unwrap(
      await request
        .supabase!.from("organizations")
        .select("*")
        .eq("id", membership.org_id)
        .single(),
    );

    return {
      data: {
        organization,
        role: membership.role,
      },
    };
  });

  app.post("/v1/orgs", { preHandler: app.requireAuth }, async (request) => {
    const body = parseBody(request, createOrganizationSchema);
    const organization = unwrap(
      await request
        .supabase!.from("organizations")
        .insert({
          ...body,
          created_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );

    await request.supabase!.from("organization_members").insert({
      org_id: (organization as any).id,
      user_id: request.auth!.userId,
      role: "owner",
      status: "active",
    });

    await insertActivity(request.supabase!, {
      org_id: (organization as any).id,
      user_id: request.auth!.userId,
      entity_type: "organization",
      entity_id: (organization as any).id,
      action: "created",
    });

    return { data: organization };
  });

  app.patch("/v1/orgs/:id", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    await requireOrgRole(request.supabase!, request.auth!.userId, ["owner", "partner"]);
    const patch = parseBody(request, updateOrganizationSchema);
    const organization = unwrap(
      await request.supabase!.from("organizations").update(patch).eq("id", id).select("*").single(),
    );

    await insertActivity(request.supabase!, {
      org_id: id,
      user_id: request.auth!.userId,
      entity_type: "organization",
      entity_id: id,
      action: "updated",
      meta: { fields: Object.keys(patch) },
    });

    return { data: organization };
  });
}
