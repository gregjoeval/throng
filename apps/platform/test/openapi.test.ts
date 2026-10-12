import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { publicApp } from "../src/app.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import type { Json } from "./support/json.ts";

// The spec's route conventions (#16), checked over the whole served document: it is valid OpenAPI 3.1,
// and every operation has an id, a summary, tags and a schema for every response it lists.

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Statuses HTTP defines without a body, such as a conditional GET's 304, so they have no schema. */
const BODILESS = new Set(["204", "304"]);

/** Every operation that breaks a convention, as `METHOD path: what's missing`. */
function lapses(doc: Json): string[] {
  const found: string[] = [];
  const ids = new Map<string, string>();
  for (const [path, item] of Object.entries(doc["paths"] as Record<string, Json>)) {
    for (const method of METHODS.filter((m) => item[m] !== undefined)) {
      const op = item[method] as Json;
      const where = `${method.toUpperCase()} ${path}`;
      const id = op["operationId"];
      if (typeof id !== "string" || id === "") found.push(`${where}: operationId`);
      else if (ids.has(id)) found.push(`${where}: operationId ${id} is also ${ids.get(id)}`);
      else ids.set(id, where);
      if (typeof op["summary"] !== "string" || op["summary"] === "") found.push(`${where}: summary`);
      if (!Array.isArray(op["tags"]) || op["tags"].length === 0) found.push(`${where}: tags`);
      const responses = (op["responses"] ?? {}) as Record<string, Json>;
      if (Object.keys(responses).length === 0) found.push(`${where}: responses`);
      for (const [status, response] of Object.entries(responses)) {
        if (BODILESS.has(status)) continue;
        const content = Object.values((response["content"] ?? {}) as Record<string, Json>);
        if (content.length === 0 || content.some((media) => media["schema"] === undefined)) {
          found.push(`${where}: ${status} response schema`);
        }
      }
    }
  }
  return found;
}

async function served() {
  const app = publicApp({ repos: () => new FakeRepos() });
  const res = await app.request("/api/openapi.json", {}, { DB: testDatabase() });
  return { status: res.status, doc: (await res.json()) as Json };
}

describe("GET /api/openapi.json", () => {
  it("serves the document to anyone, without a token", async () => {
    const { status, doc } = await served();
    expect(status).toBe(200);
    expect(doc["openapi"]).toBe("3.1.0");
  });

  it("is a valid OpenAPI 3.1 document", async () => {
    const { doc } = await served();
    const validator = new Validator();
    const result = await validator.validate(doc);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBeTruthy();
    expect(validator.version).toBe("3.1");
  });

  it("gives every operation a unique id, a summary, tags and a schema for each response", async () => {
    const { doc } = await served();
    expect(Object.keys(doc["paths"]).length).toBeGreaterThan(20);
    expect(lapses(doc)).toEqual([]);
  });

  it("catches an operation without an id or a response schema", () => {
    const doc = {
      paths: {
        "/a": {
          get: {
            operationId: "getA",
            summary: "A",
            tags: ["A"],
            responses: { 200: { description: "ok" }, 304: { description: "Not modified." } },
          },
          post: { summary: "Make A", tags: ["A"], responses: { 201: json() } },
        },
        "/b": { get: { operationId: "getA", summary: "B", tags: [], responses: { 200: json() } } },
      },
    };
    expect(lapses(doc)).toEqual([
      "GET /a: 200 response schema",
      "POST /a: operationId",
      "GET /b: operationId getA is also GET /a",
      "GET /b: tags",
    ]);
  });
});

function json(): Json {
  return { description: "ok", content: { "application/json": { schema: { type: "object" } } } };
}
