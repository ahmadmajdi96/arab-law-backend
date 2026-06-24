import compress from "@fastify/compress";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { env } from "./config/env.js";
import { authPlugin } from "./plugins/auth.js";
import { observabilityPlugin } from "./plugins/observability.js";
import { supabasePlugin } from "./plugins/supabase.js";
import { registerRoutes } from "./routes/index.js";
import { errorHandler } from "./utils/errors.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "SUPABASE_SERVICE_ROLE_KEY",
        "NOVITA_API_KEY",
      ],
    },
    trustProxy: true,
    requestIdHeader: "x-request-id",
  });

  app.setErrorHandler(errorHandler);

  await app.register(sensible);
  await app.register(helmet, {
    global: true,
  });
  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
  });
  await app.register(compress);
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
    },
  });
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
    routes: ["/api/public/webhooks/payments"],
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "arab.law Backend API",
        version: "1.0.0",
        description:
          "Production API layer for Supabase RLS, legal practice workflows, AI tasks, billing, and observability.",
      },
      servers: [{ url: env.API_PUBLIC_URL ?? "http://localhost:3000" }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Supabase JWT",
          },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(observabilityPlugin);
  await app.register(supabasePlugin);
  await app.register(authPlugin);
  await registerRoutes(app);

  return app;
}
