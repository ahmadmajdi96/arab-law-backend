import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { documentShares, documentVersions, documents } from "../db/schema.js";
import { getRequestMembership, insertActivity } from "../utils/db.js";
import { errors } from "../utils/errors.js";
import { data } from "../utils/serialize.js";
import { paginationSchema, parseBody, parseParams, parseQuery } from "../utils/validation.js";

const documentBodySchema = z.object({
  name: z.string().min(1).max(240),
  case_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  storage_path: z.string().min(1),
  kind: z.string().default("file"),
  metadata: z.record(z.unknown()).optional(),
});

export async function registerDocumentRoutes(app: FastifyInstance) {
  app.get("/v1/documents", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const query = parseQuery(
      request,
      z.object({
        caseId: z.string().uuid().optional(),
        clientId: z.string().uuid().optional(),
        ...paginationSchema,
      }),
    );

    const filters = [eq(documents.orgId, membership.orgId)];
    if (query.caseId) filters.push(eq(documents.caseId, query.caseId));
    if (query.clientId) filters.push(eq(documents.clientId, query.clientId));

    const rows = await app.db
      .select()
      .from(documents)
      .where(and(...filters))
      .orderBy(desc(documents.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const withUrls = await Promise.all(
      rows.map(async (document) => ({
        ...document,
        signedUrl: await app.storage.signedDownloadUrl({
          key: document.storagePath,
          filename: document.name,
          expiresIn: 3600,
        }),
      })),
    );

    return data(withUrls);
  });

  app.post("/v1/documents", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(request, documentBodySchema);
    const [document] = await app.db
      .insert(documents)
      .values({
        orgId: membership.orgId,
        name: body.name,
        caseId: body.case_id,
        clientId: body.client_id,
        mime: body.mime,
        size: body.size,
        storagePath: body.storage_path,
        kind: body.kind,
        uploadedBy: request.auth!.userId,
        metadata: body.metadata ?? {},
      })
      .returning();
    if (!document) throw errors.unavailable("Unable to create document");

    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "document",
      entityId: document.id,
      action: "created",
    });

    return data(document);
  });

  app.post("/v1/documents/upload-url", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const body = parseBody(
      request,
      z.object({
        case_id: z.string().uuid().optional(),
        filename: z.string().min(1),
        content_type: z.string().min(1),
      }),
    );

    const extension = body.filename.includes(".") ? body.filename.split(".").pop() : "bin";
    const storagePath = `${membership.orgId}/${body.case_id ?? "general"}/${nanoid(24)}.${extension}`;
    const signedUrl = await app.storage.signedUploadUrl({
      key: storagePath,
      contentType: body.content_type,
      expiresIn: 900,
    });

    return data({
      storagePath,
      signedUrl,
      method: "PUT",
      expiresIn: 900,
    });
  });

  app.post("/v1/documents/:id/signed-url", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        expires: z.number().int().min(60).max(86400).default(3600),
        download: z.boolean().default(false),
      }),
    );

    const [document] = await app.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.orgId, membership.orgId)))
      .limit(1);
    if (!document) throw errors.notFound("Document not found");

    const signedUrl = await app.storage.signedDownloadUrl({
      key: document.storagePath,
      filename: document.name,
      download: body.download,
      expiresIn: body.expires,
    });
    return data({ signedUrl, expiresIn: body.expires });
  });

  app.delete("/v1/documents/:id", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const [document] = await app.db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.orgId, membership.orgId)))
      .returning();
    if (!document) throw errors.notFound("Document not found");

    await app.storage.remove(document.storagePath);
    await insertActivity(app.db, {
      orgId: membership.orgId,
      userId: request.auth!.userId,
      entityType: "document",
      entityId: id,
      action: "deleted",
    });

    return data(document);
  });

  app.get("/v1/documents/:id/versions", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const versions = await app.db
      .select()
      .from(documentVersions)
      .where(and(eq(documentVersions.documentId, id), eq(documentVersions.orgId, membership.orgId)))
      .orderBy(desc(documentVersions.createdAt));
    return data(versions);
  });

  app.post("/v1/documents/:id/versions", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        storage_path: z.string().min(1),
        size: z.number().int().nonnegative(),
        note: z.string().optional(),
      }),
    );
    const [version] = await app.db
      .insert(documentVersions)
      .values({
        orgId: membership.orgId,
        documentId: id,
        storagePath: body.storage_path,
        size: body.size,
        note: body.note,
        createdBy: request.auth!.userId,
      })
      .returning();
    return data(version);
  });

  app.post("/v1/documents/:id/shares", { preHandler: app.requireAuth }, async (request) => {
    const { membership } = await getRequestMembership(app.db, request);
    const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        expires_at: z.string().datetime(),
        allow_download: z.boolean().default(false),
      }),
    );
    const token = nanoid(48);
    const [share] = await app.db
      .insert(documentShares)
      .values({
        orgId: membership.orgId,
        documentId: id,
        token,
        expiresAt: new Date(body.expires_at),
        allowDownload: body.allow_download,
        createdBy: request.auth!.userId,
      })
      .returning();

    return data({ ...share, publicUrl: `/share/${token}` });
  });
}
