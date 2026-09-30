// Server-execution v2 stage C tuning, T1: the flow-label relevance probe
// (`flowLabelWorkExists`) is evaluated ONCE per commit, not twice.
//
// The commit chokepoint (`ExtendedStorageTransaction.commit`) and
// `Runtime.prepareTxForCommit` both ask "did this tx observe or write a
// labeled doc?" on the same unprepared, not-yet-relevant transaction, back
// to back (`startReactiveActionCommit` calls the one then the other). The
// probe walks every read activity against every dereference trace
// (`forEachFlowObservation` → `isPrefix`) — evaluated twice per commit it
// was 65 % of a saturated client worker on the ON note-create series
// (stage-c-attribution-report §2c). The negative verdict is now memoized
// on the transaction (`probeFlowLabelWork`) and stays valid until the tx
// journals any further read, write, dereference trace or trigger read.
//
// Pins:
// - the common shape (prepareTxForCommit then commit, nothing between)
//   evaluates the probe ONCE and answers the second ask from the memo;
// - a read or a write between the two asks INVALIDATES the memo (the
//   second ask re-evaluates) — a memo must never outlive the activity it
//   was taken over;
// - the memo never hides a positive verdict: a labeled read makes the tx
//   relevant on the first ask, and the second ask does not probe at all;
// - the OFF arm and a flag-ON client are the same code: verdicts are
//   unchanged (the memo is a cache of a deterministic function), and the
//   probe count halves in both — the existing flow-label suites pin the
//   verdicts.

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { flowLabelWorkExists } from "../src/cfc/prepare.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-probe-memo");

const newRuntime = (options: { serverExecution?: boolean } = {}) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // The probe runs only while the flow dial is on. Every count assertion
    // below reads the counters that probe increments.
    cfcFlowLabels: "persist",
    ...(options.serverExecution
      ? { experimental: { serverExecution: true } }
      : {}),
  });
  return { runtime, storageManager };
};

const probeCounts = (runtime: Runtime) => {
  const stats = runtime.getCfcStats();
  return {
    computed: stats.flowLabelProbesComputed,
    memo: stats.flowLabelProbeMemoHits,
  };
};

describe("CFC flow-label probe memo (stage C tuning T1)", () => {
  it("keeps repeated negative relevance checks separate from later read classes", async () => {
    const { runtime, storageManager } = newRuntime();
    try {
      const seed = runtime.edit();
      const address = runtime.getCell(
        signer.did(),
        "class-relevance",
        undefined,
      )
        .getAsNormalizedFullLink();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, { ...address, path: [] }, {
        value: {},
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: Array.from({ length: 40 }, (_, index) => ({
              path: [`field-${index}`],
              observes: "value",
              label: { confidentiality: ["secret"] },
            })),
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();
      const tx = runtime.edit();
      try {
        for (let index = 0; index < 40; index++) {
          tx.readOrThrow({ ...address, path: ["value", `field-${index}`] }, {
            nonRecursive: true,
          });
        }
        expect(flowLabelWorkExists(tx)).toBe(false);
        tx.readOrThrow({ ...address, path: ["value"] }, {
          meta: linkResolutionProbe,
        });
        expect(flowLabelWorkExists(tx)).toBe(false);
        tx.readOrThrow({ ...address, path: ["value"] });
        expect(flowLabelWorkExists(tx)).toBe(true);
      } finally {
        tx.abort();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("prepareTxForCommit then commit evaluate the probe ONCE: the second ask is a memo hit", async () => {
    const { runtime, storageManager } = newRuntime();
    try {
      const tx = runtime.edit();
      const a = runtime.getCell(signer.did(), "probe-memo-a", undefined, tx);
      const b = runtime.getCell(signer.did(), "probe-memo-b", undefined, tx);
      // Plain, unlabeled reads and a write: the probe's negative shape.
      a.getRaw();
      b.set({ v: 1 });
      const before = probeCounts(runtime);
      runtime.prepareTxForCommit(tx);
      const afterPrepare = probeCounts(runtime);
      expect(afterPrepare.computed - before.computed).toBe(1);
      expect(afterPrepare.memo - before.memo).toBe(0);
      expect((await tx.commit()).ok).toBeDefined();
      const afterCommit = probeCounts(runtime);
      // ONE evaluation for the whole commit; the chokepoint hit the memo.
      expect(afterCommit.computed - before.computed).toBe(1);
      expect(afterCommit.memo - before.memo).toBe(1);
      expect(tx.getCfcState().relevant).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a read between the two asks INVALIDATES the memo: the commit chokepoint re-evaluates (the memo never outlives the activity it was taken over)", async () => {
    const { runtime, storageManager } = newRuntime();
    try {
      const tx = runtime.edit();
      const a = runtime.getCell(
        signer.did(),
        "probe-memo-inv-a",
        undefined,
        tx,
      );
      const b = runtime.getCell(
        signer.did(),
        "probe-memo-inv-b",
        undefined,
        tx,
      );
      const c = runtime.getCell(
        signer.did(),
        "probe-memo-inv-c",
        undefined,
        tx,
      );
      a.getRaw();
      b.set({ v: 1 });
      const before = probeCounts(runtime);
      runtime.prepareTxForCommit(tx);
      // Activity after the first ask: a further read.
      c.getRaw();
      expect((await tx.commit()).ok).toBeDefined();
      const after = probeCounts(runtime);
      expect(after.computed - before.computed).toBe(2);
      expect(after.memo - before.memo).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a write between the two asks INVALIDATES the memo too", async () => {
    const { runtime, storageManager } = newRuntime();
    try {
      const tx = runtime.edit();
      const a = runtime.getCell(signer.did(), "probe-memo-w-a", undefined, tx);
      const b = runtime.getCell(signer.did(), "probe-memo-w-b", undefined, tx);
      a.getRaw();
      b.set({ v: 1 });
      const before = probeCounts(runtime);
      runtime.prepareTxForCommit(tx);
      b.set({ v: 2 });
      expect((await tx.commit()).ok).toBeDefined();
      const after = probeCounts(runtime);
      expect(after.computed - before.computed).toBe(2);
      expect(after.memo - before.memo).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the memo never hides a positive verdict: a labeled read marks the tx relevant on the first ask and the second ask does not probe", async () => {
    const { runtime, storageManager } = newRuntime();
    try {
      // Doc A: a labeled source (the S16 laundering seed). Its atom is the
      // audience of the space every document here lives in, so the copy
      // below lands inside the audience it came from.
      const seed = runtime.edit();
      const sourceId = runtime.getCell(
        signer.did(),
        "probe-memo-labeled-source",
        undefined,
      ).getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: [cfcAtom.space(signer.did())] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "probe-memo-labeled-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");
      const derived = runtime.getCell(
        signer.did(),
        "probe-memo-labeled-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      const before = probeCounts(runtime);
      runtime.prepareTxForCommit(tx);
      expect(tx.getCfcState().relevant).toBe(true);
      expect((await tx.commit()).ok).toBeDefined();
      const after = probeCounts(runtime);
      // One evaluation (positive), zero memo hits: a relevant tx is not
      // probed again by anyone.
      expect(after.computed - before.computed).toBe(1);
      expect(after.memo - before.memo).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a write over a labeled path marks the tx relevant with no labeled read", async () => {
    // The probe answers on the write side too: a transaction that reads
    // nothing labeled, but overwrites a path in a document that carries
    // stored label entries, still has flow-label work to do. Reaching that
    // check means walking past the read side with nothing to report.
    const { runtime, storageManager } = newRuntime();
    try {
      const seed = runtime.edit();
      const targetId = runtime.getCell(
        signer.did(),
        "probe-memo-write-target",
        undefined,
      ).getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: [cfcAtom.space(signer.did())] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value", "note"],
      }, "a sibling the label map does not name");
      // Committed without `prepareTxForCommit`, so the commit chokepoint is
      // the first to ask. The probe answers yes, marks the transaction
      // relevant, and the same step prepares it.
      const before = probeCounts(runtime);
      expect(tx.getCfcState().relevant).toBe(false);
      expect((await tx.commit()).error).toBeUndefined();
      expect(tx.getCfcState().relevant).toBe(true);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      const after = probeCounts(runtime);
      expect(after.computed - before.computed).toBe(1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the OFF arm and a flag-ON client share the shape: every evaluation is paired with exactly one memo hit — no transaction probes twice in either arm (verdicts pinned by the flow-label suites)", async () => {
    for (const serverExecution of [false, true]) {
      const { runtime, storageManager } = newRuntime({ serverExecution });
      try {
        const tx = runtime.edit();
        const a = runtime.getCell(
          signer.did(),
          "probe-memo-arm-a",
          undefined,
          tx,
        );
        const b = runtime.getCell(
          signer.did(),
          "probe-memo-arm-b",
          undefined,
          tx,
        );
        a.getRaw();
        b.set({ v: 1 });
        const before = probeCounts(runtime);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).ok).toBeDefined();
        const after = probeCounts(runtime);
        // The OFF arm commits exactly this one transaction; a flag-ON
        // client's commit also rides a couple of runtime-internal
        // transactions (each prepared then committed the same way), so
        // the arm-independent pin is the PAIRING: computed === memo hits.
        expect(after.computed - before.computed).toBeGreaterThanOrEqual(1);
        expect(after.memo - before.memo).toBe(after.computed - before.computed);
        if (!serverExecution) {
          expect(after.computed - before.computed).toBe(1);
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    }
  });
});
