import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, RequestSupabase } from "./domain.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    supabase?: RequestSupabase;
  }

  interface FastifyInstance {
    supabaseAdmin: RequestSupabase;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCron: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
