import { describe, expect, it } from "vitest";
import { toHttpError } from "../src/utils/errors.js";

describe("toHttpError", () => {
  it("preserves framework HTTP status codes", () => {
    const error = new Error("Rate limit exceeded") as Error & { statusCode: number };
    error.statusCode = 429;

    const httpError = toHttpError(error);

    expect(httpError.statusCode).toBe(429);
    expect(httpError.code).toBe("TOO_MANY_REQUESTS");
  });
});
