import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code = "INTERNAL_ERROR",
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) =>
    new AppError(message, 400, "BAD_REQUEST", details),
  unauthorized: (message = "Authentication required") => new AppError(message, 401, "UNAUTHORIZED"),
  forbidden: (message = "You do not have permission to perform this action") =>
    new AppError(message, 403, "FORBIDDEN"),
  notFound: (message = "Resource not found") => new AppError(message, 404, "NOT_FOUND"),
  conflict: (message: string, details?: unknown) => new AppError(message, 409, "CONFLICT", details),
  tooManyRequests: (message: string, details?: unknown) =>
    new AppError(message, 429, "TOO_MANY_REQUESTS", details),
  upstream: (message: string, details?: unknown) =>
    new AppError(message, 502, "UPSTREAM_ERROR", details),
  unavailable: (message: string, details?: unknown) =>
    new AppError(message, 503, "SERVICE_UNAVAILABLE", details),
};

export function toHttpError(error: unknown) {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return errors.badRequest("Validation failed", error.flatten());
  }
  if (error instanceof Error) {
    const statusCode = Number(
      (error as Error & { statusCode?: number; status?: number }).statusCode ??
        (error as Error & { statusCode?: number; status?: number }).status,
    );

    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
      return new AppError(
        error.message,
        statusCode,
        statusCode === 429 ? "TOO_MANY_REQUESTS" : "HTTP_ERROR",
      );
    }

    return new AppError(error.message);
  }
  return new AppError("Unknown error");
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const httpError = toHttpError(error);
  const isServerError = httpError.statusCode >= 500;

  request.log[isServerError ? "error" : "warn"](
    { err: error, code: httpError.code, details: httpError.details },
    httpError.message,
  );

  return reply.code(httpError.statusCode).send({
    error: {
      code: httpError.code,
      message: httpError.message,
      details: httpError.details,
      requestId: request.id,
    },
  });
}
