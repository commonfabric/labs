import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { build } from "@commonfabric/felt";
import shellConfig from "../felt.config.ts";

/** KaTeX as it appears in esbuild's input paths, under the npm cache. */
const NPM_KATEX = /\/katex\/\d+\.\d+\.\d+\//;

/** The output keys an esbuild metafile lists, with what each one holds. */
type Outputs = Record<
  string,
  {
    entryPoint?: string;
    imports: Array<{ path: string; kind: string }>;
    inputs: Record<string, unknown>;
  }
>;

/**
 * Builds the felt entry `out` as `felt.config.ts` declares it, splitting
 * included, and returns the inputs of its static closure and of the whole
 * build. The static closure is what loads with the entry: the outputs its
 * `import` statements reach, not those only a dynamic import reaches.
 */
async function entryInputs(
  out: string,
): Promise<{ boot: string[]; all: string[] }> {
  const entry = shellConfig.entries.find((e) => e.out === out);
  if (entry === undefined) throw new Error(`No felt entry writes ${out}.`);
  const entryIn = fromFileUrl(new URL(`../${entry.in}`, import.meta.url));
  const result = await build({
    entryPoints: [{ in: entryIn, out: entry.out }],
    outdir: "/dist",
    splitting: entry.splitting,
    chunkNames: shellConfig.esbuild?.chunkNames,
    external: shellConfig.esbuild?.external,
    supported: shellConfig.esbuild?.supported,
    tsconfigRaw: shellConfig.esbuild?.tsconfigRaw,
    metafile: true,
    write: false,
  });
  const outputs = result.metafile!.outputs as Outputs;
  const entryKey = Object.keys(outputs).find((key) =>
    outputs[key]!.entryPoint !== undefined
  );
  if (entryKey === undefined) throw new Error(`${out} emitted no entry.`);
  const closure = new Set<string>();
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (closure.has(key)) continue;
    closure.add(key);
    for (const edge of outputs[key]!.imports) {
      if (edge.kind === "import-statement" && outputs[edge.path]) {
        queue.push(edge.path);
      }
    }
  }
  const inputsOf = (keys: Iterable<string>) =>
    [...keys].flatMap((key) => Object.keys(outputs[key]!.inputs));
  return { boot: inputsOf(closure), all: inputsOf(Object.keys(outputs)) };
}

describe("page-boot-graph", () => {
  for (const out of ["scripts/index", "scripts/shell-components"]) {
    describe(out, () => {
      it("loads KaTeX only through a dynamic import", async () => {
        // Each build bundles the entry's whole graph (a few seconds) and
        // drives no browser. It sits in the integration suite for the warm
        // npm cache and the permissions a real bundle needs.
        const { boot, all } = await entryInputs(out);
        expect(boot.filter((input) => NPM_KATEX.test(input))).toEqual([]);
        // KaTeX is bundled into a deferred chunk, so a clean boot path does
        // not merely mean it failed to resolve.
        expect(all.some((input) => NPM_KATEX.test(input))).toBe(true);
      });
    });
  }
});
