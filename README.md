# arab.law backend

Production-owned backend for the arab.law legal operations platform. The backend no longer depends on hosted BaaS runtime services; it owns authentication, PostgreSQL persistence, S3-compatible file storage, Redis queues, Novita AI integration, and observability.

## Stack

- Fastify 5, TypeScript, Zod validation, Jose JWTs, and scrypt password hashing.
- PostgreSQL 17 with Drizzle ORM schema and migrations.
- Redis 7 and BullMQ for background billing, notification, and AI job queues.
- S3-compatible storage through MinIO locally or any production S3 provider.
- Novita AI through its OpenAI-compatible chat completions API.
- Traefik load balancing with horizontally scalable API and worker replicas.
- Prometheus, Grafana, Loki, Tempo, OpenTelemetry Collector, cAdvisor, node-exporter, Redis exporter, Postgres exporter, and Blackbox exporter.
- Docker Compose ports stay inside the requested `5556-5570` host range.

## Quick Start

```bash
cp .env.example .env
npm install
npm run dev
```

Local API URLs:

- API docs: `http://localhost:3000/docs`
- Metrics: `http://localhost:3000/metrics`
- Liveness: `http://localhost:3000/health`
- Readiness: `http://localhost:3000/ready`

## Docker Compose

```bash
cp .env.example .env
docker compose up --build --scale api=2 --scale worker=2
```

Useful local URLs:

| Service | URL |
| --- | --- |
| API through Traefik | `http://localhost:5556` |
| Traefik dashboard | `http://localhost:5557` |
| Prometheus | `http://localhost:5558` |
| Grafana | `http://localhost:5559` |
| Loki | `http://localhost:5560` |
| Tempo | `http://localhost:5561` |
| Tempo OTLP gRPC | `localhost:5562` |
| OpenTelemetry OTLP HTTP | `http://localhost:5563` |
| OpenTelemetry Collector metrics | `http://localhost:5564` |
| cAdvisor | `http://localhost:5565` |
| Blackbox exporter | `http://localhost:5566` |
| PostgreSQL | `localhost:5567` |
| MinIO S3 API | `http://localhost:5568` |
| MinIO console | `http://localhost:5569` |

The default development Compose setup is intentionally permissive while the frontend is being connected:

- `CORS_ORIGINS=*` allows browser requests from any origin.
- Traefik routes all hostnames on port `5556` to the backend.

Before public production exposure, set explicit `CORS_ORIGINS`, use a specific Traefik host rule, rotate all default secrets, and put TLS in front of `5556`.

## Verification

Local checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run build
npm run benchmark
npm run stress
npm audit --audit-level=moderate
```

Docker checks:

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

`benchmark` and `stress` measure Fastify HTTP overhead on `/health` and `/metrics`. They do not spend Novita credits. Real Novita smoke testing is available at `POST /api/public/monitoring/novita-smoke` with the cron bearer token.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Operations Runbook](docs/OPERATIONS.md)
- [Test Report](reports/test-report-2026-06-24.md)

## Production Reminders

- Keep `JWT_SECRET`, `MEETING_TOKEN_SECRET`, `CRON_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `NOVITA_API_KEY`, object-storage credentials, and database credentials in a secret manager.
- Run API containers statelessly and scale them horizontally behind Traefik.
- Scale workers independently based on BullMQ queue depth, reminder volume, and AI provider rate limits.
- Keep documents in S3-compatible storage and serve them through short-lived signed URLs.
- Keep database backups, point-in-time recovery, and tested restore procedures in place before onboarding real clients.
