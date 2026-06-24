import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: "arab-law-backend",
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async () => {
    const { error } = await app.supabaseAdmin.from("organizations").select("id").limit(1);
    return {
      status: error ? "degraded" : "ready",
      checks: {
        supabase: error ? { ok: false, message: error.message } : { ok: true },
      },
      timestamp: new Date().toISOString(),
    };
  });
}
