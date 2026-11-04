import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { rewriteFabricPins } from "../src/fabric-pin-rewrite.ts";

const ENTRY_A = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";
const ENTRY_B = "Bvcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("rewriteFabricPins", () => {
  it("rewrites only import/export string literal spans", async () => {
    const source = [
      "import {",
      "  dep,",
      '} from "cf:dep";',
      "export * from 'cf:other';",
      'import type { RemoteType } from "cf:types";',
      'type Inline = import("cf:inline").Value;',
      'const literal = "cf:not-an-import";',
    ].join("\n");

    const result = await rewriteFabricPins(
      source,
      (_ref, specifier) =>
        Promise.resolve(
          ({
            "cf:dep": ENTRY_A,
            "cf:other": ENTRY_B,
            "cf:types": ENTRY_A,
            "cf:inline": ENTRY_B,
          })[specifier] ?? null,
        ),
    );

    expect(result.rewrites).toEqual([
      {
        specifier: "cf:dep",
        pinned: `cf:dep@${ENTRY_A}`,
        line: 3,
      },
      {
        specifier: "cf:other",
        pinned: `cf:other@${ENTRY_B}`,
        line: 4,
      },
      {
        specifier: "cf:types",
        pinned: `cf:types@${ENTRY_A}`,
        line: 5,
      },
      {
        specifier: "cf:inline",
        pinned: `cf:inline@${ENTRY_B}`,
        line: 6,
      },
    ]);
    expect(result.contents).toContain(`} from "cf:dep@${ENTRY_A}";`);
    expect(result.contents).toContain(`export * from 'cf:other@${ENTRY_B}';`);
    expect(result.contents).toContain(
      `import type { RemoteType } from "cf:types@${ENTRY_A}";`,
    );
    expect(result.contents).toContain(
      `type Inline = import("cf:inline@${ENTRY_B}").Value;`,
    );
    expect(result.contents).toContain('const literal = "cf:not-an-import";');
    expect(stripPins(result.contents)).toBe(source);
  });

  it("leaves already-current pins and null resolutions unchanged", async () => {
    const source = [
      `import dep from "cf:dep@${ENTRY_A}";`,
      `import skipped from "cf:skipped";`,
    ].join("\n");

    const result = await rewriteFabricPins(source, (_ref, specifier) => {
      if (specifier === `cf:dep@${ENTRY_A}`) return Promise.resolve(ENTRY_A);
      return Promise.resolve(null);
    });

    expect(result.contents).toBe(source);
    expect(result.rewrites).toEqual([]);
  });
});

function stripPins(contents: string): string {
  return contents.replaceAll(`@${ENTRY_A}`, "").replaceAll(`@${ENTRY_B}`, "");
}
