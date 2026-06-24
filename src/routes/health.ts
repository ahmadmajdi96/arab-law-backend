import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: "arab-law-backend",
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async () => {
    const checks = {
      database: { ok: true as boolean, message: undefined as string | undefined },
      storage: { ok: true as boolean, message: undefined as string | undefined },
    };

    try {
      await app.db.execute(sql`select 1`);
    } catch (error) {
      checks.database = {
        ok: false,
        message: error instanceof Error ? error.message : "Database check failed",
      };
    }

    try {
      await app.storage.healthCheck();
    } catch (error) {
      checks.storage = {
        ok: false,
        message: error instanceof Error ? error.message : "Storage check failed",
      };
    }

    const ready = Object.values(checks).every((check) => check.ok);
    return {
      status: ready ? "ready" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    };
  });
}
