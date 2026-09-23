import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("nested-piece-setup-repair");
const space = signer.did();

// The argument object is OPEN and the piece is set up holding `limit: "ten"`,
// which V3 below declares as a NUMBER. That mismatch is deliberate: the repair
// re-runs setup for the pattern the pointer already names, so it would take the
// stale-marker re-stage branch if that branch were not opted out — and the
// re-stage validates. A repair that starts refusing here would be rewriting (or
// rejecting) the piece's own data on what is meant to be an internal-cell fix.
const V1_NO_HANDLER = [
  "import { Writable, pattern } from 'commonfabric';",
  "interface Args { [key: string]: any }",
  "export default pattern<Args, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count };",
  "});",
  "",
].join("\n");

// Identical result shape plus a `bump` handler. A doc set up for V1 has no
// manifest entry for `bump`'s stream and no result projection reaching it.
const V3_WITH_HANDLER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "interface Args { limit?: number; [key: string]: any }",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<Args, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("nested-piece-setup-repair", () => {
  // A nested piece — a profile mounted via a `#wish`, say — is instantiated by
  // the runtime's start walk with no setup phase of its own and no pattern
  // watcher armed to self-heal. Its stored doc can be set up for V1 and then
  // re-pointed at the handler-bearing V3 with no setup for V3: the setup
  // marker names V1 and the manifest lacks the stream V3's `bump` registers
  // on. `Runner.#startCore()` reads exactly that state and re-runs the pinned
  // pattern's OWN setup before instantiating — the same repair the home ROOT
  // gets in startEnsuredDefaultPattern, here for the nested pieces that never
  // pass through the PieceController. The repair moves no durable identity
  // pointer; it replays the pattern the pointer already names. The root itself
  // is excluded because its controller owns the repair; a nested piece is
  // never a space's `.defaultPattern`, so it heals here.

  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  // Set up for V1 (data + V1 internal cells), then re-point patternIdentity
  // at V3 without re-running setup. Returns the stopped piece cell, ready to
  // start. `marker` says what the setup-completion marker is left naming: the
  // V1 that setup stamped, nothing at all (a doc set up before the marker
  // existed), or V3 (a claim that V3's setup ran).
  const nestedPieceSetUpForV1 = async (
    rt: Runtime,
    marker: "v1" | "absent" | "v3" = "v1",
  ) => {
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(programOf(V1_NO_HANDLER), { space, tx });
    const v3 = await pm.compilePattern(programOf(V3_WITH_HANDLER), {
      space,
      tx,
    });
    const v3Ref = pm.getArtifactEntryRef(v3)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "nested-piece-set-up-for-v1",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { limit: "ten" }, cell);
    await tx.commit();
    await running.pull();
    rt.runner.stop(cell);
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v3Ref.identity,
      symbol: v3Ref.symbol,
    }, rawMetaWriteAuthorization);
    if (marker !== "v1") {
      cell.withTx(tx2).setMetaRaw(
        "patternSetupIdentity",
        marker === "v3"
          ? { identity: v3Ref.identity, symbol: v3Ref.symbol }
          : undefined,
        rawMetaWriteAuthorization,
      );
    }
    await tx2.commit();
    return { cell, v3Ref };
  };

  const setupMarkerOf = (cell: unknown) =>
    (cell as { getMetaRaw: (k: string) => unknown }).getMetaRaw(
      "patternSetupIdentity",
    ) as { identity?: string } | undefined;

  const manifestOf = (cell: unknown) =>
    (cell as { getMetaRaw: (k: string) => unknown }).getMetaRaw(
      "internal",
    ) as unknown[];

  const bumpAndCount = async (cell: Cell<Record<string, unknown>>) => {
    const before = (cell.getAsQueryResult() as { count: number }).count;
    (cell.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await cell.pull();
    return (cell.getAsQueryResult() as { count: number }).count - before;
  };

  it("heals a nested piece whose doc carries no setup marker", async () => {
    // A doc set up before the marker existed drifts the same way and has
    // nothing naming another version, only a manifest that lacks the stream.
    const rt = newRuntime();
    try {
      const { cell } = await nestedPieceSetUpForV1(rt, "absent");
      expect(await rt.start(cell)).toBe(true);
      await cell.pull();
      expect(await bumpAndCount(cell)).toBe(1);
      await rt.storageManager.synced();
    } finally {
      await rt.dispose();
    }
  });

  it("leaves the setup marker naming the version that staged the argument", async () => {
    // The repair stages internal cells and the result projection, and leaves
    // the argument alone. A marker naming V3 would tell the next setup for V3
    // that its argument was staged and validated, and it was not.
    const rt = newRuntime();
    try {
      const { cell, v3Ref } = await nestedPieceSetUpForV1(rt);
      const staged = setupMarkerOf(cell)?.identity;
      expect(staged).toBeDefined();
      expect(staged).not.toBe(v3Ref.identity);

      expect(await rt.start(cell)).toBe(true);
      await cell.pull();
      expect(await bumpAndCount(cell)).toBe(1);
      await rt.storageManager.synced();

      expect(setupMarkerOf(cell)?.identity).toBe(staged);
    } finally {
      await rt.dispose();
    }
  });

  it("repairs nothing when the setup marker already names the pattern", async () => {
    // The marker is the one piece of evidence that this version's setup ran,
    // so a start trusts it and writes no setup of its own.
    const rt = newRuntime();
    try {
      const { cell } = await nestedPieceSetUpForV1(rt, "v3");
      const manifest = manifestOf(cell);

      expect(await rt.start(cell)).toBe(true);
      await cell.pull();
      await rt.storageManager.synced();

      expect(manifestOf(cell)).toEqual(manifest);
    } finally {
      await rt.dispose();
    }
  });

  it("heals a nested piece by re-running its setup on start", async () => {
    const rt = newRuntime();
    try {
      const { cell, v3Ref } = await nestedPieceSetUpForV1(rt);
      // Starts WITHOUT throwing: the setup repair materializes the missing
      // internal cells for V3, then instantiation succeeds.
      const started = await rt.start(cell);
      expect(started).toBe(true);
      await cell.pull();
      // The identity is still V3 (a re-setup, not a roll-forward)…
      const idRaw = (cell as unknown as {
        getMetaRaw: (k: string) => unknown;
      }).getMetaRaw("patternIdentity") as { identity?: string } | undefined;
      expect(idRaw?.identity).toBe(v3Ref.identity);
      // …and the piece's own data is untouched. This repair materializes
      // missing internal cells; it must not re-point or re-validate the stored
      // argument, which is what makes it safe to run on an ordinary start. The
      // stored `limit` violates V3's declared type, so a repair that re-staged
      // would either rewrite this doc or refuse the start outright.
      const argumentLink = getMetaLink(cell as never, "argument")!;
      expect(
        rt.getCellFromLink(argumentLink).getRaw(),
        "the internal-cell repair rewrote or rejected the piece's stored " +
          "argument — it is meant to leave the piece's data alone",
      ).toEqual({ limit: "ten" });
      // …and the once-missing handler stream now fires end to end.
      const before = (cell.getAsQueryResult() as { count: number }).count;
      (cell.key("bump") as unknown as { send: (e: unknown) => void }).send({});
      await cell.pull();
      const after = (cell.getAsQueryResult() as { count: number }).count;
      expect(after).toBe(before + 1);
    } finally {
      await rt.dispose();
    }
  });

  it("leaves a keyless piece alone: its session pointer is its setup marker", async () => {
    // A keyless pattern's identity never reaches durable state, so its doc
    // carries neither `patternSetupIdentity` nor a durable `patternIdentity`.
    // Its setup evidence is the session pointer, and the repair trigger reads
    // the marker through it. Read without it, a keyless piece whose manifest
    // does not cover its pattern would be staged for repair and then refused
    // by the precondition, which re-reads a durable identity it never had.
    const rt = newRuntime();
    try {
      const keyless = {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { count: { type: "number" } },
        },
        result: { count: { $alias: { partialCause: "count", path: [] } } },
        derivedInternalCells: [{
          partialCause: "count",
          schema: { type: "number", default: 3 },
        }],
        nodes: [],
      };
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "keyless-not-repaired",
        undefined,
        tx,
      );
      const running = rt.run(tx, keyless as never, {}, cell);
      await tx.commit();
      await running.pull();
      rt.runner.stop(cell);
      // The stored state drifted: the manifest no longer names the pattern's
      // derived cell, which is what turns the repair on for a keyed piece.
      const tx2 = rt.edit();
      cell.withTx(tx2).setMetaRaw(
        "internal",
        undefined,
        rawMetaWriteAuthorization,
      );
      await tx2.commit();

      expect(await rt.start(cell)).toBe(true);
      await cell.pull();
      expect((cell.getAsQueryResult() as { count: number }).count).toBe(3);
    } finally {
      await rt.dispose();
    }
  });
});
