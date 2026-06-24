import type { FastifyRequest } from "fastify";
import { z } from "zod";

export function parseBody<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return schema.parse(request.body);
}

export function parseQuery<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return schema.parse(request.query ?? {});
}

export function parseParams<T extends z.ZodTypeAny>(
  request: FastifyRequest,
  schema: T,
): z.infer<T> {
  return schema.parse(request.params ?? {});
}

export const paginationSchema = {
  limit: z.coerce.number().int().min(1).max(250).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
