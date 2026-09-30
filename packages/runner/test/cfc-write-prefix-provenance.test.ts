import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import { preparedDigestFor, type PreparedDigestInput } from "../src/cfc/mod.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-write-prefix");

// Epic D4 — per-write read-prefix provenance
// (docs/specs/cfc-write-prefix-provenance.md). The requiredIntegrity /
// maxConfidentiality input checks quantify over each protected write's READ
// PREFIX: the labeled reads whose activity-clock position precedes the LAST
// write attempt overlapping the protected path (either prefix direction —
// the same overlap floor applicability uses). The doc's §7.5 red-first list
// is pinned here:
//   - the §3 re-attempt counterexample REJECTS (and would pass under the
//     unsound first-attempt bound — a regression guard);
//   - the §4 child-write aliasing counterexample REJECTS (and would pass
//     under exact-path last-write keying);
//   - a read past the last overlapping write no longer gates (the precision
//     payoff — this rejected under the pre-D4 transaction-global gate);
//   - trigger reads sit at -Infinity and join EVERY write's prefix;
//   - an empty-prefix floored write is decided by the D3 value-side floor
//     under its dial (the #14 vacuous-pass resolution — see the comment in
//     verifyInputRequirements);
//   - a post-prepare reorder of the interleaving invalidates (digest tests).

const FLOOR_ATOM = "prefix-endorsed";
const OTHER_ATOM = "prefix-unrelated";

const SINK_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [FLOOR_ATOM] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

// requiredIntegrity on a CONTAINER path, so a child write (out.deep) must be
// matched by the both-directions overlap (doc §4's aliasing counterexample).
const NESTED_SINK_SCHEMA = {
  type: "object",
  properties: {
    out: {
      type: "object",
      properties: { deep: { type: "string" } },
      required: ["deep"],
      ifc: { requiredIntegrity: [FLOOR_ATOM] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const MINT_SINK_SCHEMA = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: {
        requiredIntegrity: [FLOOR_ATOM],
        addIntegrity: [FLOOR_ATOM],
      },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const makeRuntime = (options: {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  cfcTriggerReadGating?: boolean;
  cfcWriteFloor?: "off" | "observe" | "enforce";
}): Runtime =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: options.storageManager,
    ...(options.cfcTriggerReadGating !== undefined
      ? { cfcTriggerReadGating: options.cfcTriggerReadGating }
      : {}),
    // The subject here is prefix-provenance measurement, so unless an arm
    // dials the floor itself it measures but does not decide.
    cfcWriteFloor: options.cfcWriteFloor ?? "observe",
  });

// Seed a doc's stored CFC metadata directly via an ungated path-[]
// full-document write (how the runtime persists it), so a later read picks
// up the given label.
const seedLabeledDoc = async (
  runtime: Runtime,
  id: string,
  value: FabricValue,
  label: IFCLabel,
): Promise<void> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  writeSeedEnvelopeDoc(seed, signer.did());
  seedStoredEnvelope(seed, {
    space: signer.did(),
    id: docId,
    type: "application/json",
    path: [],
  }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: [{ path: [], label }] },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

// Seed a plain (label-less) doc so a later write in the test tx diffs to the
// EXACT changed path instead of a fresh-doc root write — the §3/§4
// counterexamples need writes at specific paths to differentiate the bounds.
const seedPlainDoc = async (
  runtime: Runtime,
  id: string,
  value: FabricValue,
): Promise<void> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  seed.writeOrThrow({
    space: signer.did(),
    id: docId,
    type: "application/json",
    path: [],
  }, { value });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC write-prefix provenance (D4, doc §4/§5)", () => {
  it("§3 re-attempt: a low-integrity read between two writes to the same path rejects (last-overlapping-write bound)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager });
    try {
      await seedLabeledDoc(runtime, "d4-s3-endorsed", "endorsed", {
        integrity: [FLOOR_ATOM],
      });
      await seedLabeledDoc(runtime, "d4-s3-low", "tainted", {
        integrity: [OTHER_ATOM],
      });
      await seedPlainDoc(runtime, "d4-s3-sink", { out: "seed" });

      const tx = runtime.edit();
      // journal: read E (endorsed) | write out = "a" | read R (low) |
      // re-write out = "b". The committed value's last overlapping write is
      // the RE-ATTEMPT, so R is in its prefix and fails the floor. Under the
      // plan's original first-attempt bound the prefix would stop at the
      // first write — {E} only — and this taint escape would COMMIT (doc
      // §3); this test is the regression guard against that bound.
      runtime.getCell(signer.did(), "d4-s3-endorsed", undefined, tx).get();
      const sink = runtime.getCell(signer.did(), "d4-s3-sink", SINK_SCHEMA, tx);
      sink.set({ out: "a" });
      runtime.getCell(signer.did(), "d4-s3-low", undefined, tx).get();
      sink.set({ out: "b" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("§4 aliasing: a low-integrity read before a CHILD write inside the protected subtree rejects (overlap, not exact-path)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager });
    try {
      await seedLabeledDoc(runtime, "d4-s4-endorsed", "endorsed", {
        integrity: [FLOOR_ATOM],
      });
      await seedLabeledDoc(runtime, "d4-s4-low", "tainted", {
        integrity: [OTHER_ATOM],
      });
      await seedPlainDoc(runtime, "d4-s4-sink", { out: { deep: "seed" } });

      const tx = runtime.edit();
      // journal: read E | write out = {deep:"a"} (exactly at /out) | read R |
      // write out.deep = "b". The floored value at /out is finalized by the
      // CHILD write — a later OVERLAPPING write — so R gates it and fails.
      // A bound keyed on the exact address /out would stop at the first
      // write and let R's taint into the committed subtree (doc §4).
      runtime.getCell(signer.did(), "d4-s4-endorsed", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "d4-s4-sink",
        NESTED_SINK_SCHEMA,
        tx,
      );
      sink.key("out").set({ deep: "a" });
      runtime.getCell(signer.did(), "d4-s4-low", undefined, tx).get();
      sink.key("out").key("deep").set("b");

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a read past the last overlapping write no longer gates (the S7-narrowing payoff; rejected pre-D4)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager });
    try {
      await seedLabeledDoc(runtime, "d4-post-endorsed", "endorsed", {
        integrity: [FLOOR_ATOM],
      });
      await seedLabeledDoc(runtime, "d4-post-low", "tainted", {
        integrity: [OTHER_ATOM],
      });
      await seedPlainDoc(runtime, "d4-post-sink", { out: "seed" });

      const tx = runtime.edit();
      // journal: read E | write out = "a" | read R. R happens AFTER the last
      // write overlapping /out — nothing recomputes the value from it, so it
      // provably did not feed the committed value (doc §4's structural
      // argument) and must not gate. The pre-D4 transaction-global gate
      // rejected exactly this shape (the S7 false-reject class).
      runtime.getCell(signer.did(), "d4-post-endorsed", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "d4-post-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "a" });
      runtime.getCell(signer.did(), "d4-post-low", undefined, tx).get();

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a provenance-only read within the prefix still does not gate (S7 exemption, scoped)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager });
    try {
      // The ported group-chat regression shape: the admin-grant lookup reads
      // structural provenance (a link reference + a current-principal
      // claim), then writes the protected list. The lookup is IN the write's
      // prefix, so only the provenance exemption keeps it out of the gate.
      await seedLabeledDoc(runtime, "d4-prov-lookup", "lookup", {
        integrity: [
          { kind: "represents-principal", subject: signer.did() },
          { type: "https://commonfabric.org/cfc/atom/LinkReference" },
        ],
      });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "d4-prov-lookup", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "d4-prov-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "granted" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("trigger reads sit at -Infinity: they gate a write no ordinary read precedes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcTriggerReadGating: true });
    try {
      await seedLabeledDoc(runtime, "d4-trigger-dep", "changed", {
        integrity: [OTHER_ATOM],
      });
      const depId = (() => {
        const probe = runtime.edit();
        const id = runtime.getCell(
          signer.did(),
          "d4-trigger-dep",
          undefined,
          probe,
        )
          .getAsNormalizedFullLink().id as URI;
        probe.abort();
        return id;
      })();

      const tx = runtime.edit();
      // The protected write is the FIRST activity in the transaction — its
      // prefix contains no ordinary read. The trigger read (the address
      // whose invalidating write scheduled the run, §8.9.2) has no journal
      // position; it logically precedes every write and must join THIS
      // write's prefix too. If trigger reads were stamped at their
      // recording time (after the write) they would escape the per-write
      // gate — the scheduling channel the -Infinity rule closes.
      const sink = runtime.getCell(
        signer.did(),
        "d4-trigger-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "scheduled" });
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id: depId,
        type: "application/json",
        path: ["value"],
      }]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("empty prefix + floor enforce + no credited value rejects via the D3 floor (the #14 end state)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      // No labeled read anywhere: the write's prefix is empty. The read gate
      // delegates the vacuous case to the value-side floor (same entry, same
      // derivation), which rejects an uncredited value under its dial — the
      // audit-#14 "no endorsed input" end state, staged exactly like the
      // rest of D3.
      const sink = runtime.getCell(
        signer.did(),
        "d4-vacuous-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "fabricated" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "write floor failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("empty prefix + floor enforce + a minted value commits (the generator idiom keeps working)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager, cfcWriteFloor: "enforce" });
    try {
      const tx = runtime.edit();
      const sink = runtime.getCell(
        signer.did(),
        "d4-mint-sink",
        MINT_SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "minted" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("CFC write-prefix digest binding (D4, doc §6)", () => {
  const address = (id: string, ...path: string[]) => ({
    space: signer.did(),
    scope: "space" as const,
    id: `of:${id}`,
    path,
  });

  const baseInput = (
    overrides: Partial<PreparedDigestInput>,
  ): PreparedDigestInput => ({
    consumedReads: [],
    attemptedWrites: [],
    writes: [],
    writeAttemptLog: [],
    dereferenceTraces: [],
    triggerReads: [],
    writePolicyInputs: [],
    implementationIdentity: undefined,
    trustSnapshot: undefined,
    ...overrides,
  });

  it("swapping two write attempts' order flips the digest (same address sets)", () => {
    // canonicalizePreparedDigestInput sorts reads/writes by ADDRESS — order
    // is discarded there, which is exactly why the attempt log must carry
    // it: the gate's bound is the LAST overlapping write, so a post-prepare
    // reorder that swaps which write is last changes the decision and MUST
    // invalidate (audit S2 shape).
    const a = address("doc", "value", "x");
    const b = address("doc", "value", "y");
    const forward = baseInput({
      writeAttemptLog: [
        { ...a, journalIndex: 0 },
        { ...b, journalIndex: 1 },
      ],
    });
    const swapped = baseInput({
      writeAttemptLog: [
        { ...b, journalIndex: 0 },
        { ...a, journalIndex: 1 },
      ],
    });
    expect(preparedDigestFor(forward)).not.toBe(preparedDigestFor(swapped));
    // Sanity: identical content digests identically, regardless of the list
    // order it is presented in (canonicalization sorts by journalIndex).
    const shuffled = baseInput({
      writeAttemptLog: [
        { ...b, journalIndex: 1 },
        { ...a, journalIndex: 0 },
      ],
    });
    expect(preparedDigestFor(forward)).toBe(preparedDigestFor(shuffled));
  });

  it("moving a read across a write attempt flips the digest (read positions are bound)", () => {
    // With consumedReads sorted by address and carrying no position, a
    // post-prepare reorder that moves a read from one side of a write to
    // the other would flip its prefix membership WITHOUT changing the
    // digest — the doc §6 amendment adds read positions for exactly this.
    const read = address("src", "value", "in");
    const write = { ...address("doc", "value", "x"), journalIndex: 1 };
    const before = baseInput({
      consumedReads: [{ ...read, meta: {}, journalIndex: 0 }],
      writeAttemptLog: [write],
    });
    const after = baseInput({
      consumedReads: [{ ...read, meta: {}, journalIndex: 2 }],
      writeAttemptLog: [write],
    });
    expect(preparedDigestFor(before)).not.toBe(preparedDigestFor(after));
  });
});
