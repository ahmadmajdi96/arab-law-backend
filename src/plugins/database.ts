import fp from "fastify-plugin";
import { createDb, createPostgresClient } from "../db/client.js";

export const databasePlugin = fp(async (app) => {
  const sql = createPostgresClient();
  const db = createDb(sql);

  app.decorate("sql", sql);
  app.decorate("db", db);

  app.addHook("onClose", async () => {
    await sql.end({ timeout: 5 });
  });
});
