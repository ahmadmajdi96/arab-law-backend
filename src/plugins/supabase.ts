import { createClient } from "@supabase/supabase-js";
import fp from "fastify-plugin";
import { env } from "../config/env.js";

export const supabasePlugin = fp(async (app) => {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        "X-Client-Info": "arab-law-backend/admin",
      },
    },
  });

  app.decorate("supabaseAdmin", supabaseAdmin);
});

export function createUserSupabase(accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Client-Info": "arab-law-backend/user",
      },
    },
  });
}
