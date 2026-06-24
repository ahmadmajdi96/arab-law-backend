import { describe, expect, it } from "vitest";
import { estimateTokens, novitaChatCompletionsUrl } from "../src/services/ai-gateway.js";

describe("estimateTokens", () => {
  it("returns a positive conservative estimate", () => {
    expect(estimateTokens("Jordanian legal research")).toBeGreaterThan(0);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("builds the Novita OpenAI-compatible chat completions URL", () => {
    expect(novitaChatCompletionsUrl("https://api.novita.ai/openai")).toBe(
      "https://api.novita.ai/openai/v1/chat/completions",
    );
    expect(novitaChatCompletionsUrl("https://api.novita.ai/openai/v1")).toBe(
      "https://api.novita.ai/openai/v1/chat/completions",
    );
  });
});
