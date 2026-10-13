import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/api.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";

// ADR 0002: every name and value a client sees is camelCase. This walks the whole OpenAPI document
// (`/api/openapi.json`, which includes the browse and dequeue routes) and lists anything that isn't.

const CAMEL = /^[a-z][a-zA-Z0-9]*$/u;

/**
 * Names that keep a format someone else defined, matched by where they appear. Header parameters
 * are HTTP headers (`If-None-Match`), named by HTTP's conventions, not ours; a config's Sandbox sizes are Cloudflare's instance type
 * names (`standard-1`), which a config writes as Cloudflare does. (Security schemes'
 * header names, media types and literal path segments such as `merge-request` aren't names or
 * values in a body or parameter, so the walk doesn't check them.)
 */
const ALLOWED: { where: RegExp; why: string }[] = [
  { where: /\/parameters\/\d+\[in=header\]\/name$/u, why: "HTTP header names" },
  { where: /\/Config\/properties\/sandbox\/properties\/size\/enum$/u, why: "Cloudflare's container instance types" },
];

type Json = Record<string, unknown>;

/** Every non-camelCase name or value in the document, as `path: value`. */
function offenders(doc: Json): string[] {
  const found: string[] = [];
  const check = (where: string, value: unknown) => {
    if (typeof value !== "string" || CAMEL.test(value)) return;
    if (ALLOWED.some((a) => a.where.test(where))) return;
    found.push(`${where}: ${value}`);
  };
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${where}/${i}`));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node as Json;
    if (obj["properties"] !== undefined && typeof obj["properties"] === "object") {
      for (const name of Object.keys(obj["properties"] as Json)) check(`${where}/properties`, name);
    }
    if (Array.isArray(obj["required"])) for (const name of obj["required"]) check(`${where}/required`, name);
    if (Array.isArray(obj["enum"])) for (const value of obj["enum"]) check(`${where}/enum`, value);
    if ("const" in obj) check(`${where}/const`, obj["const"]);
    const discriminator = obj["discriminator"] as Json | undefined;
    if (discriminator !== undefined) check(`${where}/discriminator`, discriminator["propertyName"]);
    if (Array.isArray(obj["parameters"])) {
      (obj["parameters"] as Json[]).forEach((p, i) =>
        check(`${where}/parameters/${i}[in=${String(p["in"])}]/name`, p["name"]),
      );
    }
    for (const [key, child] of Object.entries(obj)) {
      // Examples and descriptions are prose and sample data, not names.
      if (key === "example" || key === "examples" || key === "description") continue;
      walk(child, `${where}/${key}`);
    }
  };
  walk(doc["paths"], "#/paths");
  walk(doc["components"], "#/components");
  return found;
}

describe("the OpenAPI document", () => {
  it("names every property, parameter and enum value in camelCase", async () => {
    const api = apiRoutes({ repos: () => new FakeRepos() });
    const res = await api.request("/openapi.json", {}, { DB: testDatabase() });
    const doc = (await res.json()) as Json;
    expect(Object.keys(doc["paths"] as Json).length).toBeGreaterThan(20);
    expect(offenders(doc)).toEqual([]);
  });

  it("catches a snake_case name, parameter or value", () => {
    const doc = {
      paths: {
        "/x": {
          get: {
            parameters: [
              { in: "query", name: "from_ref" },
              { in: "header", name: "If-None-Match" },
            ],
          },
        },
      },
      components: {
        schemas: {
          X: { type: "object", properties: { created_at: {} }, required: ["created_at"], enum: ["needs_review"] },
        },
      },
    };
    expect(offenders(doc)).toEqual([
      "#/paths//x/get/parameters/0[in=query]/name: from_ref",
      "#/components/schemas/X/properties: created_at",
      "#/components/schemas/X/required: created_at",
      "#/components/schemas/X/enum: needs_review",
    ]);
  });
});
