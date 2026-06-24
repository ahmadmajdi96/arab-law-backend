import { eq } from "drizzle-orm";
import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { users } from "../db/schema.js";
import { verifyAccessToken } from "../services/auth.js";
import { errors } from "../utils/errors.js";

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

    let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
    try {
      claims = await verifyAccessToken(token);
    } catch {
      throw errors.unauthorized("Invalid or expired access token");
    }

    const [user] = await app.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);

    if (!user || user.status !== "active") {
      throw errors.unauthorized("User is inactive or no longer exists");
    }

    request.auth = {
      userId: user.id,
      email: user.email,
      claims: { email: claims.email, typ: claims.typ },
      token,
    };
  });

  app.decorate("requireCron", async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (!token || token !== env.CRON_SECRET) {
      throw errors.unauthorized("Invalid cron bearer token");
    }
  });
});
