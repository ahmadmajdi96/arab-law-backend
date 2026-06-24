import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("app", () => {
  it("serves health checks", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "arab-law-backend" });
  });
});
