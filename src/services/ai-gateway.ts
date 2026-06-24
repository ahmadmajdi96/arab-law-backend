import { performance } from "node:perf_hooks";
import { and, eq, gte, sql } from "drizzle-orm";
import { request } from "undici";
import { env } from "../config/env.js";
import type { AppDb } from "../db/client.js";
import {
  aiTokenBudgets,
  aiUsageEvents,
  caseEvents,
  caseNotes,
  caseParties,
  cases,
  clients,
} from "../db/schema.js";
import { errors } from "../utils/errors.js";
import { aiRequestDuration, aiRequestsTotal, aiTokensTotal } from "./metrics.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AiGatewayInput = {
  db: AppDb;
  orgId: string;
  userId: string;
  feature: string;
  messages: ChatMessage[];
  model?: string | undefined;
  temperature?: number | undefined;
  responseFormat?: "text" | "json" | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type AiGatewayResult = {
  text: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export function estimateTokens(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(text.length / 4));
}

export function novitaChatCompletionsUrl(baseUrl = env.NOVITA_AI_BASE_URL) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

async function monthlyUsage(db: AppDb, orgId: string) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)` })
    .from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.orgId, orgId), gte(aiUsageEvents.createdAt, since)));
  return Number(row?.total ?? 0);
}

async function assertTokenBudget(db: AppDb, orgId: string, estimatedPromptTokens: number) {
  if (!env.AI_TOKEN_BUDGET_ENFORCEMENT) return;

  const [budget] = await db
    .select()
    .from(aiTokenBudgets)
    .where(eq(aiTokenBudgets.orgId, orgId))
    .limit(1);

  if (!budget?.monthlyTokenLimit || budget.hardLimitEnabled === false) return;

  const used = await monthlyUsage(db, orgId);
  if (used + estimatedPromptTokens > budget.monthlyTokenLimit) {
    throw errors.tooManyRequests("Monthly AI token budget exceeded", {
      used,
      estimatedPromptTokens,
      monthlyLimit: budget.monthlyTokenLimit,
    });
  }
}

async function recordUsage(
  input: AiGatewayInput,
  result: AiGatewayResult | undefined,
  latencyMs: number,
  status: "success" | "error",
  error?: unknown,
) {
  const model = result?.model ?? input.model ?? env.AI_DEFAULT_MODEL;
  const usage = result?.usage ?? {
    prompt_tokens: estimateTokens(input.messages),
    completion_tokens: 0,
    total_tokens: estimateTokens(input.messages),
  };

  aiRequestsTotal.inc({ feature: input.feature, model, status });
  aiRequestDuration.observe({ feature: input.feature, model, status }, latencyMs / 1000);
  aiTokensTotal.inc({ feature: input.feature, model, direction: "prompt" }, usage.prompt_tokens);
  aiTokensTotal.inc(
    { feature: input.feature, model, direction: "completion" },
    usage.completion_tokens,
  );

  await input.db.insert(aiUsageEvents).values({
    orgId: input.orgId,
    userId: input.userId,
    feature: input.feature,
    model,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    latencyMs: Math.round(latencyMs),
    status,
    metadata: {
      ...input.metadata,
      error: error instanceof Error ? error.message : undefined,
    },
  });
}

function extractText(payload: any) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? payload?.output_text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(payload);
}

export async function callAiGateway(input: AiGatewayInput): Promise<AiGatewayResult> {
  const model = input.model ?? env.AI_DEFAULT_MODEL;
  const start = performance.now();

  if (!env.NOVITA_API_KEY) {
    throw errors.unavailable("NOVITA_API_KEY is required for AI calls");
  }

  await assertTokenBudget(input.db, input.orgId, estimateTokens(input.messages));

  try {
    const response = await request(novitaChatCompletionsUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.NOVITA_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        response_format: input.responseFormat === "json" ? { type: "json_object" } : undefined,
        metadata: {
          org_id: input.orgId,
          user_id: input.userId,
          feature: input.feature,
          ...input.metadata,
        },
      }),
    });

    const payload = (await response.body.json()) as any;
    if (response.statusCode >= 400) {
      throw errors.upstream("AI gateway request failed", {
        statusCode: response.statusCode,
        payload,
      });
    }

    const usage = payload?.usage ?? {};
    const result: AiGatewayResult = {
      text: extractText(payload),
      model: payload?.model ?? model,
      usage: {
        prompt_tokens: Number(usage.prompt_tokens ?? estimateTokens(input.messages)),
        completion_tokens: Number(usage.completion_tokens ?? estimateTokens(extractText(payload))),
        total_tokens: Number(
          usage.total_tokens ??
            estimateTokens(input.messages) + estimateTokens(extractText(payload)),
        ),
      },
    };

    await recordUsage(input, result, performance.now() - start, "success");
    return result;
  } catch (error) {
    await recordUsage(input, undefined, performance.now() - start, "error", error).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function getCaseContext(db: AppDb, orgId: string, caseId: string) {
  const [legalCase] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.orgId, orgId)))
    .limit(1);
  if (!legalCase) throw errors.notFound("Case not found");

  const [client, parties, notes, events] = await Promise.all([
    legalCase.clientId
      ? db.select().from(clients).where(eq(clients.id, legalCase.clientId)).limit(1)
      : Promise.resolve([]),
    db.select().from(caseParties).where(eq(caseParties.caseId, caseId)),
    db.select().from(caseNotes).where(eq(caseNotes.caseId, caseId)),
    db.select().from(caseEvents).where(eq(caseEvents.caseId, caseId)),
  ]);

  return {
    ...legalCase,
    client: client[0] ?? null,
    parties,
    notes,
    events,
  };
}
