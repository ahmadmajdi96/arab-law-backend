import type { SupabaseClient } from "@supabase/supabase-js";

export type OrgRole = "owner" | "partner" | "associate" | "paralegal" | "client";

export type AuthContext = {
  userId: string;
  email: string | undefined;
  claims: Record<string, unknown>;
  token: string;
};

export type OrganizationMembership = {
  org_id: string;
  role: OrgRole;
  status?: string;
};

export type RequestSupabase = SupabaseClient;
