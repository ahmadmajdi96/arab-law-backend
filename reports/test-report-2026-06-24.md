# arab.law Backend Test Report

Generated: 2026-06-24 15:06 Asia/Amman

## Scope

This report covers the production-owned backend rewrite:

- Fastify/TypeScript API
- First-party JWT authentication
- PostgreSQL 17 with Drizzle ORM
- Redis/BullMQ workers
- S3-compatible storage with MinIO locally
- Novita AI integration
- Token usage persistence and Prometheus metrics
- Traefik load balancing
- Prometheus/Grafana/Loki/Tempo/OpenTelemetry monitoring
- Docker Compose deployment in host port range `5556-5570`

## Summary

| Area | Result |
| --- | --- |
| Local typecheck/lint/build | Passed |
| Local unit tests | Passed |
| Dependency audit | Passed, `0` vulnerabilities |
| Docker Compose config validation | Passed |
| Docker API/worker image build | Passed |
| Docker integration tests | Passed, `5` files, `11` tests |
| Docker benchmark | Passed, zero failed responses |
| Docker stress test | Passed, zero failed responses |
| Live Compose API smoke | Passed through Traefik |
| Prometheus target health | All active targets up |
| Grafana health | Passed |
| Real Novita smoke calls | Passed |
| AI token metrics in Prometheus | Passed |

## Commands Executed

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run test` | Passed before final docs; full Docker integration below is the authoritative end-to-end run |
| `npm run build` | Passed |
| `npm audit --audit-level=moderate` | Passed, `0` vulnerabilities |
| `npm run db:generate -- --name audit-smoke` | Passed, no schema drift |
| `docker compose config --quiet` | Passed |
| `docker compose build api worker` | Passed |
| `docker compose run --rm test-runner npm ci` | Passed, `0` vulnerabilities |
| `docker compose run --rm -e RUN_INTEGRATION=1 test-runner npm run test` | Passed |
| `docker compose run --rm test-runner npm run typecheck` | Passed |
| `docker compose run --rm test-runner npm run lint` | Passed |
| `docker compose run --rm test-runner npm run build` | Passed |
| `docker compose run --rm test-runner npm run benchmark` | Passed |
| `docker compose run --rm test-runner npm run stress` | Passed |
| `docker compose up -d --scale api=2 --scale worker=2` | Passed |
| `curl http://127.0.0.1:5556/health` | Passed |
| `curl http://127.0.0.1:5556/ready` | Passed |
| `curl http://127.0.0.1:5556/metrics` | Passed |
| `curl http://127.0.0.1:5558/-/ready` | Passed |
| `curl http://127.0.0.1:5559/api/health` | Passed |
| Prometheus query `sum(arab_law_ai_requests_total)` | Passed, returned `2` on the final recreated replicas |
| Prometheus query `sum(arab_law_ai_tokens_total)` | Passed, returned `128` on the final recreated replicas |

## Docker Integration Test Coverage

The full integration suite ran inside Docker against Compose PostgreSQL, Redis, and MinIO.

| Test file | Coverage | Result |
| --- | --- | --- |
| `tests/app.test.ts` | Health endpoint app boot | Passed |
| `tests/security.test.ts` | HMAC/security helpers | Passed |
| `tests/errors.test.ts` | Error mapping | Passed |
| `tests/ai-gateway.test.ts` | Token estimation and Novita URL normalization | Passed |
| `tests/full-stack.test.ts` | Auth, clients, cases, documents, public shares, appointments, deadlines, notifications, billing, drafts, meetings, live sessions, analytics, AI usage | Passed |

Docker integration result:

```text
Test Files  5 passed (5)
Tests       11 passed (11)
Duration    7.67s
```

## Live Compose Smoke Results

The stack was started with:

```bash
docker compose up -d --scale api=2 --scale worker=2
```

Healthy services observed:

- 2 API replicas
- 2 worker replicas
- Traefik
- PostgreSQL
- Postgres exporter
- Redis
- Redis exporter
- MinIO
- Prometheus
- Grafana
- Loki
- Promtail
- Tempo
- OpenTelemetry Collector
- cAdvisor
- node-exporter
- blackbox exporter

Live endpoint responses:

```json
GET /health
{"status":"ok","service":"arab-law-backend","timestamp":"2026-06-24T11:55:44.307Z"}
```

```json
GET /ready
{"status":"ready","checks":{"database":{"ok":true},"storage":{"ok":true}},"timestamp":"2026-06-24T11:55:44.321Z"}
```

Grafana health:

```json
{
  "database": "ok",
  "version": "11.3.1",
  "commit": "64b556c137a1d9bcacd19ccb16c4cf138c78ca40"
}
```

Prometheus active targets:

```text
api up
api up
backend-probes up
backend-probes up
cadvisor up
frontend-probes up
node up
otel-collector up
postgres up
redis up
traefik up
```

## Real Novita Smoke Test

Endpoint:

```text
POST /api/public/monitoring/novita-smoke
```

Model:

```text
meta-llama/llama-3.1-8b-instruct
```

The endpoint was called through Traefik with the cron bearer token loaded from local `.env` but not printed. After the final API/worker image rebuild and container recreate, two fresh smoke calls were sent to seed the current replicas.

Representative response:

```json
{
  "data": {
    "ok": true,
    "model": "meta-llama/llama-3.1-8b-instruct",
    "latency_ms": 1019,
    "usage": {
      "prompt_tokens": 57,
      "completion_tokens": 7,
      "total_tokens": 64
    },
    "text": "arab.law monitoring ok"
  }
}
```

Prometheus confirmed:

| Query | Result |
| --- | ---: |
| `sum(arab_law_ai_requests_total)` | `2` |
| `sum(arab_law_ai_tokens_total)` | `128` |

This proves that live Novita calls, API metrics, Prometheus scraping, and Grafana token panels have real data.

## Benchmark Results

Benchmark file:

```text
reports/benchmark-2026-06-24T11-50-35-702Z.json
```

Environment reported inside Docker:

- Node.js: `v24.17.0`
- Platform: `linux`
- Architecture: `arm64`
- Logical CPUs available to Docker: `10`
- Memory available to Docker: `7.65 GB`

| Scenario | Duration | Concurrency | Completed | Failed | Req/s | Mean | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/health` benchmark | 10s | 100 | 129,332 | 0 | 12,927.01 | 7.73ms | 6.42ms | 12.68ms | 22.70ms | 215.17ms |
| `/metrics` benchmark | 10s | 50 | 13,421 | 0 | 1,341.16 | 37.27ms | 35.16ms | 53.98ms | 72.84ms | 113.55ms |

## Stress Results

Stress file:

```text
reports/stress-2026-06-24T11-51-08-594Z.json
```

| Scenario | Duration | Concurrency | Completed | Failed | Req/s | Mean | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/health` stress | 15s | 250 | 162,067 | 0 | 10,787.38 | 23.16ms | 21.01ms | 33.77ms | 45.27ms | 1292.20ms |
| `/metrics` stress | 10s | 100 | 10,689 | 0 | 1,061.65 | 94.17ms | 90.98ms | 111.95ms | 140.26ms | 176.45ms |

## Issues Found And Fixed During Testing

| Issue | Impact | Fix |
| --- | --- | --- |
| Test bootstrap overwrote Docker `DATABASE_URL` with `127.0.0.1`. | Docker integration auth failed with `500`. | `tests/setup.ts` now only fills defaults when env vars are absent. |
| Test helper sent `Content-Type: application/json` with no body. | Fastify rejected empty-body action routes with `400`. | Helper now sets JSON content type only when a payload exists. |
| Traefik selected a non-deterministic shared network for API replicas. | Routed `/ready` could time out during live smoke. | Added `traefik.docker.network=arab-law-backend_public`. |
| Postgres exporter `v0.16.0` queried old PostgreSQL checkpoint columns. | Postgres exporter logs showed collector errors against PostgreSQL 17. | Upgraded to `prometheuscommunity/postgres-exporter:v0.19.1`. |
| `drizzle-kit` pulled an old transitive `esbuild` through `@esbuild-kit`. | `npm audit` reported 4 moderate dev-tool vulnerabilities. | Added npm override for `@esbuild-kit/core-utils -> esbuild ^0.25.12`; audit is now clean. |
| Generated draft response returned raw camelCase. | Inconsistent API response shape. | `POST /v1/drafts/generate` now serializes with `toApi()`. |

## What The Benchmarks Prove

The benchmark and stress tests prove:

- Fastify runtime has strong headroom for lightweight endpoints.
- Prometheus metrics endpoint can be scraped reliably.
- No failures occurred under the tested local concurrency levels.
- The app image, Compose networking, and runtime dependency graph are functional.

They do not prove:

- Full database throughput with millions of rows.
- Legal-document upload/download throughput under large files.
- Real-world Novita throughput under high-volume AI usage.
- Production latency from a public cloud region.

Those require staging tests with realistic data volume, production-grade PostgreSQL, production Redis, production object storage, and the actual Novita rate-limit plan.

## Capacity Guidance

Planning ranges per API container:

| Workload | Planning range |
| --- | ---: |
| Liveness/readiness/light cached reads | `2,000-8,000 req/s` |
| Metrics scrapes | `500-1,500 req/s`, scraped every `15-30s` |
| Authenticated indexed CRUD | `150-800 req/s` |
| Mixed dashboard/list/detail traffic | `100-500 req/s` |
| AI endpoints | Provider-bound by Novita RPM/TPM, model latency, prompt size, and token budget |

Approximate served user requests per second:

| Deployment | Practical planning range |
| --- | ---: |
| 2 API containers, modest database | `50-250` non-AI user req/s |
| 4 API containers, indexed PostgreSQL, normal dashboard/list traffic | `100-500` non-AI user req/s |
| 8 API containers, tuned PostgreSQL, cached dashboard aggregates | `800-2,500` non-AI user req/s |
| AI traffic | Determined by Novita limits; for example `600 RPM` is about `10 AI req/s` before queuing |

## Hardware Recommendations

Pilot production:

- 1 application node with 2 vCPU / 4 GB RAM
- 2 API containers
- 1-2 workers
- managed PostgreSQL with 2 vCPU / 4-8 GB RAM
- managed Redis with 1-2 GB RAM
- S3-compatible object storage

Growth production:

- 2 application nodes with 4 vCPU / 8 GB RAM each
- 4-8 API containers
- 2-4 workers
- PostgreSQL with 4-8 vCPU / 16-32 GB RAM
- Redis HA or managed Redis
- CDN only where appropriate

Large production:

- 3+ application nodes
- 8-20 API containers
- 4-10 workers
- PostgreSQL 8-16+ vCPU / 64+ GB RAM with PITR and read replicas where useful
- managed Redis HA
- dedicated AI worker tier if AI traffic becomes heavy
- explicit Novita RPM/TPM contract

## Recommendations

1. Run a staging load test with realistic row counts before promising public SLA numbers.
2. Add database indexes after observing production query patterns with real data.
3. Cache dashboard aggregates for `15-60s` per organization.
4. Keep `/metrics` scraped every `15-30s`, not at user request frequency.
5. Keep Novita smoke tests low-frequency to avoid spending tokens on monitoring noise.
6. Add alert rules for HTTP 5xx, p95/p99 latency, AI errors, token spend, queue failures, DB connections, Redis memory, and container restarts.
7. Move PostgreSQL, Redis, and object storage to managed HA services before onboarding high-value production customers.
8. Replace temporary open CORS and all-host Traefik routing with explicit production origins/hosts.
