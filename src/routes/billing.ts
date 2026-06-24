import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentMembership, insertActivity, unwrap } from "../utils/supabase.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const lineSchema = z.object({
  desc: z.string().min(1),
  qty: z.number().positive(),
  unit_price: z.number().nonnegative(),
});

function totals(lines: z.infer<typeof lineSchema>[], taxRate: number) {
  const subtotal = lines.reduce((sum, line) => sum + line.qty * line.unit_price, 0);
  const tax = subtotal * (taxRate / 100);
  return {
    subtotal,
    tax,
    total: subtotal + tax,
  };
}

export async function registerBillingRoutes(app: FastifyInstance) {
  app.post("/v1/time/start", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        case_id: z.string().uuid().optional(),
        client_id: z.string().uuid().optional(),
        description: z.string().min(1),
      }),
    );
    const entry = unwrap(
      await request
        .supabase!.from("time_entries")
        .insert({
          ...body,
          org_id: membership.org_id,
          user_id: request.auth!.userId,
          started_at: new Date().toISOString(),
          status: "running",
        })
        .select("*")
        .single(),
    );
    return { data: entry };
  });

  app.post("/v1/time/:id/stop", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const current = unwrap(
      await request.supabase!.from("time_entries").select("*").eq("id", id).single(),
    ) as any;
    const endedAt = new Date();
    const startedAt = new Date(current.started_at);
    const durationSeconds = Math.max(
      0,
      Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
    );
    const entry = unwrap(
      await request
        .supabase!.from("time_entries")
        .update({
          ended_at: endedAt.toISOString(),
          duration_seconds: durationSeconds,
          status: "stopped",
        })
        .eq("id", id)
        .select("*")
        .single(),
    );
    return { data: entry };
  });

  app.get("/v1/time", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        userId: z.string().uuid().optional(),
        caseId: z.string().uuid().optional(),
        ...paginationSchema,
      }),
    );
    let builder = request
      .supabase!.from("time_entries")
      .select("*")
      .order("started_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);
    if (query.from) builder = builder.gte("started_at", query.from);
    if (query.to) builder = builder.lte("started_at", query.to);
    if (query.userId) builder = builder.eq("user_id", query.userId);
    if (query.caseId) builder = builder.eq("case_id", query.caseId);
    return { data: unwrap(await builder) };
  });

  app.post("/v1/quotes", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        client_id: z.string().uuid(),
        case_id: z.string().uuid().optional(),
        lines: z.array(lineSchema).min(1),
        tax_rate: z.number().min(0).max(100).default(16),
        valid_until: z.string().datetime(),
      }),
    );
    const numberResult = await request.supabase!.rpc("next_doc_number", {
      p_org_id: membership.org_id,
      p_kind: "quote",
    });
    const quote = unwrap(
      await request
        .supabase!.from("quotes")
        .insert({
          ...body,
          ...totals(body.lines, body.tax_rate),
          org_id: membership.org_id,
          number: numberResult.data,
          status: "draft",
          created_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );
    return { data: quote };
  });

  app.post("/v1/invoices", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        client_id: z.string().uuid(),
        case_id: z.string().uuid().optional(),
        lines: z.array(lineSchema).min(1),
        tax_rate: z.number().min(0).max(100).default(16),
        due_date: z.string().datetime(),
        currency: z.string().default("JOD"),
      }),
    );
    const numberResult = await request.supabase!.rpc("next_doc_number", {
      p_org_id: membership.org_id,
      p_kind: "invoice",
    });
    const invoice = unwrap(
      await request
        .supabase!.from("tax_invoices")
        .insert({
          ...body,
          ...totals(body.lines, body.tax_rate),
          org_id: membership.org_id,
          number: numberResult.data,
          status: "draft",
          created_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "invoice",
      entity_id: (invoice as any).id,
      action: "created",
    });

    return { data: invoice };
  });

  app.patch("/v1/invoices/:id/status", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        status: z.enum(["draft", "issued", "paid", "overdue", "void"]),
      }),
    );
    const invoice = unwrap(
      await request
        .supabase!.from("tax_invoices")
        .update({ status: body.status })
        .eq("id", id)
        .select("*")
        .single(),
    );
    return { data: invoice };
  });

  app.post("/v1/invoices/:id/payments", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        amount: z.number().positive(),
        method: z.string().min(1),
        paid_at: z.string().datetime(),
        ref: z.string().optional(),
      }),
    );
    const payment = unwrap(
      await request
        .supabase!.from("payments")
        .insert({
          ...body,
          org_id: membership.org_id,
          invoice_id: id,
          recorded_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );
    return { data: payment };
  });
}
