import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { payments, quotes, taxInvoices, timeEntries } from "../db/schema.js";
import { getRequestMembership, insertActivity, nextDocumentNumber } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const money = z.union([z.number(), z.string()]).transform((value) => String(value));
const items = z.array(z.record(z.unknown())).default([]);

export async function registerBillingRoutes(app: FastifyInstance) {
  app.post("/v1/time/start", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        description: z.string().min(1),
        case_id: z.string().uuid().optional(),
        client_id: z.string().uuid().optional(),
        started_at: z.string().datetime().optional(),
        billable: z.boolean().default(true),
        hourly_rate: money.optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    );
    const [entry] = await app.db
      .insert(timeEntries)
      .values({
        orgId: membership.orgId,
        userId: request.auth!.userId,
        caseId: body.case_id,
        clientId: body.client_id,
        description: body.description,
        startedAt: body.started_at ? new Date(body.started_at) : new Date(),
        billable: body.billable,
        hourlyRate: body.hourly_rate,
        metadata: body.metadata ?? {},
      })
      .returning();
    return data(entry);
  });

  app.post("/v1/time/:id/stop", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const stoppedAt = new Date();
    const [existing] = await app.db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.id, id), eq(timeEntries.orgId, membership.orgId)))
      .limit(1);
    if (!existing) throw errors.notFound("Time entry not found");
    const minutes = Math.max(
      1,
      Math.round((stoppedAt.getTime() - existing.startedAt.getTime()) / 60000),
    );
    const [entry] = await app.db
      .update(timeEntries)
      .set({ endedAt: stoppedAt, minutes })
      .where(eq(timeEntries.id, id))
      .returning();
    return data(entry);
  });

  app.get("/v1/time", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(request, z.object({ ...paginationSchema }));
    const rows = await app.db
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.orgId, membership.orgId))
      .orderBy(desc(timeEntries.startedAt))
      .limit(query.limit)
      .offset(query.offset);
    return data(rows);
  });

  app.post("/v1/quotes", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        client_id: z.string().uuid().optional(),
        amount: money,
        currency: z.string().default("JOD"),
        items,
      }),
    );
    const number = await nextDocumentNumber(app.db, {
      orgId: membership.orgId,
      kind: "quote",
      prefix: "QTE",
    });
    const [quote] = await app.db
      .insert(quotes)
      .values({
        orgId: membership.orgId,
        clientId: body.client_id,
        number,
        amount: body.amount,
        currency: body.currency,
        items: body.items,
        createdBy: request.auth!.userId,
      })
      .returning();
    return data(quote);
  });

  app.post("/v1/invoices", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        client_id: z.string().uuid().optional(),
        quote_id: z.string().uuid().optional(),
        amount: money,
        currency: z.string().default("JOD"),
        due_at: z.string().datetime().optional(),
        items,
      }),
    );
    const number = await nextDocumentNumber(app.db, {
      orgId: membership.orgId,
      kind: "invoice",
      prefix: "INV",
    });
    const [invoice] = await app.db
      .insert(taxInvoices)
      .values({
        orgId: membership.orgId,
        clientId: body.client_id,
        quoteId: body.quote_id,
        number,
        amount: body.amount,
        currency: body.currency,
        dueAt: body.due_at ? new Date(body.due_at) : undefined,
        items: body.items,
        createdBy: request.auth!.userId,
      })
      .returning();

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "tax_invoice",
      entityId: invoice?.id,
      action: "created",
    });

    return data(invoice);
  });

  app.patch("/v1/invoices/:id/status", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(request, z.object({ status: z.string().min(1) }));
    const [invoice] = await app.db
      .update(taxInvoices)
      .set({ status: body.status, updatedAt: new Date() })
      .where(and(eq(taxInvoices.id, id), eq(taxInvoices.orgId, membership.orgId)))
      .returning();
    if (!invoice) throw errors.notFound("Invoice not found");
    return data(invoice);
  });

  app.post("/v1/invoices/:id/payments", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        amount: money,
        method: z.string().default("manual"),
        reference: z.string().optional(),
        paid_at: z.string().datetime().optional(),
        provider_payload: z.record(z.unknown()).optional(),
      }),
    );
    const [payment] = await app.db
      .insert(payments)
      .values({
        orgId: membership.orgId,
        invoiceId: id,
        amount: body.amount,
        method: body.method,
        reference: body.reference,
        paidAt: body.paid_at ? new Date(body.paid_at) : new Date(),
        recordedBy: request.auth!.userId,
        providerPayload: body.provider_payload,
      })
      .returning();

    await app.db
      .update(taxInvoices)
      .set({ status: "paid", paidAmount: body.amount, updatedAt: new Date() })
      .where(and(eq(taxInvoices.id, id), eq(taxInvoices.orgId, membership.orgId)));

    return data(payment);
  });
}
