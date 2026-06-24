import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export function createPostgresClient() {
  return postgres(env.DATABASE_URL, {
    max: env.DB_POOL_SIZE,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
}

export function createDb(client = createPostgresClient()) {
  return drizzle(client, { schema });
}

export type SqlClient = ReturnType<typeof createPostgresClient>;
export type AppDb = ReturnType<typeof createDb>;
