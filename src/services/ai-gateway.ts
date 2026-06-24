import { performance } from "node:perf_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { request } from "undici";
import { env } from "../config/env.js";
import { errors } from "../utils/errors.js";
import { unwrap, unwrapNullable } from "../utils/supabase.js";
import { aiRequestDuration, aiRequestsTotal, aiTokensTotal } from "./metrics.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AiGatewayInput = {
  admin: SupabaseClient;
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

async function monthlyUsage(admin: SupabaseClient, orgId: string) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const { data, error } = await admin
    .from("ai_usage_events")
    .select("total_tokens")
    .eq("org_id", orgId)
    .gte("created_at", since.toISOString());

  if (error) {
    return 0;
  }

  return (data ?? []).reduce((sum, row: any) => sum + Number(row.total_tokens ?? 0), 0);
}

async function assertTokenBudget(
  admin: SupabaseClient,
  orgId: string,
  estimatedPromptTokens: number,
) {
  if (!env.AI_TOKEN_BUDGET_ENFORCEMENT) return;

  const budget = unwrapNullable(
    await admin.from("ai_token_budgets").select("*").eq("org_id", orgId).maybeSingle(),
  ) as { monthly_token_limit?: number; hard_limit_enabled?: boolean } | null;

  if (!budget?.monthly_token_limit || budget.hard_limit_enabled === false) return;

  const used = await monthlyUsage(admin, orgId);
  if (used + estimatedPromptTokens > budget.monthly_token_limit) {
    throw errors.tooManyRequests("Monthly AI token budget exceeded", {
      used,
      estimatedPromptTokens,
      monthlyLimit: budget.monthly_token_limit,
    });
  }
}

async function recordUsage(
  admin: SupabaseClient,
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

  await admin
    .from("ai_usage_events")
    .insert({
      org_id: input.orgId,
      user_id: input.userId,
      feature: input.feature,
      model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      latency_ms: Math.round(latencyMs),
      status,
      meta: {
        ...input.metadata,
        error: error instanceof Error ? error.message : undefined,
      },
    })
    .throwOnError();
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

  await assertTokenBudget(input.admin, input.orgId, estimateTokens(input.messages));

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

    await recordUsage(input.admin, input, result, performance.now() - start, "success");
    return result;
  } catch (error) {
    await recordUsage(
      input.admin,
      input,
      undefined,
      performance.now() - start,
      "error",
      error,
    ).catch(() => undefined);
    throw error;
  }
}

export async function getCaseContext(supabase: SupabaseClient, caseId: string) {
  const legalCase = unwrap(
    await supabase
      .from("cases")
      .select(
        "*, clients(name, type), case_parties(*), case_notes(body, created_at), case_events(*)",
      )
      .eq("id", caseId)
      .single(),
  );

  return legalCase;
}
