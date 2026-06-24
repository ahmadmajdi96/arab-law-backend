import client from "prom-client";

export const registry = new client.Registry();

client.collectDefaultMetrics({
  register: registry,
  prefix: "arab_law_",
});

export const httpRequestDuration = new client.Histogram({
  name: "arab_law_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsTotal = new client.Counter({
  name: "arab_law_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
});

export const httpActiveRequests = new client.Gauge({
  name: "arab_law_http_active_requests",
  help: "Current active HTTP requests",
});

export const aiRequestsTotal = new client.Counter({
  name: "arab_law_ai_requests_total",
  help: "Total AI gateway requests",
  labelNames: ["feature", "model", "status"] as const,
});

export const aiTokensTotal = new client.Counter({
  name: "arab_law_ai_tokens_total",
  help: "Total AI tokens by direction",
  labelNames: ["feature", "model", "direction"] as const,
});

export const aiRequestDuration = new client.Histogram({
  name: "arab_law_ai_request_duration_seconds",
  help: "AI gateway request duration in seconds",
  labelNames: ["feature", "model", "status"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

export const jobsTotal = new client.Counter({
  name: "arab_law_jobs_total",
  help: "Background jobs by queue, name, and status",
  labelNames: ["queue", "name", "status"] as const,
});

registry.registerMetric(httpRequestDuration);
registry.registerMetric(httpRequestsTotal);
registry.registerMetric(httpActiveRequests);
registry.registerMetric(aiRequestsTotal);
registry.registerMetric(aiTokensTotal);
registry.registerMetric(aiRequestDuration);
registry.registerMetric(jobsTotal);
