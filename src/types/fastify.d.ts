import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDb, SqlClient } from "../db/client.js";
import type { StorageService } from "../services/storage.js";
import type { AuthContext } from "./domain.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }

  interface FastifyInstance {
    db: AppDb;
    sql: SqlClient;
    storage: StorageService;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCron: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
