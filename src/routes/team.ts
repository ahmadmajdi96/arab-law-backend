import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, insertActivity, requireOrgRole, unwrap } from "../utils/supabase.js";
import { parseBody, parseParams } from "../utils/validation.js";

const roleSchema = z.enum(["partner", "associate", "paralegal", "client"]);

export async function registerTeamRoutes(app: FastifyInstance) {
  app.get("/v1/team", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const members = unwrap(
      await request
        .supabase!.from("organization_members")
        .select("*, profiles(full_name, avatar_url)")
        .eq("org_id", membership.org_id)
        .order("created_at", { ascending: false }),
    );

    return { data: members };
  });

  app.post("/v1/team/invites", { preHandler: app.requireAuth }, async (request) => {
    const membership = await requireOrgRole(request.supabase!, request.auth!.userId, [
      "owner",
      "partner",
    ]);
    const body = parseBody(
      request,
      z.object({
        email: z.string().email(),
        role: roleSchema,
      }),
    );

    const invite = await app.supabaseAdmin.auth.admin.inviteUserByEmail(body.email, {
      data: {
        org_id: membership.org_id,
        role: body.role,
      },
    });

    if (invite.error) throw invite.error;

    const row = unwrap(
      await request
        .supabase!.from("organization_members")
        .insert({
          org_id: membership.org_id,
          invited_email: body.email,
          user_id: invite.data.user?.id,
          role: body.role,
          status: "invited",
        })
        .select("*")
        .single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "team_member",
      entity_id: (row as any).id,
      action: "invited",
      meta: { email: body.email, role: body.role },
    });

    return { data: row };
  });

  app.patch("/v1/team/:id/role", { preHandler: app.requireAuth }, async (request) => {
    const membership = await requireOrgRole(request.supabase!, request.auth!.userId, [
      "owner",
      "partner",
    ]);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(request, z.object({ role: roleSchema }));
    const member = unwrap(
      await request
        .supabase!.from("organization_members")
        .update({ role: body.role })
        .eq("id", id)
        .eq("org_id", membership.org_id)
        .select("*")
        .single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "team_member",
      entity_id: id,
      action: "role_updated",
      meta: { role: body.role },
    });

    return { data: member };
  });

  app.delete("/v1/team/:id", { preHandler: app.requireAuth }, async (request) => {
    const membership = await requireOrgRole(request.supabase!, request.auth!.userId, [
      "owner",
      "partner",
    ]);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const member = unwrap(
      await request
        .supabase!.from("organization_members")
        .delete()
        .eq("id", id)
        .eq("org_id", membership.org_id)
        .select("*")
        .single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "team_member",
      entity_id: id,
      action: "removed",
    });

    return { data: member };
  });
}
