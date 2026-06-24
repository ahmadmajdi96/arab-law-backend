# arab.law backend test report

Generated: 2026-06-24 11:15 Asia/Amman

## Scope

- Built a production-oriented Fastify/TypeScript backend with Docker Compose services for API, workers, Redis, Traefik, Prometheus, Grafana, Loki, Tempo, OpenTelemetry Collector, cAdvisor, node-exporter, Redis exporter, and Blackbox exporter.
- Converted AI provider wiring to Novita AI using OpenAI-compatible chat completions.
- Added AI token/request/latency metrics for Prometheus and Grafana.
- Added a Docker Compose `test-runner` service so checks can run with `docker compose run`.
- Exercised real Novita monitoring smoke calls separately from synthetic benchmark runs.

## Docker Compose checks

| Check | Result |
| --- | --- |
| `docker compose config --quiet` | Passed |
| `docker compose build test-runner` | Passed |
| `docker compose run --rm test-runner npm run lint` | Passed |
| `docker compose run --rm test-runner npm run typecheck` | Passed |
| `docker compose run --rm test-runner npm run test` | Passed, 4 files, 6 tests |
| `docker compose run --rm test-runner npm run build` | Passed |
| `docker compose run --rm test-runner npm run benchmark` | Passed |
| `docker compose run --rm test-runner npm run stress` | Passed |

## Fixes found during testing

- Preserved framework HTTP status codes in the API error handler so rate-limit errors remain `429` instead of becoming `500`.
- Made the load-test script fail the process if any request returns a non-2xx response.
- Forced benchmark-safe rate-limit, queue, and OpenTelemetry settings inside benchmark/stress runs.
- Added a worker-specific Docker healthcheck so workers are not probed like HTTP API containers.
- Added the Compose `test-runner` service for repeatable containerized validation.

## Latest benchmark results

Environment reported inside Docker: Node.js v24.17.0, Linux arm64, 10 logical CPUs, 7.65 GB memory available to Docker.

| Scenario | Duration | Concurrency | Completed | Failed | Req/s | Mean | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/health` benchmark | 10s | 100 | 115,456 | 0 | 11,521.87 | 8.67ms | 14.56ms | 25.38ms |
| `/metrics` benchmark | 10s | 50 | 9,627 | 0 | 960.86 | 51.99ms | 79.29ms | 118.15ms |

## Latest stress results

| Scenario | Duration | Concurrency | Completed | Failed | Req/s | Mean | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/health` stress | 15s | 250 | 97,205 | 0 | 6,464.69 | 38.63ms | 70.87ms | 147.05ms |
| `/metrics` stress | 10s | 100 | 7,499 | 0 | 749.41 | 133.40ms | 220.28ms | 235.21ms |

## Novita AI verification

- Endpoint exercised: `POST /api/public/monitoring/novita-smoke`.
- Model used for fast smoke calls: `meta-llama/llama-3.1-8b-instruct`.
- A real Novita response returned successfully with token usage recorded into Prometheus metrics.
- The default `deepseek/deepseek-r1` model timed out through Traefik during a smoke attempt, so faster models are recommended for health probes.

## Capacity guidance

The benchmark is intentionally limited to lightweight local endpoints. It proves API/runtime headroom, not full production business throughput.

| Workload | Planning range per API container |
| --- | ---: |
| Liveness/readiness/light cached reads | 2,000-8,000 req/s |
| Prometheus `/metrics` scrapes | 500-1,500 req/s, scraped at low frequency |
| Authenticated CRUD with Supabase RLS | 150-800 req/s depending on query/index quality |
| Mixed dashboard/list/detail traffic | 100-500 req/s depending on database latency |
| AI endpoints | Provider-bound by Novita RPM/TPM, model latency, and average tokens |

Suggested starting deployment:

| Scale target | Suggested baseline |
| --- | --- |
| Early production | 2 API containers, 1-2 workers, 2 vCPU/4 GB per node |
| 10k-50k active users | 4-8 API containers, 2-4 workers, 4 vCPU/8 GB API nodes |
| 100k+ active users | 8-20 API containers, 4-10 workers, managed Redis, upgraded Supabase/Postgres tier, CDN for documents |
| Heavy AI usage | Dedicated AI workers, per-org token budgets, Novita RPM/TPM upgrade, streaming responses |

Approximate served users per second:

- Non-AI authenticated app traffic: plan around 100-500 user requests/second on a modest 4-container deployment until staging database benchmarks prove higher.
- Optimized deployment with local JWT verification, indexed queries, cached dashboard aggregates, and 8 API containers: practical target around 800-2,500 non-AI user requests/second.
- AI requests/second are controlled mostly by Novita rate limits and model latency. For example, 600 RPM with 5-second average latency is about 10 AI requests/second regardless of API CPU headroom.

## Recommendations

1. Set `SUPABASE_JWT_SECRET` in production to avoid a Supabase Auth round trip on every protected request.
2. Add database indexes for common filters in cases, clients, deadlines, documents, invoices, reminders, and activity logs.
3. Cache dashboard and analytics aggregates for 15-60 seconds per organization.
4. Use queues or concurrency guards for long-running AI tasks.
5. Enforce per-organization token budgets through `ai_token_budgets`.
6. Use streaming and feature-specific `max_tokens` for long Novita responses.
7. Scrape `/metrics` every 15-30 seconds, not at user-traffic rates.
8. Run a second benchmark against a staging Supabase project before publishing SLA numbers.
