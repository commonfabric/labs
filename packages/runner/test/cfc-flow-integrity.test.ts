import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CfcAtom } from "@commonfabric/api/cfc";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { atomPropagationClass } from "../src/cfc/atom-classes.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-integrity");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: IFCLabel;
  origin?: string;
};

const certified = (policy: string) => ({
  type: CFC_ATOM_TYPE.PolicyCertified,
  policy,
});

describe("CFC flow labels: integrity propagation (phase C)", () => {
  // S16 phase C: integrity propagation through the default transition —
  // class-aware hereditary meet (§8.9.3/§3.1.6.2: an output is certified only
  // when every observed input was) plus runtime-minted TransformedBy derivation
  // provenance.

  const makeRuntime = () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Persisting flow labels is what writes the `origin: "derived"` entries
      // that `derivedIntegrity` reads back in every test here.
      cfcFlowLabels: "persist",
    });
    return { storageManager, runtime };
  };

  const seedDoc = async (
    runtime: Runtime,
    cause: string,
    integrity: CfcAtom[],
  ): Promise<string> => {
    const seed = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { n: 1 },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { integrity } }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return id;
  };

  const entriesOf = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): StoredEntry[] => {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const derivedIntegrity = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): unknown[] =>
    entriesOf(storageManager, id)
      .filter((e) => e.origin === "derived")
      .flatMap((e) => e.label.integrity ?? []);

  it("classifies atoms with a fail-safe default", () => {
    expect(atomPropagationClass(certified("p"))).toBe("hereditary");
    expect(atomPropagationClass({ type: CFC_ATOM_TYPE.InjectionSafe }))
      .toBe("value-bound");
    expect(atomPropagationClass({ type: CFC_ATOM_TYPE.Builtin, name: "x" }))
      .toBe("provenance");
    // External-ingest is origin provenance (like UserSurfaceInput): the
    // channel is vouched, the contents are not, so it never propagates.
    expect(atomPropagationClass({ type: CFC_ATOM_TYPE.ExternalIngest }))
      .toBe("provenance");
    // Unknown record types, plain strings, kind-shaped records: value-bound.
    expect(atomPropagationClass({ type: "https://example.com/custom" }))
      .toBe("value-bound");
    expect(atomPropagationClass("trusted")).toBe("value-bound");
    expect(atomPropagationClass({ kind: "authored-by", subject: "x" }))
      .toBe("value-bound");
  });

  it("propagates hereditary atoms only when every observed input carries them", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      await seedDoc(runtime, "flow-int-a", [
        certified("p1"),
        { type: CFC_ATOM_TYPE.InjectionSafe },
        "value-bound-ish",
      ]);
      await seedDoc(runtime, "flow-int-b", [
        certified("p1"),
        certified("p2"),
      ]);

      const tx = runtime.edit();
      const a = runtime.getCell(space, "flow-int-a", undefined, tx);
      const b = runtime.getCell(space, "flow-int-b", undefined, tx);
      const rawA = a.getRaw() as { n: number };
      const rawB = b.getRaw() as { n: number };
      // Raw write: `cell.set()` journals a read of the (unlabeled) target
      // doc's prior value, and the weakest-link meet rightly empties on any
      // uncertified observation. A read-free write keeps the observation
      // set to exactly the two certified inputs.
      const out = runtime.getCell(space, "flow-int-out", undefined, tx);
      const outId = out.getAsNormalizedFullLink().id;
      tx.writeOrThrow(
        { space, scope: "space", id: outId, path: ["value"] },
        { sum: rawA.n + rawB.n },
      );
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const integrity = derivedIntegrity(storageManager, outId);
      // p1 on every input: survives the meet. p2 only on B: dropped.
      // Value-bound atoms never propagate.
      expect(integrity).toContainEqual(certified("p1"));
      expect(integrity).not.toContainEqual(certified("p2"));
      expect(integrity).not.toContainEqual({
        type: CFC_ATOM_TYPE.InjectionSafe,
      });
      expect(integrity).not.toContainEqual("value-bound-ish");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("empties the meet when any observed input lacks the atom (weakest link)", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      await seedDoc(runtime, "flow-wl-a", [certified("p1")]);
      // Doc B carries a confidentiality label (so it resolves) but NO
      // certification. The clause names this space, the audience a document
      // living in it already reaches, so the label flows onto the output
      // without that output declaring a ceiling of its own.
      const seed = runtime.edit();
      const bCell = runtime.getCell(space, "flow-wl-b", undefined, seed);
      const bId = bCell.getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, { space, scope: "space", id: bId, path: [] }, {
        value: { n: 2 },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: [cfcAtom.space(space)] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const a = runtime.getCell(space, "flow-wl-a", undefined, tx);
      const b = runtime.getCell(space, "flow-wl-b", undefined, tx);
      const rawA = a.getRaw() as { n: number };
      const rawB = b.getRaw() as { n: number };
      const out = runtime.getCell(space, "flow-wl-out", undefined, tx);
      out.set({ sum: rawA.n + rawB.n });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const integrity = derivedIntegrity(
        storageManager,
        out.getAsNormalizedFullLink().id,
      );
      expect(integrity).not.toContainEqual(certified("p1"));
      // The confidentiality still flows.
      const conf = entriesOf(storageManager, out.getAsNormalizedFullLink().id)
        .filter((e) => e.origin === "derived")
        .flatMap((e) => e.label.confidentiality ?? []);
      expect(conf).toContainEqual(cfcAtom.space(space));
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("mints TransformedBy with the transaction's implementation identity", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      await seedDoc(runtime, "flow-tb-src", [certified("p1")]);

      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "flow-test-builtin",
      });
      const src = runtime.getCell(space, "flow-tb-src", undefined, tx);
      const raw = src.getRaw() as { n: number };
      const out = runtime.getCell(space, "flow-tb-out", undefined, tx);
      const outId = out.getAsNormalizedFullLink().id;
      tx.writeOrThrow(
        { space, scope: "space", id: outId, path: ["value"] },
        { copied: raw.n },
      );
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const integrity = derivedIntegrity(storageManager, outId);
      expect(integrity).toContainEqual({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: { kind: "builtin", builtinId: "flow-test-builtin" },
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // TransformedBy is an attribution claim, and the flow stage operates at tx
  // granularity (one join stamped on every written doc). The claim is only
  // honest when every write in the tx was authored under the same defined
  // identity — captured at write time, like `writePolicyInputIdentities`
  // ("a later run in the same transaction may change the identity"). Any
  // ambiguity omits the atom: a fail-safe under-claim, never a borrowed one.
  const isTransformedBy = (atom: unknown): boolean =>
    (atom as { type?: string } | null)?.type === CFC_ATOM_TYPE.TransformedBy;

  it("omits TransformedBy when writes span multiple identities (no borrowing)", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      await seedDoc(runtime, "flow-tb-multi-src", [certified("p1")]);

      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "writer.x",
      });
      const src = runtime.getCell(space, "flow-tb-multi-src", undefined, tx);
      const raw = src.getRaw() as { n: number };
      const out1 = runtime.getCell(space, "flow-tb-multi-out1", undefined, tx);
      const out1Id = out1.getAsNormalizedFullLink().id;
      tx.writeOrThrow(
        { space, scope: "space", id: out1Id, path: ["value"] },
        { copied: raw.n },
      );
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "writer.y",
      });
      const out2 = runtime.getCell(space, "flow-tb-multi-out2", undefined, tx);
      const out2Id = out2.getAsNormalizedFullLink().id;
      tx.writeOrThrow(
        { space, scope: "space", id: out2Id, path: ["value"] },
        { copied: raw.n },
      );
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      for (const id of [out1Id, out2Id]) {
        const integrity = derivedIntegrity(storageManager, id);
        // The hereditary meet still flows...
        expect(integrity).toContainEqual(certified("p1"));
        // ...but stamping the per-tx join with the last-active identity
        // would attribute writer.x's output to writer.y.
        expect(integrity.some(isTransformedBy)).toBe(false);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("omits TransformedBy when a write predates the first identity (unattributed)", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      await seedDoc(runtime, "flow-tb-unattr-src", [certified("p1")]);

      const tx = runtime.edit();
      const src = runtime.getCell(space, "flow-tb-unattr-src", undefined, tx);
      const raw = src.getRaw() as { n: number };
      const out1 = runtime.getCell(space, "flow-tb-unattr-out1", undefined, tx);
      const out1Id = out1.getAsNormalizedFullLink().id;
      // Unattributed write: no implementation identity has been set yet.
      tx.writeOrThrow(
        { space, scope: "space", id: out1Id, path: ["value"] },
        { copied: raw.n },
      );
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "late-identity",
      });
      const out2 = runtime.getCell(space, "flow-tb-unattr-out2", undefined, tx);
      const out2Id = out2.getAsNormalizedFullLink().id;
      tx.writeOrThrow(
        { space, scope: "space", id: out2Id, path: ["value"] },
        { copied: raw.n },
      );
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      // The unattributed write must not borrow the later trusted identity.
      for (const id of [out1Id, out2Id]) {
        const integrity = derivedIntegrity(storageManager, id);
        expect(integrity).toContainEqual(certified("p1"));
        expect(integrity.some(isTransformedBy)).toBe(false);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("attributes TransformedBy to the identity that authored the writes, not the one current at prepare", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      await seedDoc(runtime, "flow-tb-author-src", [certified("p1")]);

      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "the-author",
      });
      const src = runtime.getCell(space, "flow-tb-author-src", undefined, tx);
      const raw = src.getRaw() as { n: number };
      const out = runtime.getCell(space, "flow-tb-author-out", undefined, tx);
      const outId = out.getAsNormalizedFullLink().id;
      tx.writeOrThrow(
        { space, scope: "space", id: outId, path: ["value"] },
        { copied: raw.n },
      );
      // A later run in the same tx changes the identity but writes nothing:
      // the write-authoring identity is still uniform.
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "the-bystander",
      });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const integrity = derivedIntegrity(storageManager, outId);
      expect(integrity).toContainEqual({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: { kind: "builtin", builtinId: "the-author" },
      });
      expect(integrity).not.toContainEqual({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: { kind: "builtin", builtinId: "the-bystander" },
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("strips schema-forged PolicyCertified and TransformedBy (runtime-minted gate)", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const forged = internSchema(
        {
          type: "object",
          properties: {
            field: {
              type: "string",
              ifc: {
                integrity: [
                  certified("forged"),
                  { type: CFC_ATOM_TYPE.TransformedBy, identity: "fake" },
                  "plain-claim",
                ],
              },
            },
          },
          required: ["field"],
        } satisfies JSONSchema,
        true,
      );
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "flow-forge", forged.schema, tx);
      cell.set({ field: "hello" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const declared = entriesOf(
        storageManager,
        cell.getAsNormalizedFullLink().id,
      ).filter((e) => e.origin === "declared").flatMap((e) =>
        e.label.integrity ?? []
      );
      expect(declared).toContainEqual("plain-claim");
      expect(declared).not.toContainEqual(certified("forged"));
      expect(declared).not.toContainEqual({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: "fake",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
