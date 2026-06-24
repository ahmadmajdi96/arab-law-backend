import fp from "fastify-plugin";
import { jwtVerify } from "jose";
import { env } from "../config/env.js";
import { errors } from "../utils/errors.js";
import { createUserSupabase } from "./supabase.js";

function bearerToken(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

export const authPlugin = fp(async (app) => {
  app.decorate("requireAuth", async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw errors.unauthorized();
    }

    const userSupabase = createUserSupabase(token);
    let userId: string | undefined;
    let email: string | undefined;
    let claims: Record<string, unknown> = {};

    if (env.SUPABASE_JWT_SECRET) {
      try {
        const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
        const verified = await jwtVerify(token, secret);
        claims = verified.payload as Record<string, unknown>;
        userId = verified.payload.sub;
        email = typeof verified.payload.email === "string" ? verified.payload.email : undefined;
      } catch (error) {
        request.log.warn({ err: error }, "Local JWT verification failed; falling back to Supabase");
      }
    }

    if (!userId) {
      const { data, error } = await userSupabase.auth.getUser(token);
      if (error || !data.user) {
        throw errors.unauthorized("Invalid or expired Supabase token");
      }
      userId = data.user.id;
      email = data.user.email;
      claims = {
        aud: data.user.aud,
        role: data.user.role,
        email: data.user.email,
        app_metadata: data.user.app_metadata,
        user_metadata: data.user.user_metadata,
      };
    }

    request.auth = { userId, email, claims, token };
    request.supabase = userSupabase;
  });

  app.decorate("requireCron", async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (!token || token !== env.CRON_SECRET) {
      throw errors.unauthorized("Invalid cron bearer token");
    }
  });
});
