import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDb } from "../db/client.js";
import {
  activityLog,
  documentCounters,
  organizationMembers,
  organizations,
  taxInvoices,
} from "../db/schema.js";
import { errors } from "./errors.js";

export type Membership = typeof organizationMembers.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

export function requestedOrgId(request: FastifyRequest) {
  const header = request.headers["x-org-id"];
  return Array.isArray(header) ? header[0] : header;
}

export async function getCurrentMembership(db: AppDb, userId: string, orgId?: string | undefined) {
  const filters = [
    eq(organizationMembers.userId, userId),
    eq(organizationMembers.status, "active"),
  ];

  if (orgId) filters.push(eq(organizationMembers.orgId, orgId));

  const [row] = await db
    .select({
      membership: organizationMembers,
      organization: organizations,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(...filters))
    .limit(1);

  if (!row) {
    throw errors.forbidden("No active organization membership for this request");
  }

  return row;
}

export async function getRequestMembership(db: AppDb, request: FastifyRequest) {
  if (!request.auth?.userId) throw errors.unauthorized();
  return getCurrentMembership(db, request.auth.userId, requestedOrgId(request));
}

export async function requireOrgRole(
  db: AppDb,
  userId: string,
  roles: string[],
  orgId?: string | undefined,
) {
  const row = await getCurrentMembership(db, userId, orgId);
  if (!roles.includes(row.membership.role)) {
    throw errors.forbidden(`Requires one of these organization roles: ${roles.join(", ")}`);
  }
  return row;
}

export async function insertActivity(
  db: AppDb,
  input: {
    orgId: string;
    userId?: string | null | undefined;
    entityType: string;
    entityId?: string | null | undefined;
    action: string;
    metadata?: Record<string, unknown> | undefined;
  },
) {
  await db.insert(activityLog).values({
    orgId: input.orgId,
    userId: input.userId ?? null,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    action: input.action,
    metadata: input.metadata ?? {},
  });
}

export async function nextDocumentNumber(
  db: AppDb,
  input: {
    orgId: string;
    kind: string;
    prefix: string;
    year?: number | undefined;
  },
) {
  const year = input.year ?? new Date().getUTCFullYear();
  const rows = await db.execute<{ last_number: number }>(sql`
    insert into ${documentCounters} (org_id, kind, year, last_number)
    values (${input.orgId}, ${input.kind}, ${year}, 1)
    on conflict (org_id, kind, year)
    do update set
      last_number = ${documentCounters.lastNumber} + 1,
      updated_at = now()
    returning last_number
  `);
  const next = Number(rows[0]?.last_number ?? 1);
  return `${input.prefix}-${year}-${String(next).padStart(6, "0")}`;
}

export async function markOverdueInvoices(db: AppDb) {
  const updated = await db
    .update(taxInvoices)
    .set({ status: "overdue", updatedAt: new Date() })
    .where(
      and(
        eq(taxInvoices.status, "sent"),
        sql`${taxInvoices.dueAt} is not null`,
        sql`${taxInvoices.dueAt} < now()`,
      ),
    )
    .returning({ id: taxInvoices.id });

  return updated.length;
}
