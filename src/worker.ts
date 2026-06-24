import "./telemetry.js";
import { createClient } from "@supabase/supabase-js";
import { type Processor, Worker, type WorkerOptions } from "bullmq";
import { request } from "undici";
import { env } from "./config/env.js";
import { getRedisConnection } from "./queues/index.js";
import { jobsTotal } from "./services/metrics.js";

const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function createWorker(name: string, processor: Processor) {
  const options: WorkerOptions = {
    connection: getRedisConnection(),
    concurrency: name === "ai" ? 5 : 20,
  };

  if (name === "ai") {
    options.limiter = { max: 60, duration: 60_000 };
  }

  const worker = new Worker(name, processor, options);

  worker.on("completed", (job) => {
    jobsTotal.inc({ queue: name, name: job.name, status: "completed" });
  });

  worker.on("failed", (job) => {
    jobsTotal.inc({ queue: name, name: job?.name ?? "unknown", status: "failed" });
  });

  return worker;
}

const workers = [
  createWorker("billing", async (job) => {
    if (job.name === "overdue-sweep") {
      const result = await supabaseAdmin.rpc("mark_invoices_overdue");
      if (result.error) throw result.error;
      return result.data;
    }
  }),
  createWorker("notifications", async (job) => {
    if (job.name !== "send-due-reminders") return;
    const { data, error } = await supabaseAdmin
      .from("notifications")
      .select("*")
      .lte("scheduled_at", new Date().toISOString())
      .is("sent_at", null)
      .limit(500);

    if (error) throw error;

    for (const notification of data ?? []) {
      if (env.NOTIFICATION_WEBHOOK_URL) {
        await request(env.NOTIFICATION_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(notification),
        });
      }

      await supabaseAdmin
        .from("notifications")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", notification.id);
    }

    return { sent: data?.length ?? 0 };
  }),
];

const shutdown = async (signal: string) => {
  console.info({ signal }, "Shutting down workers");
  await Promise.all(workers.map((worker) => worker.close()));
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
