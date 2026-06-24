import fp from "fastify-plugin";
import {
  httpActiveRequests,
  httpRequestDuration,
  httpRequestsTotal,
  registry,
} from "../services/metrics.js";

export const observabilityPlugin = fp(async (app) => {
  app.addHook("onRequest", async () => {
    httpActiveRequests.inc();
  });

  app.addHook("onResponse", async (request, reply) => {
    httpActiveRequests.dec();
    const route = request.routeOptions.url ?? request.url;
    const labels = {
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
});
