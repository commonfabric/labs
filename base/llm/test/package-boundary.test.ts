/**
 * Checks that this package stays loadable by a browser tab, which it reaches
 * through `@commonfabric/runner` and `runtime-client`. Its sources are read
 * against an allowlist of specifiers, so a provider SDK, a `node:` module, or
 * any dependency nobody thought to ban fails here.
 * `docs/features/llm-provider-boundary.md` gives the reasoning.
 *
 * Two neighboring rules belong to repo-wide gates rather than to this file. An
 * import of `@commonfabric/runner` would close a package cycle, which
 * `check-package-cycles` catches against the real module graph. A dependency
 * declared and never imported is `check-unused-deps`'s job, so nothing here
 * reads `deno.jsonc`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { walk } from "@std/fs/walk";
import { fromFileUrl, relative } from "@std/path";

const PACKAGE_ROOT = fromFileUrl(new URL("..", import.meta.url));

/**
 * The non-relative specifiers a shipped source in this package may name.
 *
 * An allowlist rather than a list of banned names, so that a dependency
 * arriving from a direction nobody anticipated is caught too: a provider SDK,
 * a `node:` module, `@commonfabric/runner`, an HTTP library. Adding an entry
 * here is the review checkpoint, and the question it puts is whether a browser
 * tab may load the thing being added.
 */
const ALLOWED = [
  "@commonfabric/api",
  "@commonfabric/pure-json",
  "@commonfabric/utils",
  "@std/",
];

/** Is `specifier` relative, or allowed exactly, as a subpath, or by prefix? */
function isAllowed(specifier: string): boolean {
  if (specifier.startsWith(".")) return true;
  return ALLOWED.some((allowed) =>
    allowed.endsWith("/")
      ? specifier.startsWith(allowed)
      : specifier === allowed || specifier.startsWith(`${allowed}/`)
  );
}

/**
 * `source` with its block comments and its whole-line `//` comments removed.
 *
 * The scan below reads specifiers out of text, and this package documents
 * itself with `@example` blocks that contain import statements. Without this
 * step a comment describing the boundary would trip the check that enforces
 * it. A `//` following code on the same line is left alone, so a URL in a
 * string keeps its double slash.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every module specifier `source` imports.
 *
 * Reading the text rather than the module graph means a specifier assembled at
 * run time is not seen. The error runs one way: what is missed is reported as
 * allowed, never the reverse.
 */
function importedSpecifiers(source: string): string[] {
  const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  return [...withoutComments(source).matchAll(pattern)].map((match) =>
    match[1]
  );
}

/**
 * Every repository path a Markdown document cites, each with the directory it
 * is written relative to.
 *
 * Two forms carry a path. A backticked one is written from the repository
 * root, the way prose names a file. A link target is written from the
 * document, and is matched whether or not it opens with a `./` — omitting that
 * is the ordinary way to link a sibling, and a check that skipped those would
 * be blind to a document's own neighborhood. A target carrying a colon is a
 * URL and belongs to no directory here.
 */
function citedPaths(
  markdown: string,
): { path: string; relativeTo: "repo" | "document" }[] {
  const cited = new Map<string, "repo" | "document">();
  const backticked =
    /`((?:base|connectors|data-model|patterns|runtime|utils|docs|tasks|scripts)\/[^`\s]+)`/g;
  for (const match of markdown.matchAll(backticked)) {
    cited.set(match[1], "repo");
  }
  const linked = /\]\(([^)#\s:]+)\)/g;
  for (const match of markdown.matchAll(linked)) {
    if (match[1].startsWith("/")) continue;
    if (!cited.has(match[1])) cited.set(match[1], "document");
  }
  return [...cited].map(([path, relativeTo]) => ({ path, relativeTo }));
}

/** The package's shipped sources: its TypeScript, minus its tests. */
async function readShippedSources(): Promise<{ path: string; text: string }[]> {
  const sources: { path: string; text: string }[] = [];
  for await (
    const entry of walk(PACKAGE_ROOT, { includeDirs: false, exts: [".ts"] })
  ) {
    const path = relative(PACKAGE_ROOT, entry.path);
    if (path.endsWith(".test.ts")) continue;
    sources.push({ path, text: await Deno.readTextFile(entry.path) });
  }
  return sources;
}

describe("package-boundary", () => {
  describe("readShippedSources()", () => {
    it("returns the package's sources and omits its tests", async () => {
      const paths = (await readShippedSources()).map(({ path }) => path);
      expect(paths).toContain("src/client.ts");
      expect(paths).toContain("src/types.ts");
      expect(paths).not.toContain("src/client.test.ts");
    });
  });

  describe("importedSpecifiers()", () => {
    it("returns a specifier imported by a statement", () => {
      expect(importedSpecifiers(`import { a } from "@commonfabric/api";`))
        .toEqual(["@commonfabric/api"]);
    });

    it("returns a specifier whose statement spans several lines", () => {
      expect(importedSpecifiers(`import {\n  a,\n} from "ai";`)).toEqual([
        "ai",
      ]);
    });

    it("returns nothing for an import inside a doc comment", () => {
      expect(importedSpecifiers(`/**\n * import { a } from "ai";\n */`))
        .toEqual([]);
    });

    it("returns nothing for a commented-out import", () => {
      expect(importedSpecifiers(`  // import { a } from "ai";`)).toEqual([]);
    });

    it("keeps a URL that carries a double slash", () => {
      expect(importedSpecifiers(`const u = "https://x/y";\nimport "ai";`))
        .toEqual(["ai"]);
    });
  });

  describe("shipped sources", () => {
    it("name only specifiers this package is allowed to depend on", async () => {
      const offenses: string[] = [];
      for (const { path, text } of await readShippedSources()) {
        for (const specifier of importedSpecifiers(text)) {
          if (!isAllowed(specifier)) {
            offenses.push(`${path} imports ${specifier}`);
          }
        }
      }
      expect(offenses).toEqual([]);
    });
  });

  describe("citedPaths()", () => {
    it("returns a backticked path as written from the repository root", () => {
      expect(citedPaths("see `base/llm/src/types.ts` for it"))
        .toEqual([{ path: "base/llm/src/types.ts", relativeTo: "repo" }]);
    });

    it("returns a link target that omits its leading `./`", () => {
      expect(citedPaths("[types](src/types.ts)"))
        .toEqual([{ path: "src/types.ts", relativeTo: "document" }]);
    });

    it("returns a link target that climbs out of the directory", () => {
      expect(citedPaths("[m](../toolshed/routes/ai/llm/models.ts)")).toEqual([
        { path: "../toolshed/routes/ai/llm/models.ts", relativeTo: "document" },
      ]);
    });

    it("returns nothing for a URL or a bare anchor", () => {
      expect(citedPaths("[a](https://example.invalid/x) [b](#section)"))
        .toEqual([]);
    });
  });

  describe("README.md", () => {
    it("cites only repository paths that exist", async () => {
      const cited = citedPaths(
        await Deno.readTextFile(`${PACKAGE_ROOT}/README.md`),
      );
      expect(cited.length).toBeGreaterThan(0);
      const missing: string[] = [];
      for (const { path, relativeTo } of cited) {
        const base = relativeTo === "repo"
          ? `${PACKAGE_ROOT}/../..`
          : PACKAGE_ROOT;
        try {
          await Deno.stat(`${base}/${path}`);
        } catch {
          missing.push(path);
        }
      }
      expect(missing).toEqual([]);
    });
  });
});
