// The API's one error shape, `{error: {code, message}}`, shared by every `/api` route.

import { z } from "@hono/zod-openapi";

export const ERROR_CODES = [
  "invalidRequest",
  "unauthorized",
  "forbidden",
  "notFound",
  "invalidState",
  "attemptLimit",
  "conflict",
  "internal",
  "unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES).openapi({ example: "notFound" }),
      message: z.string().openapi({ example: "no such token" }),
    }),
  })
  .openapi("Error");

export type ErrorBody = z.infer<typeof ErrorSchema>;

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

const STATUS = {
  invalidRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  invalidState: 409,
  attemptLimit: 409,
  conflict: 409,
  internal: 500,
  /** Something Throng depends on outside Cloudflare failed; trying again may work. */
  unavailable: 503,
} as const satisfies Record<ErrorCode, number>;

/** The HTTP statuses the API answers errors with. */
export type ErrorStatus = (typeof STATUS)[ErrorCode];

/**
 * A failure a service reports to its caller, e.g. a duplicate handle. Services throw it without
 * knowing about HTTP; the API turns it into the error shape and the status for its code.
 */
export class ServiceError extends Error {
  override readonly name = "ServiceError";

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): ErrorStatus {
    return STATUS[this.code];
  }
}

/** An OpenAPI response entry for an error status, so routes can list the errors they return. */
export function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ErrorSchema } } };
}
