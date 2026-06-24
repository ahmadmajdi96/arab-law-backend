import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getCurrentMembership, insertActivity, unwrap } from "../utils/supabase.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const documentBodySchema = z.object({
  name: z.string().min(1).max(240),
  case_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  storage_path: z.string().min(1),
  kind: z.string().optional(),
});

export async function registerDocumentRoutes(app: FastifyInstance) {
  app.get("/v1/documents", { preHandler: app.requireAuth }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        caseId: z.string().uuid().optional(),
        clientId: z.string().uuid().optional(),
        ...paginationSchema,
      }),
    );

    let builder = request
      .supabase!.from("documents")
      .select("*")
      .order("created_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);

    if (query.caseId) builder = builder.eq("case_id", query.caseId);
    if (query.clientId) builder = builder.eq("client_id", query.clientId);

    const documents = unwrap(await builder) as any[];
    const data = await Promise.all(
      documents.map(async (document) => {
        const { data } = await request
          .supabase!.storage.from("documents")
          .createSignedUrl(document.storage_path, 3600);
        return { ...document, signed_url: data?.signedUrl };
      }),
    );

    return { data };
  });

  app.post("/v1/documents", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(request, documentBodySchema);
    const document = unwrap(
      await request
        .supabase!.from("documents")
        .insert({
          ...body,
          org_id: membership.org_id,
          uploaded_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "document",
      entity_id: (document as any).id,
      action: "created",
    });

    return { data: document };
  });

  app.post("/v1/documents/upload-url", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const body = parseBody(
      request,
      z.object({
        case_id: z.string().uuid().optional(),
        filename: z.string().min(1),
        content_type: z.string().min(1),
      }),
    );

    const extension = body.filename.includes(".") ? body.filename.split(".").pop() : "bin";
    const storagePath = `${membership.org_id}/${body.case_id ?? "general"}/${nanoid(24)}.${extension}`;
    const signed = await request
      .supabase!.storage.from("documents")
      .createSignedUploadUrl(storagePath);

    if (signed.error) throw signed.error;

    return {
      data: {
        storage_path: storagePath,
        token: signed.data.token,
        signed_url: signed.data.signedUrl,
        path: signed.data.path,
      },
    };
  });

  app.post("/v1/documents/:id/signed-url", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        expires: z.number().int().min(60).max(86400).default(3600),
      }),
    );

    const document = unwrap(
      await request.supabase!.from("documents").select("*").eq("id", id).single(),
    ) as any;
    const signed = await request
      .supabase!.storage.from("documents")
      .createSignedUrl(document.storage_path, body.expires);

    if (signed.error) throw signed.error;
    return { data: { signed_url: signed.data.signedUrl, expires_in: body.expires } };
  });

  app.delete("/v1/documents/:id", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const document = unwrap(
      await request.supabase!.from("documents").select("*").eq("id", id).single(),
    ) as any;

    await request.supabase!.storage.from("documents").remove([document.storage_path]);
    const deleted = unwrap(
      await request.supabase!.from("documents").delete().eq("id", id).select("*").single(),
    );

    await insertActivity(request.supabase!, {
      org_id: membership.org_id,
      user_id: request.auth!.userId,
      entity_type: "document",
      entity_id: id,
      action: "deleted",
    });

    return { data: deleted };
  });

  app.get("/v1/documents/:id/versions", { preHandler: app.requireAuth }, async (request) => {
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const versions = unwrap(
      await request
        .supabase!.from("document_versions")
        .select("*")
        .eq("document_id", id)
        .order("created_at", { ascending: false }),
    );
    return { data: versions };
  });

  app.post("/v1/documents/:id/versions", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        storage_path: z.string().min(1),
        size: z.number().int().nonnegative(),
        note: z.string().optional(),
      }),
    );
    const version = unwrap(
      await request
        .supabase!.from("document_versions")
        .insert({
          ...body,
          org_id: membership.org_id,
          document_id: id,
          created_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );
    return { data: version };
  });

  app.post("/v1/documents/:id/shares", { preHandler: app.requireAuth }, async (request) => {
    const membership = await getCurrentMembership(request.supabase!, request.auth!.userId);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        expires_at: z.string().datetime(),
        allow_download: z.boolean().default(false),
      }),
    );
    const token = nanoid(48);
    const share = unwrap(
      await request
        .supabase!.from("document_shares")
        .insert({
          ...body,
          org_id: membership.org_id,
          document_id: id,
          token,
          created_by: request.auth!.userId,
        })
        .select("*")
        .single(),
    );

    return {
      data: { ...(share as unknown as Record<string, unknown>), public_url: `/share/${token}` },
    };
  });
}
