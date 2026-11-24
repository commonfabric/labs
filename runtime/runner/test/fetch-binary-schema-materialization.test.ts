import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * A lift consuming a `fetchBinary` result materializes and runs: schema-query
 * materialization carries the `FabricBytes`-bearing `result` field through,
 * because `SchemaObjectTraverser` treats `FabricSpecialObject` values as
 * opaque leaves (the fabric type system's documented contract: frozen, pass
 * through conversion unchanged).
 *
 * The hazard that guards against: a `FabricBytes` falling into the record
 * branch would be decomposed by `Object.entries` over its (empty) own props,
 * fail the schema-generator's structural object schema for
 * `FetchBinaryResult.bytes`, and drop the containing `result` field entirely
 * (`required` unmet), so the consumer's argument would stay invalid and its
 * body would never run — freezing every downstream consumer, at any nesting
 * depth. (`fetchJson` consumers carry plain JSON values and are unaffected.)
 * The collateral: the consumers' crippled read logs would also never
 * register the forward dependents edges the post-writeback wake relies on.
 *
 * This test runs the WHOLE chain — mocked binary fetch (via the injectable
 * `RuntimeOptions.fetch`) → `FabricBytes` result → consumer lifts reading
 * `result.mediaType` and re-encoding `result.bytes` — and asserts the
 * consumers actually materialize.
 */

const signer = await Identity.fromPassphrase("fetch-binary-materialization");
const space = signer.did();

// 1×1 transparent PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Uint8Array.from(
  atob(TINY_PNG_BASE64),
  (c) => c.charCodeAt(0),
);

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { computed, fetchBinary, pattern, type FetchBinaryResult } from 'commonfabric';",
        "export default pattern(() => {",
        "  const art = fetchBinary({ url: 'https://mock.test/img' });",
        "  const readyArt = art as FetchBinaryResult;",
        "  const mediaType = computed(() => readyArt.mediaType ?? '');",
        "  const dataUrl = computed(() => {",
        "    const bytes = readyArt.bytes;",
        "    const mt = readyArt.mediaType;",
        "    if (!bytes || !mt) return '';",
        "    const raw = bytes.slice();",
        "    let binary = '';",
        "    for (let i = 0; i < raw.length; i++) {",
        "      binary += String.fromCharCode(raw[i]);",
        "    }",
        "    return `data:${mt};base64,${btoa(binary)}`;",
        "  });",
        "  return { mediaType, dataUrl };",
        "});",
      ].join("\n"),
    },
  ],
};

describe("fetchBinary consumer materialization", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // `RuntimeOptions.fetch` overrides the outbound fetch for this runtime
      // instance, so the builtin resolves against this deterministic binary
      // response instead of the network.
      fetch: () =>
        Promise.resolve(
          new Response(TINY_PNG_BYTES, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ),
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("lifts reading a FabricBytes-bearing fetch result materialize and run", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const resultCell = runtime.getCell<{ mediaType: string; dataUrl: string }>(
      space,
      "fetch-binary-consumer",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();

    const cancelSink = result.sink(() => {});
    // `settled()` awaits the async fetch work and its writeback; a follow-up
    // `idle()` drains the consumer re-runs the writeback triggers.
    await runtime.settled();
    await runtime.idle();

    expect(await result.key("mediaType").pull()).toBe("image/png");
    expect(await result.key("dataUrl").pull()).toBe(
      `data:image/png;base64,${TINY_PNG_BASE64}`,
    );
    cancelSink();
  });
});
