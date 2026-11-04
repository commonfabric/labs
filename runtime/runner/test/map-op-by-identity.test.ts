import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  isPatternRefSentinel,
  resolveOpPattern,
} from "../src/builtins/op-pattern-ref.ts";

const signer = await Identity.fromPassphrase("map-op-by-identity");
const space = signer.did();

describe("op-pattern-ref helpers", () => {
  // Unit coverage for the sentinel shape + resolver, independent of the
  // runtime.

  it("recognizes a well-formed sentinel and rejects others", () => {
    expect(
      isPatternRefSentinel({
        $patternRef: { identity: "cf:module/x", symbol: "s" },
      }),
    ).toBe(true);
    expect(isPatternRefSentinel({ $patternRef: { identity: "x" } })).toBe(
      false,
    );
    expect(isPatternRefSentinel({ nodes: [] })).toBe(false);
    expect(isPatternRefSentinel(null)).toBe(false);
    expect(isPatternRefSentinel("x")).toBe(false);
  });

  it("resolves a sentinel via artifactFromIdentitySync", () => {
    const fakePattern = { argumentSchema: true } as never;
    const fakeRuntime = {
      patternManager: {
        artifactFromIdentitySync: (identity: string, symbol: string) => {
          expect(identity).toBe("cf:module/abc");
          expect(symbol).toBe("__cfPattern_1");
          return fakePattern;
        },
      },
    } as never;
    const resolved = resolveOpPattern(
      fakeRuntime,
      { $patternRef: { identity: "cf:module/abc", symbol: "__cfPattern_1" } },
      "map",
    );
    expect(resolved).toBe(fakePattern);
  });

  it("throws when the sentinel misses the session-lifetime index", () => {
    // The artifact index never evicts, and the sentinel is stamped from the
    // op's live artifact in the reading session — a miss is a bug, and the
    // sentinel carries no fallback graph to paper over it (identity E4/E5).
    const fakeRuntime = {
      patternManager: { artifactFromIdentitySync: () => undefined },
    } as never;
    expect(() =>
      resolveOpPattern(
        fakeRuntime,
        { $patternRef: { identity: "cf:module/miss", symbol: "s" } },
        "map",
      )
    ).toThrow(
      /op pattern cf:module\/miss#s did not evaluate in this session/,
    );
  });

  it("passes a non-sentinel value through unchanged (stored-keyless remnant)", () => {
    // Only a graph deserialized from a STORED no-entry-ref pattern value
    // arrives embedded (a live op whose original is a trusted
    // builder pattern is minted a keyless identity at instantiation and
    // arrives as a sentinel — see keyless-op-identity.test.ts). The stored
    // form must keep executing: stored-pattern-rehydration.test.ts pins that
    // contract end-to-end.
    const graph = { nodes: [], result: {} } as never;
    const resolved = resolveOpPattern({} as never, graph, "map");
    expect(resolved).toBe(graph);
  });
});

describe("map op passed by identity", () => {
  // End-to-end: the `op` pattern of a `.map` node is passed by its
  // content-addressed `{ identity, symbol }` reference (a `{ $patternRef }`
  // sentinel) and resolved synchronously at runtime via
  // `artifactFromIdentitySync`, instead of being deserialized from an embedded
  // pattern graph.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ items: { v: number }[] }>(({ items }) => {",
          "  return { vs: items.map((item) => item.v) };",
          "});",
        ].join("\n"),
      },
    ],
  };

  it("resolves the map op by identity and produces correct output", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);

    // Spy on the synchronous identity resolver to prove the op took the
    // `{ $patternRef }` path (not the embedded-graph fallback).
    const pm = runtime.patternManager;
    const original = pm.artifactFromIdentitySync.bind(pm);
    let identityResolves = 0;
    pm.artifactFromIdentitySync = (identity: string, symbol: string) => {
      identityResolves++;
      return original(identity, symbol);
    };

    const resultCell = runtime.getCell<{ vs: number[] }>(
      space,
      "map op by identity",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: 1 }, { v: 2 }, { v: 3 }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    // A map sets up its own scheduler actions; drive them with a sink + idle.
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    expect(await result.key("vs").pull()).toEqual([1, 2, 3]);
    // The op was resolved by identity at least once (one per mapped row).
    expect(identityResolves).toBeGreaterThan(0);
    cancelSink();
  });

  it("fails loudly (no fallback output) when the sentinel cannot resolve", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);

    // The artifact index is session-lifetime (identity E4), so a genuine miss
    // means the op's module never evaluated in this session — a bug, not an
    // eviction. The sentinel carries NO embedded fallback graph anymore: the
    // map must fail loudly instead of silently running a stale graph.
    const pm = runtime.patternManager;
    let identityMisses = 0;
    pm.artifactFromIdentitySync = () => {
      identityMisses++;
      return undefined;
    };

    const resultCell = runtime.getCell<{ vs: number[] }>(
      space,
      "map op miss is loud",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      { items: [{ v: 4 }, { v: 5 }, { v: 6 }] },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    const cancelSink = result.sink(() => {});
    await runtime.idle();

    // The lookups missed and no fallback graph exists: no mapped output.
    expect(identityMisses).toBeGreaterThan(0);
    expect(result.key("vs").get()).not.toEqual([4, 5, 6]);
    cancelSink();
  });

  it("reloads a hoisted op by identity without recompiling", async () => {
    // A map's sub-pattern result cells carry the op's `{ identity, symbol }`,
    // where `symbol` is a HOIST (`__cfPattern_1`), not a module export. On reload
    // the by-identity path must resolve it from the in-memory artifact index,
    // with no cold source recompile (the "compiles=0 reload" contract the shell
    // piece test guards). Hoists aren't in `modulesByIdentity.exports`, so a
    // lookup that consulted only exports would resolve to undefined and
    // recompile.
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const pm = runtime.patternManager;
    const entryRef = pm.getArtifactEntryRef(compiled);
    expect(entryRef).toBeDefined();
    const missesBefore = pm.getCompileCacheStats().misses;

    const op = await pm.loadPatternByIdentity(
      entryRef!.identity,
      "__cfPattern_1",
      space,
    );

    expect(op).toBeDefined();
    // Resolved from the live in-memory index — no cold recompile.
    expect(pm.getCompileCacheStats().misses).toBe(missesBefore);
  });
});
