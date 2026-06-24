# Operations Runbook

This runbook explains how to configure, run, monitor, test, and scale the backend.

## Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Runtime mode: `development`, `test`, or `production`. |
| `HOST` | No | `0.0.0.0` | Fastify bind host. |
| `PORT` | No | `3000` | Fastify bind port inside the container. |
| `LOG_LEVEL` | No | `info` | Pino log level. |
| `API_PUBLIC_URL` | No | none | Public API URL used by clients/docs where needed. |
| `FRONTEND_URL` | No | none | Frontend URL used by monitoring probes and integrations. |
| `CORS_ORIGINS` | No | `*` | `*` or comma-separated origins. Development is intentionally open. |
| `DATABASE_URL` | Yes | Compose default | PostgreSQL connection string used by API, worker, and migrations. |
| `DB_POOL_SIZE` | No | `20` | PostgreSQL max connections per API/worker process. |
| `POSTGRES_DB` | Compose | `arab_law` | Local PostgreSQL database name. |
| `POSTGRES_USER` | Compose | `arab_law` | Local PostgreSQL username. |
| `POSTGRES_PASSWORD` | Compose | `arab_law_password` | Local PostgreSQL password. Rotate for production. |
| `JWT_SECRET` | Yes | Compose dev fallback | HS256 access-token signing secret. Minimum 32 chars. |
| `JWT_ISSUER` | No | `arab-law-backend` | Expected JWT issuer. |
| `JWT_AUDIENCE` | No | `arab-law-frontend` | Expected JWT audience. |
| `ACCESS_TOKEN_TTL_SECONDS` | No | `3600` | Access-token lifetime. |
| `S3_ENDPOINT` | Yes | `http://minio:9000` | S3-compatible endpoint. |
| `S3_REGION` | No | `us-east-1` | S3 region. |
| `S3_ACCESS_KEY_ID` | Yes | Compose dev fallback | S3 access key. |
| `S3_SECRET_ACCESS_KEY` | Yes | Compose dev fallback | S3 secret key. |
| `S3_BUCKET` | No | `documents` | Bucket used for all document objects. |
| `S3_FORCE_PATH_STYLE` | No | `true` | Required for MinIO; may be `false` for AWS S3. |
| `S3_PUBLIC_BASE_URL` | No | empty | Reserved for future CDN/public URL use. |
| `NOVITA_API_KEY` | AI routes | none | Novita AI API key. |
| `NOVITA_AI_BASE_URL` | No | `https://api.novita.ai/openai` | OpenAI-compatible Novita base. |
| `AI_DEFAULT_MODEL` | No | `deepseek/deepseek-r1` | Default model for AI endpoints. |
| `AI_TOKEN_BUDGET_ENFORCEMENT` | No | `true` | Enforce `ai_token_budgets` hard monthly limits. |
| `ELEVENLABS_API_KEY` | Scribe token route | none | ElevenLabs key for `/api/elevenlabs/scribe-token`. |
| `ELEVENLABS_SCRIBE_TOKEN_URL` | No | ElevenLabs default | Token minting endpoint. |
| `MEETING_TOKEN_SECRET` | Yes | none | HS256 secret for meeting-room JWTs. Minimum 24 chars. |
| `CRON_SECRET` | Yes | none | Bearer token for cron/monitoring operational endpoints. |
| `PAYMENT_WEBHOOK_SECRET` | Yes | none | HMAC secret for payment webhook signature verification. |
| `RATE_LIMIT_MAX` | No | `600` | Request count allowed in the Fastify rate window. |
| `RATE_LIMIT_WINDOW` | No | `1 minute` | Rate-limit window string. |
| `REDIS_URL` | No | `redis://redis:6379` | Redis connection for BullMQ. |
| `QUEUE_ENABLED` | No | `true` | Allows disabling queue writes in tests/benchmarks. |
| `NOTIFICATION_WEBHOOK_URL` | No | empty | Optional webhook used by notification worker. |
| `OTEL_ENABLED` | No | `true` | Enables OpenTelemetry SDK. |
| `OTEL_SERVICE_NAME` | No | `arab-law-api` | Service name in traces. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://otel-collector:4318` | OTLP HTTP endpoint. |
| `GRAFANA_ADMIN_USER` | Compose | `admin` | Grafana local admin username. |
| `GRAFANA_ADMIN_PASSWORD` | Compose | `admin` | Grafana local admin password. Rotate for production. |

## Local Development

```bash
cp .env.example .env
npm install
npm run dev
```

Worker development:

```bash
npm run dev:worker
```

Generate a migration after changing `src/db/schema.ts`:

```bash
npm run db:generate
```

Run migrations against an existing database:

```bash
npm run db:migrate
```

## Docker Startup

Start the full stack with two API replicas and two workers:

```bash
docker compose up -d --build --scale api=2 --scale worker=2
```

Check state:

```bash
docker compose ps
curl http://localhost:5556/health
curl http://localhost:5556/ready
curl http://localhost:5559/api/health
```

Stop the stack:

```bash
docker compose down --remove-orphans
```

Stop and remove data volumes only when intentionally destroying local state:

```bash
docker compose down --remove-orphans --volumes
```

## Ports

All exposed host ports are in the requested `5556-5570` range.

| Port | Service |
| ---: | --- |
| `5556` | Traefik API entrypoint |
| `5557` | Traefik dashboard |
| `5558` | Prometheus |
| `5559` | Grafana |
| `5560` | Loki |
| `5561` | Tempo HTTP |
| `5562` | Tempo OTLP gRPC |
| `5563` | OpenTelemetry OTLP HTTP |
| `5564` | OpenTelemetry Collector metrics |
| `5565` | cAdvisor |
| `5566` | Blackbox exporter |
| `5567` | PostgreSQL |
| `5568` | MinIO S3 API |
| `5569` | MinIO console |

## Testing

Run local checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm audit --audit-level=moderate
```

Run the full integration suite locally when Postgres/Redis/MinIO are reachable through env vars:

```bash
RUN_INTEGRATION=1 npm run test
```

Run all checks through Docker Compose:

```bash
docker compose config --quiet
docker compose run --rm test-runner npm ci
docker compose run --rm -e RUN_INTEGRATION=1 test-runner npm run test
docker compose run --rm test-runner npm run typecheck
docker compose run --rm test-runner npm run lint
docker compose run --rm test-runner npm run build
docker compose run --rm test-runner npm run benchmark
docker compose run --rm test-runner npm run stress
```

The integration suite covers:

- register, login, me
- clients and interactions
- cases, parties, notes, sessions, members
- document upload URL, metadata, signed URL, versions, public share redirect
- appointments and deadlines
- notifications
- time entries
- quotes, invoices, payments
- drafts
- meetings and live sessions
- dashboard, analytics, AI usage endpoint

## Real Novita Smoke Test

This endpoint spends a tiny number of Novita tokens and should be called intentionally.

```bash
curl -X POST http://localhost:5556/api/public/monitoring/novita-smoke \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  --data '{
    "model": "meta-llama/llama-3.1-8b-instruct",
    "prompt": "Reply with exactly: arab.law monitoring ok",
    "max_tokens": 16
  }'
```

Verify Prometheus saw the sample:

```bash
curl 'http://localhost:5558/api/v1/query?query=sum(arab_law_ai_requests_total)'
curl 'http://localhost:5558/api/v1/query?query=sum(arab_law_ai_tokens_total)'
```

## Monitoring Access

- Grafana: `http://localhost:5559`
- Default local credentials: `admin` / `admin`
- Dashboard: arab-law production overview
- Prometheus targets: `http://localhost:5558/targets`
- Traefik dashboard: `http://localhost:5557`
- MinIO console: `http://localhost:5569`

Prometheus target expectations:

- `api`: up for every API replica
- `backend-probes`: up for `/health` and `/ready`
- `frontend-probes`: up only when the frontend dev/prod URL is reachable
- `postgres`: up through Postgres exporter
- `redis`: up through Redis exporter
- `traefik`: up
- `cadvisor`: up
- `node`: up
- `otel-collector`: up

## Frontend Connection

Development:

```text
VITE_API_URL=http://localhost:5556
```

Production:

```text
VITE_API_URL=https://backend.your-domain.example
```

The frontend should:

1. Call `POST /v1/auth/register` or `POST /v1/auth/login`.
2. Store `data.access_token`.
3. Send `Authorization: Bearer <token>`.
4. Call `GET /v1/auth/me`.
5. Pick an organization from `data.memberships`.
6. Send `x-org-id` for all tenant-scoped calls.
7. Use signed upload URLs for file bytes.

Temporary open mode:

- `CORS_ORIGINS=*`
- Traefik `PathPrefix('/')` router

Production hardened mode:

- `CORS_ORIGINS=https://app.example.com,https://admin.example.com`
- Traefik host rule such as `Host('backend.example.com')`
- TLS certificates and HTTPS redirect
- rotated secrets

## Database Operations

Backup local PostgreSQL:

```bash
docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql
```

Restore local PostgreSQL:

```bash
cat backup.sql | docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

Production recommendations:

- Managed PostgreSQL with point-in-time recovery.
- Daily logical backups plus PITR.
- Restore drills before production onboarding.
- Connection pooling when scaling API replicas high.
- Slow query logging and index review after real workload data appears.

## Object Storage Operations

Local MinIO:

- API: `http://localhost:5568`
- Console: `http://localhost:5569`
- Bucket: `documents`
- Bucket access: private

Production recommendations:

- Use managed S3-compatible storage.
- Enable bucket versioning or object-lock if legal retention requires it.
- Use lifecycle policies for expired temporary files.
- Use CDN only for public/static assets; protected legal documents should remain signed.

## Queue Operations

Inspect Redis health:

```bash
docker compose exec redis redis-cli ping
```

Run cron jobs manually:

```bash
curl -X POST http://localhost:5556/api/public/cron/mark-overdue \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST http://localhost:5556/api/public/cron/send-reminders \
  -H "Authorization: Bearer $CRON_SECRET"
```

Scale workers:

```bash
docker compose up -d --scale worker=4
```

## Hardware Recommendations

Small production / pilot:

- 2 API containers
- 1-2 worker containers
- 2 vCPU / 4 GB RAM application node
- managed PostgreSQL with 2 vCPU / 4-8 GB RAM
- managed Redis with 1-2 GB RAM
- S3-compatible object storage

Growing production:

- 4-8 API containers
- 2-4 workers
- 2 application nodes, each 4 vCPU / 8 GB RAM
- PostgreSQL 4-8 vCPU / 16-32 GB RAM
- Redis 2-4 GB RAM
- CDN in front of public assets

Large production / 100k+ active users:

- 8-20 API containers
- 4-10 workers
- 3+ application nodes across availability zones
- PostgreSQL 8-16+ vCPU / 64+ GB RAM, PITR, read replicas where useful
- Redis managed HA
- dedicated AI workers if AI volume is high
- provider rate-limit contract with Novita

## Capacity Planning

Local Docker benchmark on this machine measured:

- `/health` benchmark: about `12.9k` req/s at concurrency `100`
- `/metrics` benchmark: about `1.34k` req/s at concurrency `50`
- `/health` stress: about `10.8k` req/s at concurrency `250`
- `/metrics` stress: about `1.06k` req/s at concurrency `100`

Planning ranges per API container:

| Workload | Planning range |
| --- | ---: |
| Liveness/readiness/light cached reads | `2,000-8,000` req/s |
| Metrics scrapes | `500-1,500` req/s, scraped every `15-30s` |
| Authenticated indexed CRUD | `150-800` req/s |
| Mixed dashboard/list/detail traffic | `100-500` req/s |
| AI endpoints | Provider-bound by Novita limits and model latency |

Approximate users/second:

- Modest 4-container deployment: plan around `100-500` non-AI user requests/second until staging proves more.
- Optimized 8-container deployment with tuned PostgreSQL and cached aggregates: practical target around `800-2,500` non-AI user requests/second.
- AI requests/second depends on Novita RPM/TPM. Example: `600 RPM` at 5-second average model latency is about `10 AI requests/second` regardless of API CPU headroom.

## Production Hardening Checklist

- Rotate all dev defaults in `.env.example`.
- Set explicit `CORS_ORIGINS`.
- Configure Traefik hostnames and TLS.
- Put secrets in a secret manager.
- Disable public access to Traefik dashboard, MinIO console, Prometheus, and Grafana or protect them with SSO/VPN.
- Add database backups and restore drills.
- Add object-storage lifecycle/retention rules.
- Add CI that runs Docker integration tests on every merge.
- Add staging load tests with realistic database size.
- Add API-level audit log review and admin export tooling.
- Add alert rules for:
  - API 5xx rate
  - p95/p99 latency
  - PostgreSQL connections and disk
  - Redis memory
  - queue failures
  - Novita error rate
  - AI token spend
  - container restarts
  - blackbox probe failures
