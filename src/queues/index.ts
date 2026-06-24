import { type ConnectionOptions, Queue } from "bullmq";
import { env } from "../config/env.js";

export type QueueName = "billing" | "notifications" | "ai";

const queues = new Map<QueueName, Queue>();

export function getRedisConnection(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  const options: Record<string, unknown> = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.pathname && url.pathname !== "/") {
    options.db = Number(url.pathname.slice(1));
  }

  return options as ConnectionOptions;
}

export function getQueue(name: QueueName) {
  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  queues.set(name, queue);
  return queue;
}

export async function enqueueJob<T extends Record<string, unknown>>(
  queueName: QueueName,
  jobName: string,
  data: T,
) {
  if (!env.QUEUE_ENABLED) {
    return { queued: false, reason: "Queue disabled" };
  }

  const queue = getQueue(queueName);
  const job = await queue.add(jobName, data);
  return { queued: true, id: job.id };
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}
