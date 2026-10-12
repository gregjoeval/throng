// The platform's error shape (`{error: {code, message}}`), read back out of a failed API call.

import { DetailedError } from "hono/client";

export interface ApiError {
  /** The platform's error code, e.g. `notFound` or `forbidden`; `unavailable` when there's no body. */
  code: string;
  message: string;
}

function isApiError(value: unknown): value is ApiError {
  const { code, message } = (value ?? {}) as Partial<ApiError>;
  return typeof code === "string" && typeof message === "string";
}

/** What went wrong in a failed platform call, in the platform's terms. An `ApiError` passes through. */
export function apiError(error: unknown): ApiError {
  if (error instanceof DetailedError) {
    const body = (error.detail as { data?: { error?: Partial<ApiError> } } | undefined)?.data?.error;
    if (typeof body?.code === "string") return { code: body.code, message: body.message ?? body.code };
    if (error.statusCode === 404) return { code: "notFound", message: "Not found." };
    if (error.statusCode === 403) return { code: "forbidden", message: "Forbidden." };
    return { code: "unavailable", message: "The platform is unreachable." };
  }
  if (isApiError(error)) return { code: error.code, message: error.message };
  return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}
