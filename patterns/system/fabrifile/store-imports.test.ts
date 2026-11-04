/**
 * Holds `store.tsx` to loading no rendering code (`docs/specs/fabrifile/
 * FileStore.md`, "Modules"): the modules it reaches, through every local
 * import, are exactly the store's own, and none of them holds JSX or a `[UI]`.
 * A client that draws natively uses the store, so whatever the store imports
 * is loaded there, and a rendering module among them would be loaded for
 * nothing. The walk follows local imports only; `commonfabric` is the runtime
 * every pattern compiles against.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join, relative } from "@std/path";

const HERE = dirname(fromFileUrl(import.meta.url));

/**
 * Matches the specifier of every `import` or `export … from` statement, and of
 * every bare `import "…";`, which loads its module as surely as any other.
 */
const SPECIFIER =
  /(?:^|\n)\s*(?:(?:import|export)\b[^;]*?\bfrom\s+|import\s+)"([^"]+)"/g;

/**
 * Matches what a module that renders holds: an element, written as a
 * lowercase tag as every element here is, which a generic type argument such
 * as `Cell<FileEntry>` is not, or a `[UI]`.
 */
const RENDERING = /<[a-z][a-z0-9-]*[\s/>]|\[UI\]/;

/**
 * Returns every module `entry` reaches through local imports, `entry`
 * included, as paths relative to this directory, with each one's source.
 */
const reachable = async (entry: string): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    const key = relative(HERE, path);
    if (found.has(key)) return;
    const source = await Deno.readTextFile(path);
    found.set(key, source);
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (specifier.startsWith(".")) {
        await visit(join(dirname(path), specifier));
      }
    }
  };
  await visit(join(HERE, entry));
  return found;
};

describe("store-imports", () => {
  it("reaches only the store's own modules from `store.tsx`", async () => {
    const modules = await reachable("store.tsx");

    expect([...modules.keys()].toSorted()).toEqual([
      "names.ts",
      "schemas.tsx",
      "store.tsx",
    ]);
  });

  it("finds no JSX and no `[UI]` in any module `store.tsx` reaches", async () => {
    const modules = await reachable("store.tsx");

    for (const [path, source] of modules) {
      expect({ path, rendering: RENDERING.test(source) }).toEqual({
        path,
        rendering: false,
      });
    }
  });

  it("finds a module that renders when the walk starts at `view.tsx`", async () => {
    // The checks above pass trivially if the walk sees nothing that renders,
    // so the view, which does render, is held to the opposite.

    const modules = await reachable("view.tsx");

    expect(modules.has("schemas.tsx")).toBe(true);
    expect(RENDERING.test(modules.get("view.tsx") ?? "")).toBe(true);
  });
});
