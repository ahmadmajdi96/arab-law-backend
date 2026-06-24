import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const runIntegration = process.env.RUN_INTEGRATION === "1";

describe.runIf(runIntegration)("owned backend integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token = "";
  let orgId = "";
  let userId = "";
  let clientId = "";
  let caseId = "";
  let documentId = "";
  let invoiceId = "";
  let meetingId = "";
  let meetingRoom = "";
  let liveSessionId = "";

  const unique = randomUUID().slice(0, 8);

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<any> {
    const options: Record<string, unknown> = {
      method,
      url,
      headers: {
        authorization: token ? `Bearer ${token}` : "",
        "x-org-id": orgId,
      },
    };
    if (body !== undefined) {
      (options.headers as Record<string, string>)["content-type"] = "application/json";
      options.payload = JSON.stringify(body);
    }
    return await app.inject(options as any);
  }

  it("registers, logs in, and returns the current user", async () => {
    const register = await request("POST", "/v1/auth/register", {
      email: `integration-${unique}@example.com`,
      password: "integration-password-123",
      full_name: "Integration User",
      organization_name: `Integration Org ${unique}`,
    });
    expect(register.statusCode).toBe(200);
    const registerBody = register.json();
    token = registerBody.data.access_token;
    userId = registerBody.data.user.id;

    const me = await request("GET", "/v1/auth/me");
    expect(me.statusCode).toBe(200);
    orgId = me.json().data.memberships[0].membership.org_id;
    expect(orgId).toBeTruthy();

    const login = await request("POST", "/v1/auth/login", {
      email: `integration-${unique}@example.com`,
      password: "integration-password-123",
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().data.access_token).toBeTruthy();
  });

  it("manages clients and interactions", async () => {
    const created = await request("POST", "/v1/clients", {
      name: "Acme Legal Client",
      type: "company",
      email: `client-${unique}@example.com`,
    });
    expect(created.statusCode).toBe(200);
    clientId = created.json().data.id;

    expect((await request("GET", "/v1/clients")).statusCode).toBe(200);
    expect((await request("GET", `/v1/clients/${clientId}`)).statusCode).toBe(200);
    expect(
      (await request("PATCH", `/v1/clients/${clientId}`, { phone: "+962700000000" })).statusCode,
    ).toBe(200);
    expect(
      (
        await request("POST", `/v1/clients/${clientId}/interactions`, {
          channel: "call",
          summary: "Discussed onboarding",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("manages cases, parties, notes, sessions, and members", async () => {
    const created = await request("POST", "/v1/cases", {
      client_id: clientId,
      title: "Integration Case",
      type: "civil",
    });
    expect(created.statusCode).toBe(200);
    caseId = created.json().data.id;

    expect((await request("GET", "/v1/cases")).statusCode).toBe(200);
    expect((await request("GET", `/v1/cases/${caseId}`)).statusCode).toBe(200);
    expect(
      (await request("PATCH", `/v1/cases/${caseId}`, { court: "Amman Court" })).statusCode,
    ).toBe(200);
    expect(
      (
        await request("POST", `/v1/cases/${caseId}/parties`, {
          name: "Opponent",
          role: "defendant",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("POST", `/v1/cases/${caseId}/notes`, { body: "Initial note" })).statusCode,
    ).toBe(200);
    expect(
      (
        await request("POST", `/v1/cases/${caseId}/sessions`, {
          title: "First hearing",
          starts_at: new Date(Date.now() + 86400000).toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("POST", `/v1/cases/${caseId}/members`, { user_id: userId, role: "owner" }))
        .statusCode,
    ).toBe(200);
  });

  it("manages document storage metadata, versions, signed URLs, and shares", async () => {
    const upload = await request("POST", "/v1/documents/upload-url", {
      filename: "contract.pdf",
      content_type: "application/pdf",
      case_id: caseId,
    });
    expect(upload.statusCode).toBe(200);
    const storagePath = upload.json().data.storage_path;
    expect(upload.json().data.signed_url).toContain(storagePath);

    const created = await request("POST", "/v1/documents", {
      name: "contract.pdf",
      case_id: caseId,
      client_id: clientId,
      mime: "application/pdf",
      size: 1234,
      storage_path: storagePath,
    });
    expect(created.statusCode).toBe(200);
    documentId = created.json().data.id;

    expect((await request("GET", "/v1/documents")).statusCode).toBe(200);
    expect((await request("POST", `/v1/documents/${documentId}/signed-url`, {})).statusCode).toBe(
      200,
    );
    expect(
      (
        await request("POST", `/v1/documents/${documentId}/versions`, {
          storage_path: `${storagePath}.v2`,
          size: 1300,
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", `/v1/documents/${documentId}/versions`)).statusCode).toBe(200);

    const share = await request("POST", `/v1/documents/${documentId}/shares`, {
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      allow_download: true,
    });
    expect(share.statusCode).toBe(200);
    const publicUrl = share.json().data.public_url;
    const redirect = await app.inject({ method: "GET", url: publicUrl });
    expect([302, 303]).toContain(redirect.statusCode);
  });

  it("manages calendar, notifications, billing, drafts, meetings, and analytics", async () => {
    expect(
      (
        await request("POST", "/v1/appointments", {
          title: "Client meeting",
          starts_at: new Date(Date.now() + 7200000).toISOString(),
          client_id: clientId,
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", "/v1/appointments")).statusCode).toBe(200);

    const deadline = await request("POST", "/v1/deadlines", {
      title: "Submit filing",
      due_at: new Date(Date.now() + 172800000).toISOString(),
      case_id: caseId,
    });
    expect(deadline.statusCode).toBe(200);
    expect(
      (await request("POST", `/v1/deadlines/${deadline.json().data.id}/complete`)).statusCode,
    ).toBe(200);

    const notice = await request("POST", "/v1/notifications", {
      user_id: userId,
      title: "Manual notice",
      body: "Hello",
    });
    expect(notice.statusCode).toBe(200);
    expect(
      (await request("POST", `/v1/notifications/${notice.json().data.id}/read`)).statusCode,
    ).toBe(200);
    expect((await request("POST", "/v1/notifications/read-all")).statusCode).toBe(200);

    const time = await request("POST", "/v1/time/start", {
      description: "Research",
      case_id: caseId,
    });
    expect(time.statusCode).toBe(200);
    expect((await request("POST", `/v1/time/${time.json().data.id}/stop`)).statusCode).toBe(200);
    expect((await request("GET", "/v1/time")).statusCode).toBe(200);

    expect(
      (await request("POST", "/v1/quotes", { client_id: clientId, amount: 100 })).statusCode,
    ).toBe(200);
    const invoice = await request("POST", "/v1/invoices", { client_id: clientId, amount: 100 });
    expect(invoice.statusCode).toBe(200);
    invoiceId = invoice.json().data.id;
    expect(
      (await request("PATCH", `/v1/invoices/${invoiceId}/status`, { status: "sent" })).statusCode,
    ).toBe(200);
    expect(
      (await request("POST", `/v1/invoices/${invoiceId}/payments`, { amount: 100 })).statusCode,
    ).toBe(200);

    const draft = await request("POST", "/v1/drafts", {
      title: "Memo",
      kind: "memo",
      content: "Draft body",
      case_id: caseId,
    });
    expect(draft.statusCode).toBe(200);
    expect((await request("GET", `/v1/drafts/${draft.json().data.id}`)).statusCode).toBe(200);
    expect(
      (await request("PATCH", `/v1/drafts/${draft.json().data.id}`, { status: "review" }))
        .statusCode,
    ).toBe(200);

    const meeting = await request("POST", "/v1/meetings", {
      title: "Hearing prep",
      case_id: caseId,
    });
    expect(meeting.statusCode).toBe(200);
    meetingId = meeting.json().data.meeting.id;
    meetingRoom = meeting.json().data.meeting.room;
    expect((await request("POST", `/v1/meetings/${meetingRoom}/join`)).statusCode).toBe(200);
    expect((await request("POST", `/v1/meetings/${meetingId}/end`)).statusCode).toBe(200);

    const live = await request("POST", "/v1/live-sessions", {
      title: "Live notes",
      case_id: caseId,
    });
    expect(live.statusCode).toBe(200);
    liveSessionId = live.json().data.id;
    expect(
      (
        await request("POST", `/v1/live-sessions/${liveSessionId}/transcript`, {
          speaker: "Lawyer",
          text: "Opening transcript",
        })
      ).statusCode,
    ).toBe(200);

    expect((await request("GET", "/v1/dashboard")).statusCode).toBe(200);
    expect((await request("GET", "/v1/analytics")).statusCode).toBe(200);
    expect((await request("GET", "/v1/ai/usage")).statusCode).toBe(200);
  });
});
