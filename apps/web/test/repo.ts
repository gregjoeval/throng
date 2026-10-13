import { http, HttpResponse } from "msw";
import type { Blob, Refs, Tree, TreeEntry } from "@/lib/api";
import { notFound, server } from "./server";

/** A file's content: text, or bytes (binary when they hold a NUL). */
export type Content = string | Uint8Array;

/** A repository at each ref: every file by its path. */
export type Files = Record<string, Record<string, Content>>;

/** The refs every browse test serves unless given others: `main`, one active attempt and one archived. */
export const REFS: Refs = {
  main: { ref: "main", sha: "a".repeat(40) },
  active: [{ ref: "t42a3", state: "open", sha: "b".repeat(40) }],
  archived: [{ ref: "t41a1", state: "merged", sha: "c".repeat(40) }],
};

const MAX_TEXT_BYTES = 1024 * 1024;
/** The image types these tests serve, standing in for the platform's extension table. */
const IMAGE_TYPES: Record<string, string> = { png: "image/png", avif: "image/avif" };
const bytes = (content: Content) => (typeof content === "string" ? new TextEncoder().encode(content) : content);
const hash = (text: string) =>
  [...text]
    .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(40, "0");
const shaOf = (refs: Refs, ref: string) => {
  if (/^[0-9a-f]{40}$/u.test(ref)) return ref;
  return ref === "main" ? refs.main.sha : [...refs.active, ...refs.archived].find((a) => a.ref === ref)?.sha;
};

/** The directory at `dir` (`""` for the root) in `files`, folders first then by name, or null when there's none. */
function list(files: Record<string, Content>, dir: string): TreeEntry[] | null {
  const prefix = dir === "" ? "" : `${dir}/`;
  const entries = new Map<string, TreeEntry>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const [name = "", ...rest] = path.slice(prefix.length).split("/");
    const child = prefix + name;
    entries.set(
      name,
      rest.length > 0
        ? { name, path: child, type: "tree", mode: "40000", hash: hash(child), size: null }
        : { name, path: child, type: "blob", mode: "100644", hash: hash(child), size: bytes(content).length },
    );
  }
  if (entries.size === 0 && dir !== "") return null;
  return [...entries.values()].toSorted(
    (a, b) => Number(b.type === "tree") - Number(a.type === "tree") || (a.name < b.name ? -1 : 1),
  );
}

/**
 * Serves `/refs`, `/tree` and `/blob` for `files` at each ref, the way the platform answers them.
 * Returns every tree and blob URL asked for, as `tree <ref> <path>` (then ` +sizes` when sizes were
 * asked for) and `blob <ref> <path>`.
 */
export function serveRepo(files: Files, refs: Refs = REFS) {
  const asked: string[] = [];
  const at = (params: Record<string, unknown>) => {
    const ref = String(params["ref"]);
    const path = [params["path"] ?? ""].flat().join("/");
    return { ref, path, sha: shaOf(refs, ref), files: files[ref] };
  };
  server.use(
    http.get("*/api/projects/:owner/:project/refs", () => HttpResponse.json(refs)),
    http.get("*/api/projects/:owner/:project/tree/:ref/:path*", ({ params, request }) => {
      const { ref, path, sha, files: tree } = at(params);
      const sizes = new URL(request.url).searchParams.get("sizes") === "true";
      asked.push(`tree ${ref} ${path}${sizes ? " +sizes" : ""}`);
      const listed = tree === undefined ? null : list(tree, path);
      if (listed === null || sha == null) return notFound(`no directory ${path} at ${ref}`);
      const entries = sizes ? listed : listed.map(({ size: _size, ...entry }) => entry);
      return HttpResponse.json({ ref, sha, path, entries } satisfies Tree);
    }),
    http.get("*/api/projects/:owner/:project/blob/:ref/:path+", ({ params }) => {
      const { ref, path, sha, files: tree } = at(params);
      asked.push(`blob ${ref} ${path}`);
      const content = tree?.[path];
      if (content === undefined || sha == null) return notFound(`no file ${path} at ${ref}`);
      const raw = bytes(content);
      const binary = raw.slice(0, 8000).includes(0);
      const tooLarge = raw.length > MAX_TEXT_BYTES;
      const name = path.split("/").at(-1) ?? path;
      return HttpResponse.json({
        ref,
        sha,
        name,
        path,
        type: "blob",
        mode: "100644",
        hash: hash(path),
        size: raw.length,
        binary,
        tooLarge,
        contentType: IMAGE_TYPES[name.split(".").at(-1) ?? ""] ?? (binary ? "application/octet-stream" : "text/plain"),
        content: binary || tooLarge ? null : new TextDecoder().decode(raw),
      } satisfies Blob);
    }),
  );
  return asked;
}
