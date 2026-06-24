# arab.law backend

Production TypeScript backend for the Supabase/TanStack system described in the product spec.

## Stack

- Fastify 5 + TypeScript for a high-throughput API layer.
- Supabase Auth and Postgres RLS remain the security boundary; every authenticated request uses a user-scoped Supabase client.
- BullMQ + Redis for cron fan-out and background jobs.
- Novita AI integration with per-feature token metrics, persisted usage events, and monthly token budgets.
- Traefik for Docker service discovery and load balancing.
- Prometheus, Grafana, Loki, Tempo, OpenTelemetry Collector, cAdvisor, node-exporter, Redis exporter, and Blackbox exporter for backend, frontend, infra, and AI observability.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

API docs are served from `/docs`, metrics from `/metrics`, liveness from `/health`, and readiness from `/ready`.

## Testing and load checks

```bash
npm run test
npm run typecheck
npm run lint
npm run build
npm run benchmark
npm run stress
```

`benchmark` and `stress` start a local Fastify instance with safe dummy secrets, disabled queues, and disabled OpenTelemetry export. They measure backend HTTP overhead on `/health` and `/metrics` only, so they do not spend Novita AI credits and do not hit Supabase.

The same checks can be run in Docker Compose with the dedicated test runner:

```bash
docker compose run --rm test-runner npm run lint
docker compose run --rm test-runner npm run typecheck
docker compose run --rm test-runner npm run test
docker compose run --rm test-runner npm run build
docker compose run --rm test-runner npm run benchmark
docker compose run --rm test-runner npm run stress
```

## Docker

```bash
cp .env.example .env
docker compose up --build --scale api=3 --scale worker=2
```

Useful local URLs:

- API through Traefik: `http://localhost:5556` or any host pointed at port `5556`
- Traefik dashboard: `http://localhost:5557`
- Prometheus: `http://localhost:5558`
- Grafana: `http://localhost:5559` (`admin` / `admin` unless overridden)
- Loki: `http://localhost:5560`
- Tempo: `http://localhost:5561`
- Tempo OTLP gRPC: `localhost:5562`
- OpenTelemetry OTLP HTTP: `http://localhost:5563`
- OpenTelemetry Collector metrics: `http://localhost:5564`
- cAdvisor: `http://localhost:5565`
- Blackbox exporter: `http://localhost:5566`

By default this compose setup is temporarily permissive:

- Traefik routes all hostnames on port `5556` to the API.
- `CORS_ORIGINS=*` allows browser requests from any frontend origin.

Before production hardening, replace `CORS_ORIGINS=*` with explicit frontend origins and change the Traefik API router rule back to a specific `Host(...)` rule.

## Supabase migration

Run `supabase/migrations/202606240001_ai_observability.sql` in the Supabase project. It adds:

- `ai_usage_events` for persistent token/latency/status accounting.
- `ai_token_budgets` for monthly per-organization token limits.
- RLS policies that let organization members read usage and service role manage writes.

## Production notes

- Set `SUPABASE_JWT_SECRET` so the API can verify JWTs locally and avoid an Auth round trip per request.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, `NOVITA_API_KEY`, `ELEVENLABS_API_KEY`, and webhook secrets only in the deployment secret store.
- Do not commit real API keys into `.env.example`, tests, reports, or source files.
- Scale stateless API containers horizontally behind Traefik. Scale workers separately based on queue depth and AI provider rate limits.
- Point `FRONTEND_URL` in Prometheus blackbox targets if the frontend is not running at `host.docker.internal:5173`.
- Use Supabase RLS policies as the final authorization boundary; the API adds validation, orchestration, observability, and rate limiting.
