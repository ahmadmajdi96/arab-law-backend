import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmacSha256 } from "../src/utils/security.js";

describe("verifyHmacSha256", () => {
  it("accepts matching sha256 signatures", () => {
    const secret = "super-secret";
    const payload = JSON.stringify({ invoice_id: "inv_1" });
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

    expect(verifyHmacSha256({ payload, signature, secret })).toBe(true);
  });

  it("rejects mismatched signatures", () => {
    expect(
      verifyHmacSha256({
        payload: "hello",
        signature: "sha256=deadbeef",
        secret: "super-secret",
      }),
    ).toBe(false);
  });
});
