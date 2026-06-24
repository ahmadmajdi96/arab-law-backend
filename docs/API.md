# API Reference

Base URL in Docker: `http://localhost:5556`.

Interactive docs: `/docs`.

## Conventions

- JSON request bodies use `Content-Type: application/json`.
- Do not send `Content-Type: application/json` with an empty body.
- All authenticated routes require `Authorization: Bearer <access_token>`.
- Tenant-scoped routes accept `x-org-id: <organization_uuid>`. If omitted, the first active organization membership for the authenticated user is used.
- IDs are UUIDs unless the route explicitly says otherwise.
- Datetimes are ISO 8601 strings.
- List endpoints use `limit` and `offset`.
  - `limit`: integer `1-250`, default `50`
  - `offset`: integer `>=0`, default `0`
- Successful standard responses are wrapped as:

```json
{
  "data": {}
}
```

- AI routes return:

```json
{
  "data": {},
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

- Error responses are:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Validation failed",
    "details": {},
    "requestId": "req-1"
  }
}
```

Common error codes:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `BAD_REQUEST` | Validation failed or invalid payload. |
| 401 | `UNAUTHORIZED` | Missing/invalid JWT, cron token, or webhook signature. |
| 403 | `FORBIDDEN` | Authenticated user has no active membership or insufficient role. |
| 404 | `NOT_FOUND` | Resource is absent or outside the selected organization. |
| 409 | `CONFLICT` | Unique resource conflict such as duplicate email. |
| 429 | `TOO_MANY_REQUESTS` | Rate limit or AI token budget exceeded. |
| 502 | `UPSTREAM_ERROR` | External provider error from Novita or ElevenLabs. |
| 503 | `SERVICE_UNAVAILABLE` | Required dependency or API key missing. |

## Health And Metrics

| Method | Path | Auth | Details |
| --- | --- | --- | --- |
| `GET` | `/health` | No | Returns `{ status, service, timestamp }`. Liveness only. |
| `GET` | `/ready` | No | Checks PostgreSQL and S3 bucket. Returns `{ status: "ready" | "degraded", checks, timestamp }`. |
| `GET` | `/metrics` | No | Prometheus text exposition with Node, HTTP, AI, and job metrics. |

## Authentication

### `POST /v1/auth/register`

Creates a user, organization, owner membership, activity event, and access token.

Body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | email string | Yes | Lowercased and unique. |
| `password` | string | Yes | `10-200` characters. Stored as scrypt hash. |
| `full_name` | string | No | Max `160`. |
| `organization_name` | string | No | Max `160`; defaults to user's organization. |

Response data:

- `user.id`
- `user.email`
- `user.full_name`
- `user.avatar_url`
- `user.status`
- `access_token`
- `token_type: "Bearer"`

### `POST /v1/auth/login`

Body:

| Field | Type | Required |
| --- | --- | --- |
| `email` | email string | Yes |
| `password` | string | Yes |

Returns the same auth payload as register and updates `last_login_at`.

### `GET /v1/auth/me`

Auth required. Returns:

- `user`
- `memberships[]`
  - `membership`
  - `organization`

### `POST /v1/auth/refresh`

Auth required. Verifies the current token and returns a new access token payload.

### `POST /v1/auth/accept-invite`

Auth required. Accepts an organization invite for the authenticated user's email.

Body:

| Field | Type | Required |
| --- | --- | --- |
| `token` | string | Yes, min `24` |

Returns the joined membership and organization.

## Organizations

### `GET /v1/org/current`

Auth required. Uses `x-org-id` if present. Returns the selected active membership and organization.

### `POST /v1/orgs`

Auth required. Creates a new organization and owner membership.

Body:

| Field | Type | Default |
| --- | --- | --- |
| `name` | string `1-160` | Required |
| `locale` | string | `ar-JO` |
| `timezone` | string | `Asia/Amman` |

### `PATCH /v1/orgs/:id`

Auth required. Requires `owner` or `partner` role in the target org.

Body fields:

- `name?: string`
- `locale?: string`
- `timezone?: string`
- `metadata?: object`

## Team

### `GET /v1/team`

Auth required. Returns organization members with public user fields.

### `POST /v1/team/invites`

Auth required. Requires `owner` or `partner`.

Body:

| Field | Type | Default |
| --- | --- | --- |
| `email` | email string | Required |
| `role` | `owner`, `partner`, `associate`, `paralegal`, `client` | `associate` |

Returns invite data, `organization_name`, and `invite_url`.

### `PATCH /v1/team/:id/role`

Auth required. Requires `owner` or `partner`.

Body:

| Field | Type | Required |
| --- | --- | --- |
| `role` | `owner`, `partner`, `associate`, `paralegal`, `client` | Yes |

### `DELETE /v1/team/:id`

Auth required. Requires `owner` or `partner`. Removes an organization membership.

## Clients

### `GET /v1/clients`

Auth required.

Query:

| Field | Type | Notes |
| --- | --- | --- |
| `q` | string | Searches `name` and `email`. |
| `limit` | number | Default `50`, max `250`. |
| `offset` | number | Default `0`. |

Returns clients ordered by newest first.

### `GET /v1/clients/:id`

Auth required. Returns one client in the selected organization.

### `POST /v1/clients`

Auth required.

Body:

| Field | Type | Default |
| --- | --- | --- |
| `name` | string `1-240` | Required |
| `type` | string | `individual` |
| `email` | email string | Optional |
| `phone` | string | Optional |
| `national_id` | string | Optional |
| `address` | string | Optional |
| `notes` | string | Optional |
| `owner_id` | UUID | Authenticated user |
| `metadata` | object | `{}` |

Creates an activity log entry.

### `PATCH /v1/clients/:id`

Auth required. Same body as create, all fields optional. Creates an activity log entry.

### `DELETE /v1/clients/:id`

Auth required. Deletes the client and writes an activity log entry.

### `POST /v1/clients/:id/interactions`

Auth required.

Body:

| Field | Type | Default |
| --- | --- | --- |
| `channel` | string | `note` |
| `summary` | string | Required |
| `occurred_at` | ISO datetime | Now |
| `metadata` | object | `{}` |

## Cases

### `GET /v1/cases`

Auth required.

Query:

- `status?: string`
- `clientId?: UUID`
- `limit?: number`
- `offset?: number`

Returns cases ordered by newest first.

### `GET /v1/cases/:id`

Auth required. Returns the case plus:

- `parties`
- `notes`
- `events`
- `members`

### `POST /v1/cases`

Auth required.

Body:

| Field | Type | Default |
| --- | --- | --- |
| `client_id` | UUID | Optional |
| `title` | string `1-240` | Required |
| `case_number` | string | Optional |
| `type` | string | `general` |
| `status` | string | `open` |
| `court` | string | Optional |
| `judge` | string | Optional |
| `opponent` | string | Optional |
| `opened_at` | ISO datetime | Now |
| `closed_at` | ISO datetime | Optional |
| `responsible_lawyer` | UUID | Authenticated user |
| `metadata` | object | `{}` |

Also inserts the authenticated user as case owner in `case_members`.

### `PATCH /v1/cases/:id`

Auth required. Same fields as create, all optional.

### `DELETE /v1/cases/:id`

Auth required. Deletes the case and writes activity.

### `POST /v1/cases/:id/parties`

Auth required.

Body:

- `name: string`
- `role: string`
- `contact?: string`
- `metadata?: object`

### `POST /v1/cases/:id/notes`

Auth required.

Body:

- `body: string`
- `visibility?: string`, default `internal`

### `POST /v1/cases/:id/sessions`

Auth required. Creates a case event/session.

Body:

- `title: string`
- `kind?: string`, default `session`
- `starts_at: ISO datetime`
- `ends_at?: ISO datetime`
- `location?: string`
- `notes?: string`
- `metadata?: object`

### `POST /v1/cases/:id/members`

Auth required. Adds or updates a case member.

Body:

- `user_id: UUID`
- `role?: string`, default `member`

## Documents And Storage

### `GET /v1/documents`

Auth required.

Query:

- `caseId?: UUID`
- `clientId?: UUID`
- `limit?: number`
- `offset?: number`

Returns document metadata plus `signed_url` for each item, valid for `3600` seconds.

### `POST /v1/documents/upload-url`

Auth required. Generates a direct S3/MinIO upload URL.

Body:

- `filename: string`
- `content_type: string`
- `case_id?: UUID`

Response data:

- `storage_path`
- `signed_url`
- `method: "PUT"`
- `expires_in: 900`

### `POST /v1/documents`

Auth required. Creates metadata after bytes have been uploaded.

Body:

| Field | Type | Default |
| --- | --- | --- |
| `name` | string `1-240` | Required |
| `case_id` | UUID | Optional |
| `client_id` | UUID | Optional |
| `mime` | string | Required |
| `size` | non-negative integer | Required |
| `storage_path` | string | Required |
| `kind` | string | `file` |
| `metadata` | object | `{}` |

### `POST /v1/documents/:id/signed-url`

Auth required. Creates a signed download URL.

Body:

- `expires?: number`, `60-86400`, default `3600`
- `download?: boolean`, default `false`

### `DELETE /v1/documents/:id`

Auth required. Deletes metadata and the S3 object.

### `GET /v1/documents/:id/versions`

Auth required. Lists document versions.

### `POST /v1/documents/:id/versions`

Auth required.

Body:

- `storage_path: string`
- `size: non-negative integer`
- `note?: string`

### `POST /v1/documents/:id/shares`

Auth required. Creates a public share token.

Body:

- `expires_at: ISO datetime`
- `allow_download?: boolean`, default `false`

Response includes `public_url`, for example `/share/<token>`.

### `GET /share/:token`

No auth. If the share exists and is unexpired, redirects to a short-lived signed S3 URL. Otherwise returns `404`.

## Calendar And Deadlines

### `GET /v1/appointments`

Auth required. Supports `limit` and `offset`.

### `POST /v1/appointments`

Auth required.

Body:

- `title: string`
- `starts_at: ISO datetime`
- `ends_at?: ISO datetime`
- `case_id?: UUID`
- `client_id?: UUID`
- `owner_id?: UUID`, default authenticated user
- `location?: string`
- `notes?: string`
- `metadata?: object`

### `PATCH /v1/appointments/:id`

Auth required. Optional fields:

- `title`
- `starts_at`
- `ends_at`
- `location`
- `notes`
- `metadata`

### `DELETE /v1/appointments/:id`

Auth required. Deletes one appointment.

### `GET /v1/deadlines`

Auth required.

Query:

- `status?: string`
- `limit?: number`
- `offset?: number`

### `POST /v1/deadlines`

Auth required. Also creates a notification for the assignee.

Body:

- `title: string`
- `due_at: ISO datetime`
- `case_id?: UUID`
- `assignee_id?: UUID`, default authenticated user
- `priority?: string`, default `normal`
- `metadata?: object`

### `PATCH /v1/deadlines/:id`

Auth required. Optional fields:

- `title`
- `due_at`
- `status`
- `priority`
- `metadata`

### `POST /v1/deadlines/:id/complete`

Auth required. Sets `status=completed`, `completed_at=now`, and updates `updated_at`.

## Notifications

### `GET /v1/notifications`

Auth required.

Query:

- `unread?: boolean`
- `limit?: number`
- `offset?: number`

Returns only notifications for the authenticated user in the selected organization.

### `POST /v1/notifications`

Auth required. Creates a notification.

Body:

- `user_id: UUID`
- `title: string`
- `body: string`
- `kind?: string`, default `info`
- `metadata?: object`

### `POST /v1/notifications/:id/read`

Auth required. Marks one notification as read.

### `POST /v1/notifications/read-all`

Auth required. Marks unread notifications for the authenticated user as read. Returns `{ updated }`.

## Billing And Time

### `POST /v1/time/start`

Auth required.

Body:

- `description: string`
- `case_id?: UUID`
- `client_id?: UUID`
- `started_at?: ISO datetime`, default now
- `billable?: boolean`, default `true`
- `hourly_rate?: number|string`
- `metadata?: object`

### `POST /v1/time/:id/stop`

Auth required. Sets `ended_at=now` and calculates at least one minute.

### `GET /v1/time`

Auth required. Supports `limit` and `offset`.

### `POST /v1/quotes`

Auth required. Creates a quote number like `QTE-2026-000001`.

Body:

- `client_id?: UUID`
- `amount: number|string`
- `currency?: string`, default `JOD`
- `items?: object[]`, default `[]`

### `POST /v1/invoices`

Auth required. Creates an invoice number like `INV-2026-000001`.

Body:

- `client_id?: UUID`
- `quote_id?: UUID`
- `amount: number|string`
- `currency?: string`, default `JOD`
- `due_at?: ISO datetime`
- `items?: object[]`, default `[]`

### `PATCH /v1/invoices/:id/status`

Auth required.

Body:

- `status: string`

### `POST /v1/invoices/:id/payments`

Auth required. Inserts a payment and marks the invoice `paid`.

Body:

- `amount: number|string`
- `method?: string`, default `manual`
- `reference?: string`
- `paid_at?: ISO datetime`, default now
- `provider_payload?: object`

## Drafts

### `GET /v1/drafts`

Auth required.

Query:

- `caseId?: UUID`
- `limit?: number`
- `offset?: number`

### `POST /v1/drafts`

Auth required.

Body:

- `title: string`
- `kind?: string`, default `memo`
- `content?: string`, default empty string
- `case_id?: UUID`
- `metadata?: object`

### `POST /v1/drafts/generate`

Auth required. Calls Novita AI, stores the generated draft, records token usage, and returns the draft plus `usage`.

Body:

- `title: string`
- `kind?: string`, default `memo`
- `prompt: string`
- `case_id?: UUID`
- `model?: string`

### `GET /v1/drafts/:id`

Auth required. Returns one draft.

### `PATCH /v1/drafts/:id`

Auth required.

Body:

- `title?: string`
- `content?: string`
- `status?: string`
- `metadata?: object`

### `DELETE /v1/drafts/:id`

Auth required. Deletes one draft.

## AI

All AI endpoints require `NOVITA_API_KEY` and record metrics plus `ai_usage_events`.

### `POST /v1/ai/research/jordan`

Auth required. Performs Jordanian legal research with source/citation caution.

Body:

- `query: string`, min `3`
- `language?: "ar" | "en"`, default `ar`
- `model?: string`

Returns parsed JSON when the model responds with JSON; otherwise returns `{ answer, citations, confidence, caveats }`.

### `POST /v1/ai/cases/:caseId/summarize`

Auth required. Builds case context from case, client, parties, notes, and events, then asks Novita for a lawyer-focused summary.

### `POST /v1/ai/cases/:caseId/next-steps`

Auth required. Builds case context and asks Novita for ordered next actions, deadlines, needed documents, and risk notes.

### `POST /v1/ai/documents/:documentId/extract-text`

Auth required. Creates a 5-minute signed download URL and asks Novita to extract text from the document URL.

### `GET /v1/ai/usage`

Auth required.

Query:

- `from?: ISO datetime`
- `to?: ISO datetime`

Returns:

- `totals.prompt_tokens`
- `totals.completion_tokens`
- `totals.total_tokens`
- `events[]`, up to latest `1000`

## Courtroom Simulation

### `POST /v1/courtroom/simulations`

Auth required.

Body:

- `case_id: UUID`
- `scenario: string`
- `role: "plaintiff" | "defendant" | "judge" | "witness"`

### `POST /v1/courtroom/simulations/:id/turn`

Auth required. Sends a new user turn to Novita and appends both user and assistant messages to the simulation transcript.

Body:

- `user_message: string`

Returns updated simulation and AI usage.

## Meetings And Live Sessions

### `POST /v1/meetings`

Auth required. Creates a meeting room and a host JWT.

Body:

- `title: string`
- `case_id?: UUID`
- `starts_at?: ISO datetime`, default now
- `metadata?: object`

Response:

- `meeting`
- `token`, valid for `2h`

### `POST /v1/meetings/:room/join`

Auth required. Returns meeting data and participant JWT for the room.

### `POST /v1/meetings/:id/end`

Auth required. Sets meeting status to `ended`, sets `ended_at`, and updates timestamp.

### `POST /v1/live-sessions`

Auth required.

Body:

- `title: string`
- `case_id?: UUID`

### `POST /v1/live-sessions/:id/transcript`

Auth required. Appends transcript text.

Body:

- `speaker: string`
- `text: string`
- `at?: ISO datetime`, default now

## Analytics

### `GET /v1/dashboard`

Auth required. Returns:

- `open_cases`
- `upcoming_deadlines`
- `open_invoices`
- `upcoming_appointments`
- `recent_activity`, latest 10 activity rows

### `GET /v1/analytics`

Auth required. Returns grouped case counts, invoice counts/sums, and client total.

## Public And Operational Endpoints

### `POST /api/public/webhooks/payments`

No JWT. Requires `x-signature` or `x-webhook-signature` HMAC SHA-256 over the raw body using `PAYMENT_WEBHOOK_SECRET`.

Body:

- `invoice_id: UUID`
- `org_id: UUID`
- `amount: positive number`
- `method?: string`, default `webhook`
- `paid_at?: ISO datetime`
- `reference?: string`
- `provider_payload?: object`

Creates a payment and marks the invoice paid.

### `POST /api/public/cron/mark-overdue`

Requires `Authorization: Bearer <CRON_SECRET>`.

Marks sent invoices with past due dates as `overdue`, enqueues `billing/overdue-sweep`, and returns `{ ok, updated }`.

### `POST /api/public/cron/send-reminders`

Requires `Authorization: Bearer <CRON_SECRET>`.

Enqueues `notifications/send-due-reminders`.

### `POST /api/public/monitoring/novita-smoke`

Requires `Authorization: Bearer <CRON_SECRET>`.

Performs a real Novita AI call and records AI request/token metrics. Use this sparingly because it spends provider credits.

Body:

- `model?: string`, default `AI_DEFAULT_MODEL`
- `prompt?: string`, default `Reply with exactly: arab.law monitoring ok`, max `500`
- `max_tokens?: integer`, default `16`, range `1-64`

Response:

- `ok`
- `model`
- `latency_ms`
- `usage.prompt_tokens`
- `usage.completion_tokens`
- `usage.total_tokens`
- `text`

### `GET /api/elevenlabs/scribe-token`

Auth required. Requires `ELEVENLABS_API_KEY`. Mints a short-lived token from `ELEVENLABS_SCRIBE_TOKEN_URL` with:

- `user_id`: authenticated user ID
- `ttl_seconds`: `300`

## Frontend Integration Checklist

1. Set the frontend backend base URL to `http://localhost:5556` locally or the production HTTPS host.
2. Register or login through `/v1/auth/*`.
3. Store the returned `access_token`.
4. Send `Authorization: Bearer <token>` for all protected routes.
5. After `/v1/auth/me`, choose an organization from `memberships`.
6. Send `x-org-id` on tenant-scoped requests.
7. Upload files through the signed URL flow.
8. Use `/v1/ai/usage` and Grafana for token monitoring.
