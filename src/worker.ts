import "./telemetry.js";
import { type Processor, Worker, type WorkerOptions } from "bullmq";
import { and, eq } from "drizzle-orm";
import { request } from "undici";
import { env } from "./config/env.js";
import { createDb, createPostgresClient } from "./db/client.js";
import { notifications } from "./db/schema.js";
import { getRedisConnection } from "./queues/index.js";
import { jobsTotal } from "./services/metrics.js";
import { markOverdueInvoices } from "./utils/db.js";

const sql = createPostgresClient();
const db = createDb(sql);

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
      const updated = await markOverdueInvoices(db);
      return { updated };
    }
  }),
  createWorker("notifications", async (job) => {
    if (job.name !== "send-due-reminders") return;
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.deliveryStatus, "pending"))
      .limit(500);

    for (const notification of rows) {
      if (env.NOTIFICATION_WEBHOOK_URL) {
        await request(env.NOTIFICATION_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(notification),
        });
      }

      await db
        .update(notifications)
        .set({ deliveryStatus: "sent" })
        .where(
          and(eq(notifications.id, notification.id), eq(notifications.deliveryStatus, "pending")),
        );
    }

    return { sent: rows.length };
  }),
];

const shutdown = async (signal: string) => {
  console.info({ signal }, "Shutting down workers");
  await Promise.all(workers.map((worker) => worker.close()));
  await sql.end({ timeout: 5 });
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
