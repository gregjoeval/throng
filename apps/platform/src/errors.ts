// The API's one error shape, `{error: {code, message}}`, shared by every `/api` route.

import { z } from "@hono/zod-openapi";

export const ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_state",
  "attempt_limit",
  "conflict",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES).openapi({ example: "not_found" }),
      message: z.string().openapi({ example: "no such token" }),
    }),
  })
  .openapi("Error");

export type ErrorBody = z.infer<typeof ErrorSchema>;

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** An OpenAPI response entry for an error status, so routes can list the errors they return. */
export function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ErrorSchema } } };
}
