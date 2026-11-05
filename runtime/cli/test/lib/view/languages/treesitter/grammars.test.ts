import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { walkSync } from "@std/fs";
import { fromFileUrl, toFileUrl } from "@std/path";

import { treeSitterGrammars } from "../../../../../lib/view/languages/treesitter/grammars.ts";

/** Whether a module export has the shape of a Tree-sitter grammar. */
function isGrammar(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    typeof Reflect.get(value, "wasmUrl") === "function" &&
    typeof Reflect.get(value, "highlightQuery") === "string";
}

describe("treeSitterGrammars", () => {
  it("lists every grammar a language module exports, once", async () => {
    const languages = fromFileUrl(
      new URL("../../../../../lib/view/languages/", import.meta.url),
    );
    const exported = new Set<unknown>();
    for (const entry of walkSync(languages, { exts: [".ts"] })) {
      const module = await import(toFileUrl(entry.path).href);
      for (const value of Object.values(module)) {
        if (isGrammar(value)) exported.add(value);
      }
    }

    expect(exported.size).toBeGreaterThan(0);
    expect(treeSitterGrammars.length).toBe(new Set(treeSitterGrammars).size);
    expect(new Set(treeSitterGrammars)).toEqual(exported);
  });
});
