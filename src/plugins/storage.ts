import fp from "fastify-plugin";
import { StorageService } from "../services/storage.js";

export const storagePlugin = fp(async (app) => {
  app.decorate("storage", new StorageService());
});
