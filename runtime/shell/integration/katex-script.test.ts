import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { build } from "@commonfabric/felt";
import shellConfig from "../felt.config.ts";

/**
 * Holds together the three parts that keep KaTeX out of the shell's bundles:
 * cf-code-editor imports it as `cf-katex-render`, felt.config.ts leaves that
 * name external and builds a script of its own for it, and
 * `public/index.html` maps the name to that script. A page that loads works
 * whether or not KaTeX was inlined, so nothing else notices it folding back.
 * Each build bundles an entry's whole graph and drives no browser; the file
 * sits in the integration suite for the warm npm cache and the permissions a
 * real bundle needs.
 */

/** The name cf-code-editor imports KaTeX by. */
const SPECIFIER = "cf-katex-render";

/** KaTeX as it appears in esbuild's input paths, under the npm cache. */
const NPM_KATEX = /\/katex\/\d+\.\d+\.\d+\//;

/** One output of an esbuild metafile, as far as these tests read it. */
interface Output {
  imports: Array<{ path: string; kind: string; external?: boolean }>;
  inputs: Record<string, unknown>;
}

/** The felt entry that writes `out`. */
function entryFor(out: string) {
  const entry = shellConfig.entries.find((e) => e.out === out);
  if (entry === undefined) throw new Error(`No felt entry writes ${out}.`);
  return entry;
}

/** Builds the felt entry `out` as felt.config.ts declares it. */
async function outputsOf(out: string): Promise<Output[]> {
  const entry = entryFor(out);
  const result = await build({
    entryPoints: [{
      in: fromFileUrl(new URL(`../${entry.in}`, import.meta.url)),
      out: entry.out,
    }],
    outdir: "/dist",
    splitting: entry.splitting,
    chunkNames: shellConfig.esbuild?.chunkNames,
    external: shellConfig.esbuild?.external,
    supported: shellConfig.esbuild?.supported,
    tsconfigRaw: shellConfig.esbuild?.tsconfigRaw,
    metafile: true,
    write: false,
  });
  return Object.values(result.metafile!.outputs) as Output[];
}

/** Whether any of `outputs` was built from KaTeX's package. */
function holdsKatex(outputs: Output[]): boolean {
  return outputs.some((output) =>
    Object.keys(output.inputs).some((input) => NPM_KATEX.test(input))
  );
}

describe("katex-script", () => {
  for (const out of ["scripts/index", "scripts/shell-components"]) {
    describe(out, () => {
      it("holds no KaTeX and leaves its name for the page to resolve", async () => {
        const outputs = await outputsOf(out);
        expect(holdsKatex(outputs)).toBe(false);
        expect(
          outputs.some((output) =>
            output.imports.some((edge) =>
              edge.path === SPECIFIER && edge.external === true &&
              edge.kind === "dynamic-import"
            )
          ),
        ).toBe(true);
      });
    });
  }

  describe("scripts/katex-render", () => {
    it("holds KaTeX", async () => {
      expect(holdsKatex(await outputsOf("scripts/katex-render"))).toBe(true);
    });
  });

  describe("public/index.html", () => {
    it("maps the name to the KaTeX script", async () => {
      const page = await Deno.readTextFile(
        new URL("../public/index.html", import.meta.url),
      );
      const importMap = page.match(
        /<script type="importmap">([\s\S]*?)<\/script>/,
      )?.[1];
      expect(importMap).toBeDefined();
      expect(JSON.parse(importMap!).imports[SPECIFIER]).toBe(
        `/${entryFor("scripts/katex-render").out}.js`,
      );
    });
  });
});
