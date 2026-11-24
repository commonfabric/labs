import { assert } from "@std/assert";
import { fromFileUrl, relative, resolve } from "@std/path";
import { build } from "@commonfabric/felt";
import shellConfig from "../felt.config.ts";

/**
 * Invariant: the TypeScript compiler stack stays off the worker's boot path.
 * The worker reaches the compiler only through the single dynamic import in
 * deferred-compiler-stack.ts, and the worker entry's `splitting: true` in
 * felt.config.ts emits that subtree as a separate chunk loaded on first
 * compile — so worker-runtime.js ships without the ~10MB `typescript` bundle.
 *
 * A worker that boots does not witness this: it boots whether or not the
 * compiler is inlined, so worker-runtime.test.ts cannot see the compiler
 * folding back into the boot bundle. This test asserts the property directly
 * on the shipped chunk graph, built from the real felt.config entry, so it
 * fails if either lever moves:
 *   - a static import edge from a boot module into the compiler stack, or
 *   - `splitting` removed from the worker entry in felt.config.ts.
 *
 * It bundles the worker graph once (~a second) and drives no browser; it lives
 * in the integration suite for the warm npm cache and permissions a real
 * bundle needs.
 */

// The npm TypeScript compiler as it appears in esbuild metafile input paths:
// the deno npm cache lays it out under ".../typescript/<version>/lib/...".
// The version segment is what distinguishes it from CommonFabric's own source
// under directories named "typescript" (js-compiler/typescript/diagnostics,
// schema-generator/src/typescript, ...), which must be allowed on the boot path.
const NPM_TYPESCRIPT = /\/typescript\/\d+\.\d+\.\d+\//;

Deno.test("worker boot graph: the TypeScript compiler is reachable only via the dynamic import, never statically", async () => {
  const worker = shellConfig.entries.find(
    (e) => e.out === "scripts/worker-runtime",
  );
  assert(worker, "worker-runtime entry not found in felt.config.ts");

  // felt.config entry paths are relative to the shell package root.
  const shellDir = new URL("../", import.meta.url);
  const workerIn = fromFileUrl(new URL(worker.in, shellDir));

  const outDir = await Deno.makeTempDir({ prefix: "worker-boot-graph-" });
  try {
    const result = await build({
      // Build the worker exactly as felt.config declares it — critically,
      // `splitting` comes from the config, so removing it there fails this test.
      entryPoints: [{ in: workerIn, out: worker.out }],
      outdir: outDir,
      splitting: worker.splitting,
      chunkNames: shellConfig.esbuild?.chunkNames,
      external: shellConfig.esbuild?.external,
      supported: shellConfig.esbuild?.supported,
      tsconfigRaw: shellConfig.esbuild?.tsconfigRaw,
      metafile: true,
      // The graph is all we need; don't spend I/O writing ~14MB to disk.
      write: false,
    });

    const outputs = result.metafile!.outputs as Record<
      string,
      {
        entryPoint?: string;
        imports: Array<{ path: string; kind: string }>;
        inputs: Record<string, unknown>;
      }
    >;

    // Every emitted module must remain under dist/scripts. In particular this
    // pins felt.config's chunkNames: without it, esbuild emits chunks at the
    // outDir root, where the felt dev server's SPA fallback returns index.html
    // instead of JavaScript.
    const outsideScripts = Object.keys(outputs)
      .map((key) => relative(outDir, resolve(key)).replaceAll("\\", "/"))
      .filter((route) => !route.startsWith("scripts/"));
    assert(
      outsideScripts.length === 0,
      "worker outputs must all be served from /scripts; found:\n  " +
        outsideScripts.join("\n  "),
    );

    // Find the worker entry's output bundle.
    const entryKey = Object.keys(outputs).find((k) =>
      outputs[k]!.entryPoint?.endsWith("web-worker/index.ts")
    );
    assert(entryKey, "worker entry output not found in metafile");

    // Walk the STATIC-import closure of the entry (kind === "import-statement");
    // dynamic-import edges are deliberately not followed — that is the whole
    // point of the split.
    const staticClosure = new Set<string>();
    const queue = [entryKey];
    while (queue.length > 0) {
      const key = queue.pop()!;
      if (staticClosure.has(key)) continue;
      staticClosure.add(key);
      for (const imp of outputs[key]!.imports) {
        if (imp.kind === "import-statement" && outputs[imp.path]) {
          queue.push(imp.path);
        }
      }
    }

    const inputsOf = (keys: Iterable<string>): Set<string> => {
      const inputs = new Set<string>();
      for (const key of keys) {
        for (const input of Object.keys(outputs[key]!.inputs)) {
          inputs.add(input);
        }
      }
      return inputs;
    };

    const bootInputs = inputsOf(staticClosure);
    const tsOnBootPath = [...bootInputs].filter((p) => NPM_TYPESCRIPT.test(p));
    assert(
      tsOnBootPath.length === 0,
      "the TypeScript compiler leaked onto the worker boot path — it must be " +
        `reached only through the dynamic import. Offending inputs:\n  ${
          tsOnBootPath.slice(0, 5).join("\n  ")
        }`,
    );

    // Present-but-only-dynamic: the compiler must actually be bundled somewhere
    // (into a dynamic chunk), so a "clean" boot path isn't just the compiler
    // failing to resolve at all.
    const allInputs = inputsOf(Object.keys(outputs));
    const tsAnywhere = [...allInputs].filter((p) => NPM_TYPESCRIPT.test(p));
    assert(
      tsAnywhere.length > 0,
      "expected the TypeScript compiler to be bundled into a dynamic chunk, " +
        "but it was not found in the build at all",
    );
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});
