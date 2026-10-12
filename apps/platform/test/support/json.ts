/**
 * A JSON response body read without a schema. Tests index into it by path and compare the values
 * against literals, so any shape the API returns type-checks.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- a response body read by path; the assertions check its shape
export type Json = Record<string, any>;
