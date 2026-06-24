import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";

type Scenario = {
  name: string;
  path: string;
  durationMs: number;
  concurrency: number;
};

type ScenarioResult = {
  name: string;
  path: string;
  durationMs: number;
  concurrency: number;
  completed: number;
  errors: number;
  requestsPerSecond: number;
  bytesPerSecond: number;
  latencyMs: {
    min: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  statusCodes: Record<string, number>;
  failedResponses: number;
};

function configureSafeBenchmarkEnv() {
  process.env.NODE_ENV ??= "test";
  process.env.HOST ??= "127.0.0.1";
  process.env.PORT ??= "3000";
  process.env.LOG_LEVEL = "silent";
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY ??= "benchmark-publishable-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "benchmark-service-role-key";
  process.env.SUPABASE_JWT_SECRET ??= "";
  process.env.NOVITA_API_KEY ??= "benchmark-novita-key";
  process.env.NOVITA_AI_BASE_URL ??= "https://api.novita.ai/openai";
  process.env.AI_DEFAULT_MODEL ??= "deepseek/deepseek-r1";
  process.env.CRON_SECRET ??= "benchmark-cron-secret-with-length";
  process.env.PAYMENT_WEBHOOK_SECRET ??= "benchmark-payment-secret-with-length";
  process.env.MEETING_TOKEN_SECRET ??= "benchmark-meeting-secret-with-length";
  process.env.RATE_LIMIT_MAX = "10000000";
  process.env.RATE_LIMIT_WINDOW = "1 minute";
  process.env.QUEUE_ENABLED = "false";
  process.env.OTEL_ENABLED = "false";
}

function percentile(sorted: number[], pct: number) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function summarizeLatencies(latencies: number[]) {
  const sorted = [...latencies].sort((a: number, b: number) => a - b);
  const sum = sorted.reduce((total: number, value: number) => total + value, 0);
  const round = (value: number) => Number(value.toFixed(2));

  return {
    min: round(sorted[0] ?? 0),
    mean: round(sorted.length ? sum / sorted.length : 0),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0),
  };
}

async function runScenario(baseUrl: string, scenario: Scenario): Promise<ScenarioResult> {
  const url = `${baseUrl}${scenario.path}`;
  const deadline = performance.now() + scenario.durationMs;
  const latencies: number[] = [];
  const statusCodes: Record<string, number> = {};
  let completed = 0;
  let errors = 0;
  let failedResponses = 0;
  let bytes = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const started = performance.now();
      try {
        const response = await fetch(url, {
          headers: {
            "user-agent": "arab-law-local-load-test",
          },
        });
        const body = await response.arrayBuffer();
        bytes += body.byteLength;
        statusCodes[String(response.status)] = (statusCodes[String(response.status)] ?? 0) + 1;
        if (!response.ok) {
          failedResponses += 1;
        }
      } catch {
        errors += 1;
      } finally {
        completed += 1;
        latencies.push(performance.now() - started);
      }
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: scenario.concurrency }, () => worker()));
  const elapsedSeconds = (performance.now() - started) / 1000;

  return {
    ...scenario,
    completed,
    errors,
    failedResponses,
    requestsPerSecond: Number((completed / elapsedSeconds).toFixed(2)),
    bytesPerSecond: Number((bytes / elapsedSeconds).toFixed(2)),
    latencyMs: summarizeLatencies(latencies),
    statusCodes,
  };
}

function scenariosFor(mode: string): Scenario[] {
  if (mode === "stress") {
    return [
      { name: "health-stress", path: "/health", durationMs: 15_000, concurrency: 250 },
      { name: "metrics-stress", path: "/metrics", durationMs: 10_000, concurrency: 100 },
    ];
  }

  return [
    { name: "health-benchmark", path: "/health", durationMs: 10_000, concurrency: 100 },
    { name: "metrics-benchmark", path: "/metrics", durationMs: 10_000, concurrency: 50 },
  ];
}

async function main() {
  configureSafeBenchmarkEnv();
  const mode = process.argv[2] ?? "benchmark";
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp();

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  await runScenario(baseUrl, {
    name: "warmup",
    path: "/health",
    durationMs: 2_000,
    concurrency: 25,
  });

  const results: ScenarioResult[] = [];
  for (const scenario of scenariosFor(mode)) {
    results.push(await runScenario(baseUrl, scenario));
  }

  await app.close();

  const report = {
    mode,
    generatedAt: new Date().toISOString(),
    baseUrl,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    machine: {
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
    },
    results,
  };

  await mkdir("reports", { recursive: true });
  const file = `reports/${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({ reportFile: file, ...report }, null, 2));

  const failedScenarios = results.filter(
    (result) => result.errors > 0 || result.failedResponses > 0,
  );
  if (failedScenarios.length > 0) {
    console.error(
      JSON.stringify(
        {
          error: "Load test completed with failed requests",
          failedScenarios: failedScenarios.map((result) => ({
            name: result.name,
            errors: result.errors,
            failedResponses: result.failedResponses,
            statusCodes: result.statusCodes,
          })),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

await main();
