import { count, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { activityLog, appointments, cases, clients, deadlines, taxInvoices } from "../db/schema.js";
import { getRequestMembership } from "../utils/db.js";
import { data } from "../utils/serialize.js";

async function countRows(app: FastifyInstance, table: any, orgId: string, extra?: any) {
  const [row] = await app.db
    .select({ value: count() })
    .from(table)
    .where(extra ?? eq(table.orgId, orgId));
  return Number(row?.value ?? 0);
}

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get("/v1/dashboard", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const orgId = membership.orgId;
    const [openCases, upcomingDeadlines, invoices, upcomingAppointments, recentActivity] =
      await Promise.all([
        countRows(
          app,
          cases,
          orgId,
          sql`${cases.orgId} = ${orgId} and ${cases.status} <> 'closed'`,
        ),
        countRows(
          app,
          deadlines,
          orgId,
          sql`${deadlines.orgId} = ${orgId} and ${deadlines.status} = 'open'`,
        ),
        countRows(
          app,
          taxInvoices,
          orgId,
          sql`${taxInvoices.orgId} = ${orgId} and ${taxInvoices.status} in ('sent', 'overdue')`,
        ),
        countRows(app, appointments, orgId),
        app.db
          .select()
          .from(activityLog)
          .where(eq(activityLog.orgId, orgId))
          .orderBy(desc(activityLog.createdAt))
          .limit(10),
      ]);

    return data({
      openCases,
      upcomingDeadlines,
      openInvoices: invoices,
      upcomingAppointments,
      recentActivity,
    });
  });

  app.get("/v1/analytics", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const orgId = membership.orgId;
    const [caseTotals, invoiceTotals, clientTotals] = await Promise.all([
      app.db
        .select({ status: cases.status, total: count() })
        .from(cases)
        .where(eq(cases.orgId, orgId))
        .groupBy(cases.status),
      app.db
        .select({
          status: taxInvoices.status,
          total: count(),
          amount: sql<string>`coalesce(sum(${taxInvoices.amount}), 0)`,
        })
        .from(taxInvoices)
        .where(eq(taxInvoices.orgId, orgId))
        .groupBy(taxInvoices.status),
      app.db.select({ total: count() }).from(clients).where(eq(clients.orgId, orgId)),
    ]);

    return data({
      cases: caseTotals,
      invoices: invoiceTotals,
      clients: Number(clientTotals[0]?.total ?? 0),
    });
  });
}
