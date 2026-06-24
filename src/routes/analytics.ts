import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, unwrap } from "../utils/supabase.js";
import { parseQuery } from "../utils/validation.js";

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get("/v1/dashboard", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [cases, deadlines, invoices, appointments, activity] = await Promise.all([
      request
        .supabase!.from("cases")
        .select("id", { count: "exact", head: true })
        .eq("status", "open"),
      request
        .supabase!.from("deadlines")
        .select("*")
        .eq("org_id", membership.org_id)
        .gte("due_at", now.toISOString())
        .lte("due_at", week.toISOString())
        .order("due_at", { ascending: true })
        .limit(10),
      request
        .supabase!.from("tax_invoices")
        .select("total,status")
        .eq("org_id", membership.org_id)
        .in("status", ["issued", "overdue"]),
      request
        .supabase!.from("appointments")
        .select("*")
        .eq("org_id", membership.org_id)
        .gte("starts_at", now.toISOString())
        .order("starts_at", { ascending: true })
        .limit(10),
      request
        .supabase!.from("activity_log")
        .select("*")
        .eq("org_id", membership.org_id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    const unpaidInvoicesTotal = (invoices.data ?? []).reduce(
      (sum: number, invoice: any) => sum + Number(invoice.total ?? 0),
      0,
    );

    return {
      data: {
        openCases: cases.count ?? 0,
        deadlinesThisWeek: deadlines.data ?? [],
        unpaidInvoicesTotal,
        upcomingAppointments: appointments.data ?? [],
        recentActivity: activity.data ?? [],
      },
    };
  });

  app.get("/v1/analytics", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const query = parseQuery(
      request,
      z.object({
        from: z.string().datetime(),
        to: z.string().datetime(),
      }),
    );

    const [cases, invoices, clients] = await Promise.all([
      request
        .supabase!.from("cases")
        .select("status, opened_at")
        .eq("org_id", membership.org_id)
        .gte("created_at", query.from)
        .lte("created_at", query.to),
      request
        .supabase!.from("tax_invoices")
        .select("status,total,created_at,client_id")
        .eq("org_id", membership.org_id)
        .gte("created_at", query.from)
        .lte("created_at", query.to),
      request.supabase!.from("clients").select("id,name").eq("org_id", membership.org_id),
    ]);

    return {
      data: {
        casesByStatus: groupCount(unwrap(cases) as any[], "status"),
        invoicesByStatus: groupCount(unwrap(invoices) as any[], "status"),
        revenueByMonth: groupSumByMonth(unwrap(invoices) as any[], "created_at", "total"),
        topClients: topClients(unwrap(invoices) as any[], unwrap(clients) as any[]),
      },
    };
  });
}

function groupCount(rows: any[], key: string) {
  return Object.entries(
    rows.reduce<Record<string, number>>((acc, row) => {
      const value = row[key] ?? "unknown";
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([name, value]) => ({ name, value }));
}

function groupSumByMonth(rows: any[], dateKey: string, valueKey: string) {
  return Object.entries(
    rows.reduce<Record<string, number>>((acc, row) => {
      const month = String(row[dateKey] ?? "").slice(0, 7);
      acc[month] = (acc[month] ?? 0) + Number(row[valueKey] ?? 0);
      return acc;
    }, {}),
  ).map(([month, total]) => ({ month, total }));
}

function topClients(invoices: any[], clients: any[]) {
  const names = new Map(clients.map((client) => [client.id, client.name]));
  const totals = invoices.reduce<Record<string, number>>((acc, invoice) => {
    acc[invoice.client_id] = (acc[invoice.client_id] ?? 0) + Number(invoice.total ?? 0);
    return acc;
  }, {});

  return Object.entries(totals)
    .map(([client_id, total]) => ({ client_id, name: names.get(client_id) ?? "Unknown", total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
}
