import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { errors } from "./errors.js";

export function unwrap<T>(result: { data: T | null; error: PostgrestError | null }): T {
  if (result.error) {
    throw errors.badRequest(result.error.message, {
      code: result.error.code,
      details: result.error.details,
      hint: result.error.hint,
    });
  }

  if (result.data === null) {
    throw errors.notFound();
  }

  return result.data;
}

export function unwrapNullable<T>(result: {
  data: T | null;
  error: PostgrestError | null;
}): T | null {
  if (result.error) {
    throw errors.badRequest(result.error.message, {
      code: result.error.code,
      details: result.error.details,
      hint: result.error.hint,
    });
  }

  return result.data;
}

export async function getCurrentMembership(supabase: SupabaseClient, userId: string) {
  const membership = unwrapNullable(
    await supabase
      .from("organization_members")
      .select("org_id, role, status")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle(),
  );

  if (!membership) {
    throw errors.forbidden("User is not an active organization member");
  }

  return membership as { org_id: string; role: string; status: string };
}

export async function requireOrgRole(
  supabase: SupabaseClient,
  userId: string,
  roles: readonly string[],
) {
  const membership = await getCurrentMembership(supabase, userId);
  if (!roles.includes(membership.role)) {
    throw errors.forbidden(`Requires one of these organization roles: ${roles.join(", ")}`);
  }

  return membership;
}

export async function insertActivity(
  supabase: SupabaseClient,
  input: {
    org_id: string;
    user_id: string;
    entity_type: string;
    entity_id?: string;
    action: string;
    meta?: Record<string, unknown>;
  },
) {
  const { error } = await supabase.from("activity_log").insert(input);
  if (error) {
    throw errors.badRequest(error.message, error);
  }
}
