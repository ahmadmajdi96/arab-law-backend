import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === "boolean") return value;
    if (value === undefined || value === "") return undefined;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

const numberFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().optional().default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: numberFromEnv(3000),
  LOG_LEVEL: z.string().default("info"),
  API_PUBLIC_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default("*"),
  DATABASE_URL: z.string().url(),
  DB_POOL_SIZE: numberFromEnv(20),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default("arab-law-backend"),
  JWT_AUDIENCE: z.string().default("arab-law-frontend"),
  ACCESS_TOKEN_TTL_SECONDS: numberFromEnv(3600),
  NOVITA_API_KEY: z.string().min(1).optional().or(z.literal("")),
  NOVITA_AI_BASE_URL: z.string().url().default("https://api.novita.ai/openai"),
  AI_DEFAULT_MODEL: z.string().default("deepseek/deepseek-r1"),
  AI_TOKEN_BUDGET_ENFORCEMENT: booleanFromEnv.default(true),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1).default("documents"),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default(true),
  S3_PUBLIC_BASE_URL: z.string().url().optional().or(z.literal("")),
  ELEVENLABS_API_KEY: z.string().min(1).optional().or(z.literal("")),
  ELEVENLABS_SCRIBE_TOKEN_URL: z
    .string()
    .url()
    .default("https://api.elevenlabs.io/v1/scribe/token"),
  MEETING_TOKEN_SECRET: z.string().min(24),
  CRON_SECRET: z.string().min(16),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  RATE_LIMIT_MAX: numberFromEnv(600),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  REDIS_URL: z.string().default("redis://redis:6379"),
  QUEUE_ENABLED: booleanFromEnv.default(true),
  NOTIFICATION_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  OTEL_ENABLED: booleanFromEnv.default(true),
  OTEL_SERVICE_NAME: z.string().default("arab-law-api"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default("http://otel-collector:4318"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${message}`);
}

export const env = {
  ...parsed.data,
  corsOrigins:
    parsed.data.CORS_ORIGINS === "*"
      ? true
      : parsed.data.CORS_ORIGINS.split(",").map((origin) => origin.trim()),
};

export type Env = typeof env;
