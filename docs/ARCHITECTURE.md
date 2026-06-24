# Architecture

This backend is a production-owned service stack for a legal practice application. It replaces hosted application-backend dependencies with a containerized architecture that can be moved between a laptop, a VPS, or a managed Kubernetes platform without changing application code.

## Goals

- Own the auth, data, files, AI gateway, job processing, and monitoring layers.
- Keep the API stateless so it can scale horizontally.
- Keep all tenant isolation explicit through organization membership checks.
- Use durable infrastructure for state: PostgreSQL for relational data, Redis for queues, and S3-compatible object storage for files.
- Make every service observable through metrics, logs, traces, and health checks.
- Keep local development and production topology close by using Docker Compose.

## Request Flow

1. Browser or frontend sends a request to Traefik on port `5556`.
2. Traefik load-balances to one healthy `api` container on port `3000`.
3. Fastify runs security headers, CORS, rate limiting, auth, validation, business logic, and metrics hooks.
4. Authenticated routes verify the first-party JWT and load the current organization membership.
5. Route handlers use Drizzle ORM against PostgreSQL and storage service methods against S3/MinIO.
6. Long or periodic work is queued through BullMQ into Redis and processed by worker containers.
7. Prometheus scrapes API metrics, exporters, Traefik, cAdvisor, node-exporter, and blackbox probes.
8. OpenTelemetry exports traces to Tempo; container logs are shipped by Promtail to Loki; Grafana reads all three.

## Runtime Components

| Component | Image/Runtime | Purpose | State |
| --- | --- | --- | --- |
| `api` | Node 24 Alpine runtime image | Fastify HTTP API, auth, CRUD, document URLs, AI gateway, metrics | Stateless |
| `worker` | Same app image, `node dist/src/worker.js` | BullMQ processors for billing and notifications | Stateless |
| `postgres` | `postgres:17-alpine` | Primary relational database | `postgres-data` volume |
| `redis` | `redis:7.4-alpine` | BullMQ queues and async job coordination | `redis-data` volume |
| `minio` | MinIO server | Local S3-compatible object storage | `minio-data` volume |
| `minio-init` | MinIO client | Creates the configured bucket and makes it private | One-shot |
| `traefik` | `traefik:v3.2.0` | Reverse proxy, load balancing, access logs, router metrics | Stateless |
| `prometheus` | Prometheus | Metrics storage and query API | `prometheus-data` volume |
| `grafana` | Grafana | Dashboards for API, infra, AI, tokens, logs, traces | `grafana-data` volume |
| `loki` | Loki | Log aggregation | `loki-data` volume |
| `promtail` | Promtail | Docker log shipping to Loki | Stateless |
| `tempo` | Tempo | Distributed trace storage | `tempo-data` volume |
| `otel-collector` | OpenTelemetry Collector | Receives OTLP traces/metrics and forwards to Tempo/Prometheus pipeline | Stateless |
| `cadvisor` | cAdvisor | Container CPU, memory, filesystem, and network metrics | Stateless |
| `node-exporter` | Node exporter | Host/system metrics | Stateless |
| `redis-exporter` | Redis exporter | Redis metrics | Stateless |
| `postgres-exporter` | Postgres exporter `v0.19.1` | PostgreSQL metrics, compatible with PostgreSQL 17 | Stateless |
| `blackbox` | Blackbox exporter | Probes backend and frontend URLs | Stateless |
| `test-runner` | App `deps` image | Repeatable lint/type/test/build/load checks in Compose | Ephemeral |
| `migrate` | App `deps` image | Drizzle migration command in Compose profile | Ephemeral |

## Code Layout

| Path | Responsibility |
| --- | --- |
| `src/app.ts` | Builds the Fastify app, registers plugins, Swagger, routes, and error handling. |
| `src/main.ts` | Starts the HTTP server. |
| `src/worker.ts` | Starts BullMQ workers and graceful shutdown hooks. |
| `src/config/env.ts` | Validates all runtime environment variables with Zod. |
| `src/db/schema.ts` | Drizzle schema for all PostgreSQL tables, indexes, and foreign keys. |
| `src/db/client.ts` | Creates the PostgreSQL client and Drizzle database object. |
| `src/plugins/auth.ts` | Fastify auth and cron bearer pre-handlers. |
| `src/plugins/database.ts` | Fastify database decoration and connection shutdown. |
| `src/plugins/storage.ts` | Fastify S3 storage service decoration. |
| `src/plugins/observability.ts` | HTTP metrics hooks and `/metrics`. |
| `src/routes/*.ts` | Route modules by product area. |
| `src/services/auth.ts` | Password hashing, password verification, JWT signing, JWT verification. |
| `src/services/storage.ts` | S3 client, signed upload/download URLs, bucket health check, deletion. |
| `src/services/ai-gateway.ts` | Novita calls, token estimation, budget enforcement, usage persistence, metrics. |
| `src/services/metrics.ts` | Prometheus registry and custom metric definitions. |
| `src/queues/index.ts` | BullMQ queues and Redis connection parsing. |
| `src/utils/db.ts` | Organization membership checks, activity logging, invoice numbering, overdue invoice sweep. |
| `src/utils/errors.ts` | Typed application errors and uniform JSON error responses. |
| `src/utils/validation.ts` | Request body, query, param parsing and pagination defaults. |

## Data Model

All IDs are UUIDs. Timestamps are PostgreSQL `timestamp with time zone`. JSON metadata fields are `jsonb` and default to `{}`. The schema enables `pgcrypto` for UUID generation.

| Table | Purpose | Important relationships and indexes |
| --- | --- | --- |
| `users` | First-party user accounts with email, scrypt password hash, profile fields, status, login timestamp. | Unique lowercased email index. |
| `organizations` | Tenant/workspace records with name, slug, locale, timezone, creator, metadata. | `created_by` references `users`. |
| `organization_members` | User memberships inside organizations. | Unique `(org_id, user_id)`, indexes on `org_id` and `user_id`. |
| `organization_invites` | Pending/accepted team invitations. | Token unique, indexes on `org_id` and email. |
| `activity_log` | Audit/activity events for organization actions. | Indexed by `(org_id, created_at)`. |
| `clients` | Client/contact records for the law practice. | Indexes on `org_id` and `(org_id, name)`. |
| `client_interactions` | Notes/calls/emails against clients. | Indexed by `(client_id, occurred_at)`. |
| `cases` | Legal matter files. | Indexes on `org_id`, `(org_id, status)`, and `client_id`. |
| `case_members` | Users assigned to cases. | Unique `(case_id, user_id)`. |
| `case_parties` | Opposing parties, witnesses, plaintiffs, defendants, and related contacts. | References `cases` and `organizations`. |
| `case_notes` | Internal notes for a case. | References `cases`, `organizations`, and optional user. |
| `case_events` | Case-specific sessions/hearings/events. | References `cases` and `organizations`. |
| `documents` | File metadata and storage path records. | Indexes on `org_id`, `case_id`, `client_id`; object bytes live in S3/MinIO. |
| `document_versions` | Version history for documents. | References document, org, and creator. |
| `document_shares` | Public share tokens for documents. | Token unique, references document/org/creator. |
| `appointments` | Calendar appointments. | References org, optional case/client/owner/creator. |
| `deadlines` | Legal deadlines with due date, priority, assignee, completion timestamp. | References org, optional case/assignee. |
| `notifications` | In-app/user notifications and delivery status. | References org and user. |
| `time_entries` | Billable/non-billable time tracking. | References org, user, optional case/client/invoice. |
| `document_counters` | Atomic quote/invoice number counters per organization/year/kind. | Primary key `(org_id, kind, year)`. |
| `quotes` | Quote records with generated number, amount, currency, JSON items. | References org, optional client, creator. |
| `tax_invoices` | Invoice records with number, status, amount, due date, paid amount. | References org, optional client/quote/case/creator. |
| `payments` | Manual or webhook payment records. | References org, invoice, optional recorder. |
| `drafts` | Draft legal documents and generated AI drafts. | References org, optional case, creator. |
| `meetings` | Meeting rooms with room ID, status, start/end timestamps, host. | References org, optional case, host/creator. |
| `live_sessions` | Live note/transcript sessions. | References org, optional case, creator. |
| `courtroom_simulations` | AI simulation sessions and transcript JSON. | References org, case, user. |
| `ai_usage_events` | Persistent AI request accounting. | Indexes on `(org_id, created_at)` and `feature`. |
| `ai_token_budgets` | Optional monthly token caps per organization. | One row per org. |

## Authentication

- Registration creates a user, creates an organization, and inserts an owner membership.
- Passwords use Node `crypto.scrypt` with:
  - key length `64`
  - salt length `16`
  - cost `16384`
  - block size `8`
  - parallelization `1`
- Access tokens are HS256 JWTs signed with `JWT_SECRET`.
- JWT claims include:
  - `sub`: user ID
  - `email`: account email
  - `typ`: `access`
  - configured issuer and audience
  - issued-at and expiration
- `ACCESS_TOKEN_TTL_SECONDS` defaults to `3600`.
- Protected routes require `Authorization: Bearer <access_token>`.
- Organization context is selected with `x-org-id`. If omitted, the first active membership is used.
- Admin-style organization/team mutations require roles:
  - organization update: `owner` or `partner`
  - team invites, role changes, member removal: `owner` or `partner`

## Authorization Boundary

Every tenant-scoped route calls `getRequestMembership()` or `requireOrgRole()` before reading or mutating tenant data. Queries include `org_id` filters so one organization cannot access another organization's clients, cases, documents, appointments, billing records, notifications, drafts, meetings, AI usage, or activity.

## Storage

- File bytes live outside PostgreSQL in S3-compatible storage.
- Local Docker uses MinIO with a private `documents` bucket.
- Upload flow:
  1. Frontend calls `POST /v1/documents/upload-url`.
  2. Backend returns a storage path and short-lived signed `PUT` URL.
  3. Frontend uploads bytes directly to S3/MinIO.
  4. Frontend calls `POST /v1/documents` with file metadata and `storage_path`.
- Download flow:
  - Authenticated users call `POST /v1/documents/:id/signed-url`.
  - Public shares redirect from `/share/:token` to a short-lived signed S3 URL.
- Delete flow:
  - `DELETE /v1/documents/:id` deletes metadata and calls S3 `DeleteObject`.

## AI Gateway

All AI functionality is connected to Novita AI through the OpenAI-compatible chat completions endpoint.

- Base URL: `NOVITA_AI_BASE_URL`, default `https://api.novita.ai/openai`.
- Chat URL normalization:
  - base ending in `/v1` uses `/chat/completions`
  - base not ending in `/v1` uses `/v1/chat/completions`
- Default model: `AI_DEFAULT_MODEL`, default `deepseek/deepseek-r1`.
- API key: `NOVITA_API_KEY`.
- Features recorded in metrics and usage table include:
  - `legal_research.jordan`
  - `case.summarize`
  - `case.next_steps`
  - `document.extract_text`
  - `courtroom.simulate_turn`
  - `draft.generate`
  - `monitoring.novita_smoke`
- Usage is recorded in `ai_usage_events` with org, user, feature, model, prompt tokens, completion tokens, total tokens, latency, status, and metadata.
- Monthly token budgets are enforced when `AI_TOKEN_BUDGET_ENFORCEMENT=true` and an org has a row in `ai_token_budgets` with `hard_limit_enabled=true`.
- If the provider does not return usage, the backend estimates tokens as roughly `ceil(text.length / 4)`.

## Queues And Workers

Queues are managed by BullMQ over Redis.

| Queue | Current jobs | Concurrency |
| --- | --- | ---: |
| `billing` | `overdue-sweep` marks sent invoices overdue when due date passes. | 20 |
| `notifications` | `send-due-reminders` sends pending notifications to optional webhook and marks them sent. | 20 |
| `ai` | Reserved for AI background workloads; worker limiter is configured when the AI worker is added. | 5, limiter 60/min |

Queue defaults:

- attempts: `5`
- backoff: exponential, `5000ms`
- remove completed jobs: keep latest `1000`
- remove failed jobs: keep latest `5000`
- `QUEUE_ENABLED=false` makes enqueue calls return `{ queued: false, reason: "Queue disabled" }`.

## Observability

Metrics endpoint: `/metrics`.

Custom metrics:

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `arab_law_http_requests_total` | Counter | `method`, `route`, `status_code` | Count of HTTP responses. |
| `arab_law_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Request latency. |
| `arab_law_http_active_requests` | Gauge | none | In-flight HTTP requests per API process. |
| `arab_law_ai_requests_total` | Counter | `feature`, `model`, `status` | AI request count. |
| `arab_law_ai_tokens_total` | Counter | `feature`, `model`, `direction` | AI prompt/completion tokens. |
| `arab_law_ai_request_duration_seconds` | Histogram | `feature`, `model`, `status` | AI request latency. |
| `arab_law_jobs_total` | Counter | `queue`, `name`, `status` | Completed/failed worker jobs. |

Default Node/process metrics are collected through `prom-client` with the `arab_law_` prefix.

Prometheus scrape jobs:

- `api`
- `traefik`
- `redis`
- `postgres`
- `otel-collector`
- `cadvisor`
- `node`
- `backend-probes`
- `frontend-probes`

Grafana is provisioned with Prometheus, Loki, and Tempo data sources and the arab.law overview dashboard.

## Health Checks

- `/health` returns liveness only and does not check dependencies.
- `/ready` checks PostgreSQL with `select 1` and S3/MinIO with `HeadBucket`.
- Docker API healthcheck calls `/health`.
- Prometheus blackbox probes call `/health` and `/ready`.

## Scaling Model

- API containers are stateless and can scale horizontally with `docker compose up --scale api=N`.
- Worker containers scale independently with `--scale worker=N`.
- PostgreSQL, Redis, and object storage are the stateful bottlenecks and should move to managed or clustered services for large production deployments.
- AI throughput is usually limited by Novita RPM/TPM, model latency, and token budgets, not Fastify CPU.
- `/metrics` should be scraped at monitoring cadence, not user-traffic cadence.

## Security Model

- Secrets are read from environment variables and are not committed.
- CORS is configurable through `CORS_ORIGINS`; development default is `*`.
- Helmet adds browser/security headers.
- Rate limiting defaults to `600` requests per `1 minute` per Fastify rate-limit identity.
- Payment webhooks require HMAC SHA-256 signature verification against `PAYMENT_WEBHOOK_SECRET`.
- Cron endpoints require `Authorization: Bearer <CRON_SECRET>`.
- Public document shares use high-entropy Nano ID tokens and expire at `expires_at`.
- S3 URLs are short lived and generated server side.

## Migration Strategy

- Drizzle schema is the source of truth in `src/db/schema.ts`.
- Generated SQL migrations live in `drizzle/`.
- Local first boot mounts `./drizzle` into the PostgreSQL init directory so a fresh volume creates the schema.
- Existing databases should run migrations through:

```bash
npm run db:migrate
docker compose --profile migrate run --rm migrate
```

## Production Boundaries

This repository is ready for a production-owned deployment, but large deployments should use managed or dedicated services for state:

- Managed PostgreSQL with PITR, read replicas if needed, and connection pooling.
- Managed Redis or Redis Sentinel/Cluster for queues.
- Object storage with lifecycle rules, backups/versioning, and CDN if documents are downloaded often.
- TLS termination and WAF/rate policies before Traefik.
- Secret manager rather than `.env` files.
- Separate staging environment for load tests against realistic data volume.
