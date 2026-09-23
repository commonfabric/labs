import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { streamEntriesDocId } from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimeOwnedStoreOwnerKey } from "../src/cfc/runtime-owned-stores.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { getDerivedInternalCellLink, parseLink } from "../src/link-utils.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "../src/cfc/observation.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("runner-cfc-writer-fit");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

const storedDocument = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
):
  | { value?: unknown; cfc?: { labelMap?: { entries: StoredEntry[] } } }
  | undefined => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      value?: unknown;
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id);
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] =>
  storedDocument(storageManager, id)?.cfc?.labelMap?.entries ?? [];

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // The tests naming `enforce-explicit` assert that a writer-fit misfit
    // lands as a persist-and-flag diagnostic and lets the commit through.
    // The tests that want the misfit to reject raise the mode on their own
    // transaction, so both halves run over one fixture.
    cfcEnforcementMode: "enforce-explicit",
    // Writer-fit assertions read the flow join back out of the replica's
    // stored labelMap, which needs the labels persisted.
    cfcFlowLabels: "persist",
  });

/**
 * A runtime where a writer-fit misfit rejects the commit. The blocks that
 * reach for it assert a commit fails with "writer-fit confidentiality
 * misfit", or that an exemption lets the same join through; both need the
 * misfit to reject. Its flow labels persist so the join reaches the
 * replica's stored labelMap, where those blocks read it back.
 */
const strictRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });

// The space principal of the space every doc in this file lives in — the
// clause residency admits (§8.12.4).
const ownSpacePrincipal = {
  type: "https://commonfabric.org/cfc/atom/Space",
  id: signer.did(),
};

// A second person, who is neither this space's DID nor its acting signer.
const OTHER_PRINCIPAL = "did:key:zOtherPerson";

// A third, for a clause that must land beside an existing one rather than
// inside it.
const THIRD_PRINCIPAL = "did:key:zThirdPerson";

// The three spellings of one principal (§15.2): the identity atom, the
// personal-space atom naming its owner, and the legacy bare DID string.
const userPrincipal = (subject: string) => ({
  type: "https://commonfabric.org/cfc/atom/User",
  subject,
});
const personalSpacePrincipal = (owner: string) => ({
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner,
});

// A space that is not the one every document in this file lives in.
const OTHER_SPACE = "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H";

// A list schema whose ELEMENT objects get anchored into documents of their
// own. Neither the list nor the items declare a store policy, so an anchored
// child starts from the empty ceiling.
const anchoringList = (): JSONSchema => ({
  type: "array",
  items: { type: "object", properties: { note: { type: "string" } } },
} as JSONSchema);

// A target schema whose store policy is exactly `confidentiality`.
const declaring = (
  ...confidentiality: readonly FabricValue[]
): JSONSchema => ({
  type: "object",
  properties: { copied: { type: "string" } },
  ifc: { confidentiality: [...confidentiality] },
} as JSONSchema);

// Seed a source doc whose `secret` field carries `confidentiality`, so a
// transaction reading it takes those clauses into the per-tx flow join.
const seedSecretSource = async (
  runtime: Runtime,
  name: string,
  confidentiality: readonly FabricValue[] = ["secret"],
) => {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    signer.did(),
    name,
    {
      type: "object",
      properties: { secret: { type: "string" } },
    },
  );
  const sourceId = parseLink(sourceCell.getAsLink()).id!;
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
          label: { confidentiality: [...confidentiality] },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

// Read the seeded source in a fresh transaction at `mode`, derive a value
// into `targetName`, and commit. `targetSchema` declares the target's store
// policy; omitted, the target declares nothing.
const deriveIntoTarget = async (
  runtime: Runtime,
  sourceName: string,
  targetName: string,
  mode: "enforce-strict" | "enforce-explicit" = "enforce-strict",
  targetSchema?: JSONSchema,
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode(mode);
  const source = runtime.getCell(signer.did(), sourceName, undefined, tx);
  const raw = source.getRaw() as { secret?: string };
  const target = runtime.getCell<{ copied?: string }>(
    signer.did(),
    targetName,
    targetSchema,
    tx,
  );
  target.set({ copied: `${raw.secret}!` });
  const targetId = target.getAsNormalizedFullLink().id;
  tx.prepareCfc();
  return { tx, targetId, result: await tx.commit() };
};

// The writer-fit reasons this transaction recorded, whether they rejected the
// commit or landed as persist-and-flag diagnostics.
const writerFitDiagnostics = (
  tx: { getCfcState(): { diagnostics: string[] } },
) => tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit"));

// The marker the runner records for each store it owns, naming the piece's
// result document as the source. `authorized` stands for who recorded it: the
// runtime passes its authorization, and code that merely holds a transaction
// cannot. `enrol` stands for the enrollment the runner records beside the
// marker, which is what carries the claim into later transactions; a store the
// runtime mints and fills in one transaction gets the marker alone.
const recordRuntimeOwnedStore = (
  runtime: Runtime,
  tx: ReturnType<Runtime["edit"]>,
  resultCell: {
    getAsNormalizedFullLink(): { space: string; scope: string; id: string };
  },
  substrateCell: {
    getAsNormalizedFullLink(): {
      space: string;
      scope: string;
      id: string;
      path: readonly string[];
    };
  },
  authorized = true,
  enrol = true,
): void => {
  const result = resultCell.getAsNormalizedFullLink();
  const substrate = substrateCell.getAsNormalizedFullLink();
  const target = {
    space: substrate.space as `did:${string}:${string}`,
    scope: substrate.scope as "space",
    id: substrate.id,
    path: [...substrate.path],
  };
  tx.recordCfcWritePolicyInput({
    kind: "structural-provenance",
    target,
    claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
    sources: [{
      space: result.space as `did:${string}:${string}`,
      scope: result.scope as "space",
      id: result.id,
      path: [],
    }],
  }, authorized ? runtimeWritePolicyAuthorization : undefined);
  if (enrol) {
    const ownerKey = runtimeOwnedStoreOwnerKey(
      substrate,
      result as NormalizedFullLink,
      runtime.scopeKeyIdentity,
    );
    if (ownerKey !== undefined) {
      tx.enrollRuntimeOwnedStore(
        target,
        ownerKey,
        authorized ? runtimeWritePolicyAuthorization : undefined,
      );
    }
  }
};

// Read the seeded source and write what it carries into `targetName`, with no
// marker of its own — the transaction a reactive update makes.
const writeSecretInto = async (
  runtime: Runtime,
  sourceName: string,
  targetName: string,
  suffix = "first",
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode("enforce-strict");
  const source = runtime.getCell(signer.did(), sourceName, undefined, tx);
  const raw = source.getRaw() as { secret?: string };
  const target = runtime.getCell<{ copied?: string }>(
    signer.did(),
    targetName,
    undefined,
    tx,
  );
  target.set({ copied: `${raw.secret}/${suffix}` });
  tx.prepareCfc();
  return await tx.commit();
};

describe("CFC writer-fit (canWrite, §8.12.4 / SC-18b)", () => {
  // H4 writer-fit (SC-18b, spec §8.12.4): a write whose derived flow label does
  // not fit the target's write ceiling — its DECLARED store policy joined with
  // the residency clause its own space contributes. Under `enforce-explicit`
  // the derived component is a measurement, not a write ceiling — the write
  // persists and the misfit is flagged as a diagnostic (SC-18a/c). Under
  // `enforce-strict` the same misfit is a fail-closed reject (the strict-only
  // delta of docs/specs/cfc-enforcement-matrix.md §4), leaving the §8.12.5
  // outs: upgrade the store label in the same tx, write to a fitting store, or
  // write to a store whose space the clause already names.

  it("rejects a confidentiality misfit under enforce-strict with the SC-18c reason", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-strict-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-strict-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");

      // Target doc declares NO store policy, so residency is its whole
      // ceiling: a `secret`-tainted component, naming no space, cannot fit.
      const derived = runtime.getCell(
        signer.did(),
        "writer-fit-strict-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      const derivedId = derived.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      const result = await tx.commit();
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      // SC-18c error contract: stable reason naming the rule id and path.
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(`for ${derivedId} at /`);
      expect(result.error?.message).toContain("(canWrite, §8.12.4)");

      // Fail-closed: the rejected transaction persisted nothing.
      expect(storedDocument(storageManager, derivedId)).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the measurement and flags the misfit under enforce-explicit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-explicit-source");
      runtime.resetCfcStats();

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-explicit-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const derived = runtime.getCell(
        signer.did(),
        "writer-fit-explicit-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      const derivedId = derived.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      // Persist-and-flag, half one: the derived component records the
      // value's actual taint (unchanged shipped behavior — readers stay
      // protected by the effective-label floor).
      const entries = replicaEntries(storageManager, derivedId);
      const flowEntry = entries.find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual("secret");

      // Persist-and-flag, half two: the misfit is flagged as a diagnostic
      // carrying the same SC-18c reason string the strict reject uses.
      const flags = tx.getCfcState().diagnostics.filter((d) =>
        d.includes("writer-fit(persist-and-flag)")
      );
      expect(flags.length).toBeGreaterThan(0);
      expect(flags[0]).toContain("writer-fit confidentiality misfit");
      expect(flags[0]).toContain(`for ${derivedId} at /`);
      expect(flags[0]).toContain("(canWrite, §8.12.4)");
      expect(flags[0]).toContain("secret");
      expect(tx.getCfcState().refusalDetails).toEqual([]);
      expect(runtime.getCfcStats().refusalDetailsRecorded).toBe(0);
      expect(runtime.getCfcStats().consumedLabelWalks).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a fitting write under enforce-strict when the declared policy covers the join", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-covered-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-covered-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      // §8.12.5 route 2, atomically in one tx: the write rides a schema that
      // declares a store policy at least as strict as the derived join.
      const covered = runtime.getCell(
        signer.did(),
        "writer-fit-covered-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["secret"] },
        },
        tx,
      );
      covered.set({ copied: `${raw.secret}!` });
      const coveredId = covered.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, coveredId);
      expect(entries.some((e) =>
        e.origin === "declared" &&
        (e.label.confidentiality ?? []).includes("secret")
      )).toBe(true);
      // Nothing is stamped beside it: the join the write carried is the
      // declared policy itself, and a derived entry repeating it adds
      // nothing to the label a read resolves at any path (§4.6.4
      // redundant-entry collapse).
      expect(entries.some((e) => e.origin === "derived")).toBe(false);
      expect(
        tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit")),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("ignores pointer-classed declared policy for a value write under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-followref-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-followref-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      // The target's ONLY declared confidentiality is classed
      // `observes: "followRef"` — pointer policy. Value readers never
      // consume it (C0 §4), so it is not part of the floor a value reader
      // is tainted with and must not serve as the writer-fit ceiling
      // (bot review on this PR: pointer policy admitting a secret value
      // write would under-block exactly the readers the check protects).
      const pointerOnly = runtime.getCell(
        signer.did(),
        "writer-fit-followref-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["secret"], observes: "followRef" },
        },
        tx,
      );
      pointerOnly.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("names the offending clause when the declared policy only partially covers", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-partial-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-partial-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const partial = runtime.getCell(
        signer.did(),
        "writer-fit-partial-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["internal"] },
        },
        tx,
      );
      partial.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      // The reason names the clause(s) outside the write ceiling so the
      // flag identifies exactly what the store would need to declare.
      expect(result.error?.message).toContain('"secret"');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a same-space principal clause into an undeclared store under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The source's confidentiality names this space's own principal, so
      // residency fits the tainted write below even though the target
      // declares nothing.
      await seedSecretSource(runtime, "wf-samespace-source", [
        ownSpacePrincipal,
      ]);
      const { tx, targetId, result } = await deriveIntoTarget(
        runtime,
        "wf-samespace-source",
        "wf-samespace-derived",
      );
      expect(result.error?.message).toBeUndefined();

      // The fit is a write admission, not a label drop: the derived stamp
      // still carries the space principal for the egress gates.
      const flowEntry = replicaEntries(storageManager, targetId)
        .find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual(
        ownSpacePrincipal,
      );
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a clause carrying the space principal as one alternative", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // Residency reaches into an OR-clause: the ceiling clause subsumes a
      // label clause listing the space among its alternatives.
      await seedSecretSource(runtime, "wf-alternative-source", [{
        anyOf: [
          {
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:zReader",
          },
          ownSpacePrincipal,
        ],
      }]);
      const { tx, result } = await deriveIntoTarget(
        runtime,
        "wf-alternative-source",
        "wf-alternative-derived",
      );
      expect(result.error?.message).toBeUndefined();
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("raises no persist-and-flag diagnostic for a same-space clause under enforce-explicit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The measurement is one computation feeding both the strict reject and
      // the lower-mode diagnostic, so a residency fit is silent at every rung.
      await seedSecretSource(runtime, "wf-explicit-source", [
        ownSpacePrincipal,
      ]);
      const { tx, result } = await deriveIntoTarget(
        runtime,
        "wf-explicit-source",
        "wf-explicit-derived",
        "enforce-explicit",
      );
      expect(result.error?.message).toBeUndefined();
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a principal naming a space other than the target's", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "wf-foreignspace-source", [{
        type: "https://commonfabric.org/cfc/atom/Space",
        id: "did:key:zForeignSpace",
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-foreignspace-source",
        "wf-foreignspace-derived",
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain("zForeignSpace");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the personal-space principal form under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "wf-personalspace-source", [{
        type: "https://commonfabric.org/cfc/atom/PersonalSpace",
        owner: signer.did(),
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-personalspace-source",
        "wf-personalspace-derived",
      );
      // `PersonalSpace` gates by equality against one acting reader, so its
      // audience is a person rather than the space's reader set. Residency
      // does not admit it, even though the owner DID matches this space's.
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain("PersonalSpace");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the bare DID-string principal that the declared policy omits", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // Two clauses: one the target's declared policy lists, one it does not
      // — the bare DID-string spelling, which names a reader by identity
      // rather than naming the container.
      await seedSecretSource(runtime, "wf-baredid-source", [
        "internal",
        signer.did(),
      ]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-baredid-source",
        "wf-baredid-derived",
        "enforce-strict",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["internal"] },
        },
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(signer.did());
      expect(result.error?.message).not.toContain('"internal"');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a read-failed marker clause that lists a same-space alternative", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The ungrantable marker stays outside every ceiling, the residency
      // clause included. This is also the fence against reimplementing the
      // rule as a filter over the measured label, which would drop the
      // clause before the marker check ever ran.
      await seedSecretSource(runtime, "wf-poisoned-source", [{
        anyOf: [CFC_LABEL_READ_FAILED_ATOM, ownSpacePrincipal],
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-poisoned-source",
        "wf-poisoned-derived",
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(CFC_LABEL_READ_FAILED_ATOM);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("a personal space's owner is one of its readers", () => {
    // §8.10.3 fit kernel: a `PersonalSpace(P)` LABEL fits a store declaring
    // `User(P)`, because §3.6.4 makes P an owner and so a reader of that
    // space. The reverse does not hold — §3.6.5 gives a member added later
    // access to all data in the space with no label rewriting, so a store
    // declaring the atom is not read by P alone.

    it("admits a personal-space clause into a store declaring that owner", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-owner-source", [
          personalSpacePrincipal(OTHER_PRINCIPAL),
        ]);
        const { tx, targetId, result } = await deriveIntoTarget(
          runtime,
          "wf-owner-source",
          "wf-owner-derived",
          "enforce-strict",
          declaring(userPrincipal(OTHER_PRINCIPAL)),
        );
        expect(result.error?.message).toBeUndefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);

        // A write admission, not a relabeling: the derived stamp still
        // carries the atom the flow measured, so the egress and display
        // gates read the unchanged label.
        const flowEntry = replicaEntries(storageManager, targetId)
          .find((e) => e.origin === "derived");
        expect(flowEntry!.label.confidentiality).toContainEqual(
          personalSpacePrincipal(OTHER_PRINCIPAL),
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("admits a clause carrying the personal space as one alternative", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-owner-alt-source", [{
          anyOf: [personalSpacePrincipal(OTHER_PRINCIPAL), "internal"],
        }]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-alt-source",
          "wf-owner-alt-derived",
          "enforce-strict",
          declaring(userPrincipal(OTHER_PRINCIPAL)),
        );
        expect(result.error?.message).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a User clause into a store declaring that person's personal space", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        // The direction §3.6.5 denies: the store's audience is the space's
        // readers, which a later membership change widens without touching
        // any label.
        await seedSecretSource(runtime, "wf-owner-ceiling-source", [
          userPrincipal(OTHER_PRINCIPAL),
        ]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-ceiling-source",
          "wf-owner-ceiling-derived",
          "enforce-strict",
          declaring(personalSpacePrincipal(OTHER_PRINCIPAL)),
        );
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(OTHER_PRINCIPAL);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a personal space the declared owner does not name", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        // The neighbouring case: the same rule, one DID apart.
        await seedSecretSource(runtime, "wf-owner-mismatch-source", [
          personalSpacePrincipal(OTHER_PRINCIPAL),
        ]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-mismatch-source",
          "wf-owner-mismatch-derived",
          "enforce-strict",
          declaring(userPrincipal(signer.did())),
        );
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(OTHER_PRINCIPAL);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a User clause naming the acting principal into an undeclared store", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        // No self exemption. The acting principal signs this transaction and
        // its DID is this space's, so residency contributes `Space(<that
        // DID>)` — and the store is still public, which is what refuses the
        // write. A person writing their own secret to a world-readable store
        // is the disclosure the ceiling exists to catch.
        await seedSecretSource(runtime, "wf-owner-self-source", [
          userPrincipal(signer.did()),
        ]);
        const { result } = await deriveIntoTarget(
          runtime,
          "wf-owner-self-source",
          "wf-owner-self-derived",
        );
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(signer.did());
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("computed-cell exemption", () => {
    // The measurement quantifies over surfaces a schema could have declared a
    // policy at, and a computed cell is not one. It is the derived internal
    // cell the runtime materializes to hold a derivation's result, under its
    // own URI scheme (`computed:fid1:<hash>`; see `entity-kind.ts` and
    // `docs/specs/computed-cell-identity.md`). A pattern names the data it
    // declares policy on, and it does not name the intermediates the reactive
    // graph materializes for it, so measuring them refuses every derivation
    // that reads labeled data and writes its result.
    //
    // The exemption decides which store a value may land in, not whether it
    // stays labeled: the join still lands on the computed document as its
    // `derived` component, which is what the cases below pin alongside it.

    /**
     * The `computed:` id over the same hash as the `of:` id `cause` mints. The
     * two name different entities, so a case can write the same join to both
     * and hold everything but the scheme fixed.
     */
    const computedIdFor = (
      runtime: Runtime,
      cause: string,
    ): `${string}:${string}` => {
      const plain = runtime.getCell(signer.did(), cause)
        .getAsNormalizedFullLink().id;
      return `computed:${plain.slice("of:".length)}`;
    };

    it("admits a tainted write into a computed document", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-computed-source");
        const computedId = computedIdFor(runtime, "wf-computed-target");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-computed-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: computedId,
          path: ["value", "copied"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        expect((await tx.commit()).error).toBeUndefined();

        // The value landed, and it landed carrying what it derived from.
        expect(
          (storedDocument(storageManager, computedId)?.value as {
            copied?: string;
          })?.copied,
        ).toBe("s3cr3t!");
        expect(
          replicaEntries(storageManager, computedId)
            .filter((entry) => entry.origin === "derived")
            .flatMap((entry) => entry.label.confidentiality ?? []),
        ).toContain("secret");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("still rejects the same join written into the state cell beside it", async () => {
      // The control: the exemption is about the surface, not about this
      // transaction's join. The source and the target cause are the ones the
      // case above used, so the target here is the `of:` id over the very
      // hash that case wrote through `computed:` — a different entity,
      // differing from it in its URI scheme alone — and the misfit is back.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-computed-source");
        const plainId = runtime
          .getCell(signer.did(), "wf-computed-target")
          .getAsNormalizedFullLink().id;

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-computed-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: plainId,
          path: ["value", "copied"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${plainId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps measuring a computed target whose join came from another space", async () => {
      // The exemption is scoped to a join this target's own space produced.
      // A clause that reached the join from a document in another space is
      // measured wherever it lands, so a derivation cannot carry a foreign
      // space's labeled value into a local document by materializing it.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      const foreign = (await Identity.fromPassphrase("wf-computed-foreign"))
        .did();
      try {
        const seed = runtime.edit();
        const foreignCell = runtime.getCell(
          foreign,
          "wf-computed-foreign-source",
          { type: "object", properties: { secret: { type: "string" } } },
          seed,
        );
        const foreignId = foreignCell.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, foreign);
        seedStoredEnvelope(seed, {
          space: foreign,
          scope: "space",
          id: foreignId,
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
                label: { confidentiality: ["secret"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();

        const computedId = computedIdFor(runtime, "wf-computed-foreign-target");
        const tx = runtime.edit();
        const source = runtime.getCellFromLink(
          { id: foreignId, path: [], space: foreign, scope: "space" },
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: computedId,
          path: ["value", "copied"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${computedId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("carries the admitted taint into a later transaction that reads it back", async () => {
      // What the exemption rests on: the stamp the admitted write left is a
      // read floor like any other, so the value cannot be laundered by
      // routing it through a computed document. A second transaction reads it
      // back and writes it into an ordinary undeclared store, and that write
      // misfits on the clause the first transaction's source carried.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-computed-launder-source");
        const computedId = computedIdFor(runtime, "wf-computed-launder-target");

        const first = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-computed-launder-source",
          undefined,
          first,
        );
        const raw = source.getRaw() as { secret?: string };
        first.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: computedId,
          path: ["value", "copied"],
        }, `${raw.secret}!`);
        first.prepareCfc();
        expect((await first.commit()).error).toBeUndefined();

        const second = runtime.edit();
        const derived = runtime.getCellFromLink(
          { id: computedId, path: [], space: signer.did(), scope: "space" },
          undefined,
          second,
        );
        const carried = (derived.getRaw() as { copied?: string }).copied;
        expect(carried).toBe("s3cr3t!");
        const plainId = runtime.getCell(signer.did(), "wf-computed-launder-out")
          .getAsNormalizedFullLink().id;
        second.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: plainId,
          path: ["value", "copied"],
        }, carried as string);
        second.prepareCfc();

        const result = await second.commit();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain('"secret"');
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("stream entries-document exemption", () => {
    // The measurement quantifies over surfaces a schema could have declared a
    // policy at, and a stream's entries document is not one. The runtime
    // materializes it to hold that stream's durable event entries and the
    // marks recording which of them have been handled, at an id derived from
    // the stream's link (`STREAM_ENTRIES_DOC_PREFIX` in
    // `@commonfabric/memory/v2`) so that every party addresses the same
    // document with no coordination. No pattern names it and no value schema
    // describes it, so measuring it refuses every event a handler over
    // labeled data emits, and every mark a served run writes to record that
    // it handled one.
    //
    // The exemption decides which store the entries may land in, not whether
    // they stay labeled: the join still lands on the document as its
    // `derived` component, which the first two cases pin alongside the
    // verdict.
    //
    // The first two cases read the verdict off the prepare pass rather than
    // off a completed commit. A write to one of these documents meets
    // the memory server's own sidecar admission after CFC is done with it
    // (events.md §1: authored traffic reaches one only as a declared tail
    // append, and only under `EXPERIMENTAL_SERVER_EXECUTION`), which
    // `packages/memory/test/v2-event-append.test.ts` covers. A recorded
    // writer-fit reason leaves the prepare state `invalidated` and rejects
    // ahead of all of that, so `prepared` is the whole of what this gate
    // decides.

    /**
     * The entries document of the `events` stream inside the document the
     * cause `stream` mints — the id every party derives rather than one an
     * author named.
     */
    const entriesDocFor = (
      runtime: Runtime,
      stream: string,
    ): `${string}:${string}` =>
      streamEntriesDocId({
        id: runtime.getCell(signer.did(), stream).getAsNormalizedFullLink().id,
        path: ["events"],
        scope: "space",
      }) as `${string}:${string}`;

    /**
     * The `derived` confidentiality the prepare pass staged on `id`, read back
     * out of the transaction. That is where the envelope sits until a commit
     * carries it to the replica, and these cases do not reach a commit.
     */
    const stagedDerivedConfidentiality = (
      tx: ReturnType<Runtime["edit"]>,
      id: `${string}:${string}`,
    ): string[] =>
      (((tx.readOrThrow({
        space: signer.did(),
        scope: "space",
        id,
        path: [],
      }) ?? {}) as { cfc?: { labelMap?: { entries: StoredEntry[] } } })
        .cfc?.labelMap?.entries ?? [])
        .filter((entry) => entry.origin === "derived")
        .flatMap((entry) => entry.label.confidentiality ?? []);

    it("records no writer-fit reason for an entry's `consequenced` mark", async () => {
      // The defect this exemption closes: a handler that read labeled data
      // runs on the serving runtime, which records that the entry was handled
      // by writing the mark. Measuring that write refuses the commit, and the
      // action a user clicks then does nothing they can see.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-entries-source");
        const entriesId = entriesDocFor(runtime, "wf-entries-stream");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-entries-source",
          undefined,
          tx,
        );
        expect((source.getRaw() as { secret?: string }).secret).toBe("s3cr3t");
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: entriesId,
          path: ["value", "entries", "0", "consequenced"],
        }, true);
        tx.prepareCfc();

        expect(tx.getCfcState().prepare.status).toBe("prepared");
        expect(writerFitDiagnostics(tx)).toEqual([]);
        // The mark stayed labeled: the exemption decides which store the
        // value may land in, not whether the join follows it.
        expect(stagedDerivedConfidentiality(tx, entriesId))
          .toContain("secret");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("records no writer-fit reason for an appended entry", async () => {
      // The other write a served run makes to the document: a same-space
      // emission carries its durable entry inside the emitting transaction,
      // so the payload takes the same join the mark does.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-entries-append-source");
        const entriesId = entriesDocFor(runtime, "wf-entries-append-stream");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-entries-append-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: entriesId,
          path: ["value", "entries"],
        }, [{ eventId: "evt:emitted", payload: { note: `${raw.secret}!` } }]);
        tx.prepareCfc();

        expect(tx.getCfcState().prepare.status).toBe("prepared");
        expect(writerFitDiagnostics(tx)).toEqual([]);
        expect(stagedDerivedConfidentiality(tx, entriesId))
          .toContain("secret");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("still rejects the same write into an ordinary document", async () => {
      // The control: the exemption is about the document class, not about the
      // path a mark is written at or the join this transaction carries.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-entries-plain-source");
        const plainId = runtime
          .getCell(signer.did(), "wf-entries-plain-target")
          .getAsNormalizedFullLink().id;

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-entries-plain-source",
          undefined,
          tx,
        );
        expect((source.getRaw() as { secret?: string }).secret).toBe("s3cr3t");
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: plainId,
          path: ["value", "entries", "0", "consequenced"],
        }, true);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${plainId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps measuring an entries document whose join came from another space", async () => {
      // The exemption is scoped to a join this document's own space produced,
      // the same as the computed-cell one above: an emission cannot carry a
      // foreign space's labeled value into a local stream's entries document.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      const foreign = (await Identity.fromPassphrase("wf-entries-foreign"))
        .did();
      try {
        const seed = runtime.edit();
        const foreignCell = runtime.getCell(
          foreign,
          "wf-entries-foreign-source",
          { type: "object", properties: { secret: { type: "string" } } },
          seed,
        );
        const foreignId = foreignCell.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, foreign);
        seedStoredEnvelope(seed, {
          space: foreign,
          scope: "space",
          id: foreignId,
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
                label: { confidentiality: ["secret"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();

        const entriesId = entriesDocFor(runtime, "wf-entries-foreign-stream");
        const tx = runtime.edit();
        const source = runtime.getCellFromLink(
          { id: foreignId, path: [], space: foreign, scope: "space" },
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: entriesId,
          path: ["value", "entries"],
        }, [{ eventId: "evt:foreign", payload: { note: `${raw.secret}!` } }]);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${entriesId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("marked-undeclarable-store exemption", () => {
    // The third arm of the same question the two id classes answer. A document
    // whose id is a plain content hash looks like every other document, so the
    // class it belongs to cannot be read off the id — the runtime names it as
    // it writes it instead, under
    // `CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE`. The compilation cache is
    // what records it today: a cache document holds the compiler's record of a
    // module at a content address of that module's bytes, so no pattern names
    // it and no value schema describes a field on it.
    //
    // The marker is acted on rather than measured, so these cases pin what
    // bounds it: who recorded it, and that it names a whole document.

    /**
     * Name `doc` as a store no schema declares a policy on, the way the
     * compilation cache does for the documents it writes. `authorized` stands
     * for who recorded it — the runtime passes its authorization, and code
     * that merely holds a transaction cannot. `path` stands for how much of
     * the document the marker names.
     */
    const markUndeclarable = (
      tx: ReturnType<Runtime["edit"]>,
      doc: { getAsNormalizedFullLink(): NormalizedFullLink },
      { authorized = true, path = [] as readonly string[] } = {},
    ): void => {
      const link = doc.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        target: {
          space: link.space,
          scope: link.scope,
          id: link.id,
          path: [...path],
        },
        claim: CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
        sources: [],
      }, authorized ? runtimeWritePolicyAuthorization : undefined);
    };

    /**
     * Read the seeded source and write what it carries onto `targetName`, at
     * the path a delegation union lands on. `mark` decides whether the target
     * is named, and how.
     */
    const writeTaintedRecord = async (
      runtime: Runtime,
      sourceName: string,
      targetName: string,
      mark?: (
        tx: ReturnType<Runtime["edit"]>,
        doc: { getAsNormalizedFullLink(): NormalizedFullLink },
      ) => void,
    ) => {
      const tx = runtime.edit();
      const source = runtime.getCell(signer.did(), sourceName, undefined, tx);
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");
      const target = runtime.getCell<{ delegatedModuleIdentities?: string[] }>(
        signer.did(),
        targetName,
        undefined,
        tx,
      );
      mark?.(tx, target);
      target.set({ delegatedModuleIdentities: [`predecessor/${raw.secret}`] });
      const targetId = target.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      return { targetId, result: await tx.commit() };
    };

    it("records no writer-fit reason for a write to a marked document", async () => {
      // The defect this closes: a piece's source transition stages a module's
      // delegation union on the same transaction that moves the piece's source
      // pointer, and that transaction read the piece's argument. Measuring the
      // cache write refuses the commit, so a pattern update is refused for
      // exactly the pieces holding a confidential argument.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-cache-source");
        const { targetId, result } = await writeTaintedRecord(
          runtime,
          "wf-cache-source",
          "wf-cache-doc",
          (tx, doc) => markUndeclarable(tx, doc),
        );

        expect(result.error).toBeUndefined();
        // The exemption decides which store the value may land in, not
        // whether the join follows it: the document holds the write and
        // carries the clause.
        expect(storedDocument(storageManager, targetId)?.value).toEqual({
          delegatedModuleIdentities: ["predecessor/s3cr3t"],
        });
        expect(
          replicaEntries(storageManager, targetId)
            .filter((entry) => entry.origin === "derived")
            .flatMap((entry) => entry.label.confidentiality ?? []),
        ).toContain("secret");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("measures the same write into a document nothing marked", async () => {
      // The control: the exemption keys on the marker, not on the path the
      // value lands at or the join this transaction carries.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-cache-plain-source");
        const { targetId, result } = await writeTaintedRecord(
          runtime,
          "wf-cache-plain-source",
          "wf-cache-plain-doc",
        );

        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${targetId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("counts a marker recorded without the runtime's mark for nothing", async () => {
      // The gate ACTS on this claim, and the recording method is on the public
      // transaction interface, so pattern-authored code reaching `cell.tx` can
      // name whatever document it likes. What separates the two is the
      // authorization the runtime passes alongside.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-cache-forged-source");
        const { targetId, result } = await writeTaintedRecord(
          runtime,
          "wf-cache-forged-source",
          "wf-cache-forged-doc",
          (tx, doc) => markUndeclarable(tx, doc, { authorized: false }),
        );

        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${targetId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("counts a marker naming a path inside the document for nothing", async () => {
      // Whether a schema could have declared a policy is a question about the
      // document, so the marker answers for the whole of one. A marker
      // carrying a path names a part, and a part is not what it can claim.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-cache-partial-source");
        const { targetId, result } = await writeTaintedRecord(
          runtime,
          "wf-cache-partial-source",
          "wf-cache-partial-doc",
          (tx, doc) =>
            markUndeclarable(tx, doc, {
              path: ["delegatedModuleIdentities"],
            }),
        );

        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${targetId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("measures a document the marker did not name", async () => {
      // The marker names a document, not the transaction. A transaction that
      // marked one store and wrote another has said nothing about the second,
      // and a gate keyed on the transaction rather than the document would let
      // that second write through.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-cache-other-source");
        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-cache-other-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        const marked = runtime.getCell(
          signer.did(),
          "wf-cache-marked-doc",
          undefined,
          tx,
        );
        markUndeclarable(tx, marked);
        const bystander = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "wf-cache-bystander-doc",
          undefined,
          tx,
        );
        bystander.set({ copied: `${raw.secret}!` });
        const bystanderId = bystander.getAsNormalizedFullLink().id;
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${bystanderId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("carries the claim to a document the marked value splits into", async () => {
      // Anchoring puts part of a marked document's value in a document of its
      // own — a cache document's `imports` array holds one per edge. The child
      // is the same kind of store as its parent, and without the carry a
      // transaction that rewrites a marked document while carrying a join is
      // refused at the child rather than at the document it named.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-cache-anchor-source");
        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-cache-anchor-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        const parent = runtime.getCell<{ note: string }[]>(
          signer.did(),
          "wf-cache-anchor-parent",
          anchoringList(),
          tx,
        );
        markUndeclarable(tx, parent);
        parent.set([{ note: `${raw.secret}!` }]);
        const parentId = parent.getAsNormalizedFullLink().id;
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeUndefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);
        // The parent's own write is all links after the anchor, so the
        // content landed in the child, which is the document the claim had
        // to reach. Its stored value pins it, and its stamp says the skip
        // decided which store the value may land in rather than whether the
        // join follows it.
        const stored = storedDocument(storageManager, parentId)?.value;
        const childId = parseLink((stored as unknown[])[0])!.id!;
        expect(childId).not.toBe(parentId);
        expect(storedDocument(storageManager, childId)?.value).toEqual({
          note: "s3cr3t!",
        });
        expect(
          replicaEntries(storageManager, childId)
            .flatMap((entry) => entry.label.confidentiality ?? []),
        ).toContain("secret");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps measuring a marked document whose join came from another space", async () => {
      // Scoped to a join the target's own space produced, the same as the two
      // id classes: a cache write cannot carry a foreign space's labeled value
      // into a local document.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      const foreign = (await Identity.fromPassphrase("wf-cache-foreign")).did();
      try {
        const seed = runtime.edit();
        const foreignCell = runtime.getCell(
          foreign,
          "wf-cache-foreign-source",
          { type: "object", properties: { secret: { type: "string" } } },
          seed,
        );
        const foreignId = foreignCell.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, foreign);
        seedStoredEnvelope(seed, {
          space: foreign,
          scope: "space",
          id: foreignId,
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
                label: { confidentiality: ["secret"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const source = runtime.getCellFromLink(
          { id: foreignId, path: [], space: foreign, scope: "space" },
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        const target = runtime.getCell<
          { delegatedModuleIdentities?: string[] }
        >(
          signer.did(),
          "wf-cache-foreign-doc",
          undefined,
          tx,
        );
        markUndeclarable(tx, target);
        target.set({
          delegatedModuleIdentities: [`predecessor/${raw.secret}`],
        });
        const targetId = target.getAsNormalizedFullLink().id;
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${targetId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("meta-seam exemption", () => {
    // The measurement quantifies over paths a schema could have declared a
    // policy at, and the raw meta seam is not one: `setMetaRaw` lands on a
    // document-root sibling of `value` (`schema`, `internal`, and the rest of
    // the `MetaField` union), which no value schema describes.
    //
    // One route does reach a ceiling there — a document-root declaration
    // resolves at every meta path by longest prefix — but it widens the
    // ceiling over the whole payload, and a declaration on a single result
    // field, which is how a pattern normally labels one, leaves the seam's
    // ceiling empty. Such a pattern is then un-updatable: the pattern updater,
    // `setsrc`, and setup over an existing piece all stamp meta.
    //
    // The seam is outside the check at every rung, so these cases assert on
    // both the strict reject and the persist-and-flag diagnostic below it.

    /** Seed `cause` as a plain document declaring no store policy. */
    const seedUndeclaredTarget = async (
      runtime: Runtime,
      cause: string,
      payload: FabricValue = { note: "public" },
    ) => {
      const id = runtime.getCell(signer.did(), cause)
        .getAsNormalizedFullLink().id;
      const seed = runtime.edit();
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id,
        path: [],
      }, { value: payload });
      expect((await seed.commit()).ok).toBeDefined();
      return id;
    };

    it("admits a meta write of a tainted join into an undeclared store", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-source");
        const targetId = await seedUndeclaredTarget(runtime, "wf-meta-target");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-target",
          undefined,
          tx,
        );
        await target.sync();
        // The two paths the piece-update flows land on, and the two the
        // strict measurement used to reject at.
        target.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        target.setMetaRaw(
          "internal",
          { derived: raw.secret },
          rawMetaWriteAuthorization,
        );
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeUndefined();
        expect(result.ok).toBeDefined();
        // Not merely "did not reject": no measurement named a meta path at
        // all, at either rung (a strict reject and an explicit flag carry the
        // identical reason string).
        expect(writerFitDiagnostics(tx)).toEqual([]);

        // The taint is not lost with the measurement. The join still lands as
        // the derived component on the meta paths, so the egress, display,
        // and observation gates read the unchanged label. (Each path carries
        // the C2 per-class split — a `value` entry and a `shape` entry — so
        // the paths are compared as a set.)
        const stamped = replicaEntries(storageManager, targetId).filter((e) =>
          e.origin === "derived" &&
          (e.label.confidentiality ?? []).includes("secret")
        );
        expect([...new Set(stamped.map((e) => e.path.join("/")))].sort())
          .toEqual(["internal", "schema"]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("raises no persist-and-flag diagnostic for a meta write under enforce-explicit", async () => {
      // The exemption is a statement about what the check can measure, not
      // about what a rung does with a misfit, so it holds below strict too.
      // Were it scoped to the reject, the shipped posture would keep flagging
      // a measurement the strict rung had already declared meaningless.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-explicit-source");
        await seedUndeclaredTarget(runtime, "wf-meta-explicit-target");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-explicit-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-explicit-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw("slug", `${raw.secret}!`, rawMetaWriteAuthorization);
        tx.prepareCfc();

        expect((await tx.commit()).ok).toBeDefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("still rejects an ordinary value write of the same join into the same store", async () => {
      // The control: the exemption is about paths a schema cannot reach, not
      // about this transaction's join or this target's store. Swap the meta
      // write above for a payload write into the same undeclared document and
      // the misfit is back.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-control-source");
        const targetId = await seedUndeclaredTarget(
          runtime,
          "wf-meta-control-target",
        );

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-control-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "note"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(isCfcEnforcementRejection(result.error)).toBe(true);
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${targetId} at /note`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("skips the measurement even where a root declaration resolves at the meta path", async () => {
      // The skip is unconditional, and this pins that. A document-root
      // declared entry is a prefix of every meta path, so longest-prefix
      // resolution hands the meta path a non-empty ceiling — but that
      // reaches the envelope seam only because canonicalization strips a
      // leading `"value"`, making the payload root and the document root one
      // logical path. It says nothing about the seam, and honoring it would
      // make a piece updatable or not according to whether its pattern
      // carries a root `ifc`.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-rooted-source");

        // A root declaration that does NOT cover the join the tx will carry.
        const targetId = runtime.getCell(signer.did(), "wf-meta-rooted-target")
          .getAsNormalizedFullLink().id;
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, signer.did());
        seedStoredEnvelope(seed, {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: [],
        }, {
          value: { note: "public" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { confidentiality: ["unrelated"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-rooted-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-rooted-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw("slug", `${raw.secret}!`, rawMetaWriteAuthorization);
        tx.prepareCfc();

        expect((await tx.commit()).ok).toBeDefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps measuring a payload field that shares a meta field's logical path", async () => {
      // A payload field literally named `schema` lives at raw
      // `["value","schema"]` and canonicalizes onto the meta root's logical
      // path. The exemption is recorded per path across every write that
      // reached it, so writing both in one transaction leaves the path
      // measured — and an exempt meta path must not collapse a value write
      // below it out of the measurement either.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-collide-source");
        // The payload carries a `schema` object of its own, so the write
        // below materializes at its own path instead of at the document root.
        const targetId = await seedUndeclaredTarget(
          runtime,
          "wf-meta-collide-target",
          { schema: { existing: true } },
        );

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-collide-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-collide-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "schema", "leaked"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(isCfcEnforcementRejection(result.error)).toBe(true);
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(
          `for ${targetId} at /schema/leaked`,
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  it("admits a reserved grant document under enforce-strict", async () => {
    // Reserved CFC documents (policy manifests, release grants) hold policy
    // state the runtime persists through its privileged writers, so they are
    // not value-write targets the fit measures. The grant document declares no
    // store policy of its own, and the transaction that authors one has read
    // the resource it releases — a tainted join.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-grant-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-grant-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");
      // The trusted policy-writer authors under a builtin identity, the one
      // sanctioned writer of the reserved grant namespace.
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "cfc-grant-writer",
      });
      const written = tx.writeCfcGrant({
        kind: "ShareGrant",
        owner: signer.did(),
        resource: "of:writer-fit-grant-resource",
        audience: [cfcAtom.user(
          "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H",
        )],
        grantedAt: 1000,
      });
      expect(tx.prepareCfc()).not.toBe("");
      expect((await tx.commit()).ok).toBeDefined();

      // The grant persisted, carrying no derived label of its own: a
      // consultation reading it inherits nothing from the releasing
      // transaction.
      const stored = storedDocument(storageManager, written.id);
      expect(stored?.value).toBeDefined();
      expect(stored?.cfc).toBeUndefined();
      expect(
        tx.getCfcState().diagnostics.filter((diagnostic) =>
          diagnostic.includes(written.id)
        ),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("leaves untainted writes untouched under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const plain = runtime.getCell(
        signer.did(),
        "writer-fit-plain",
        undefined,
        tx,
      );
      plain.set({ note: "public" });
      const plainId = plain.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      // The stored value pins the document the label map is read from, so the
      // empty map below is that document's own.
      expect(storedDocument(storageManager, plainId)?.value).toEqual({
        note: "public",
      });
      expect(replicaEntries(storageManager, plainId)).toEqual([]);
      expect(
        tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit")),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // The pattern the end-to-end cases set up: one argument field, and one
  // derived internal cell the result projects to.
  const seamResultSchema = {
    type: "object",
    properties: { savedTitle: { type: "string" } },
    required: ["savedTitle"],
  } as const satisfies JSONSchema;

  const seamPattern = {
    argumentSchema: {
      type: "object",
      properties: { title: { type: "string" } },
    } as const,
    resultSchema: seamResultSchema,
    derivedInternalCells: [{
      partialCause: "savedTitle",
      schema: { type: "string", default: "" },
    }],
    result: {
      savedTitle: { $alias: { partialCause: "savedTitle", path: [] } },
    },
    nodes: [],
  } satisfies Pattern;

  describe("the runtime-owned-store declaration (§8.12.5 route 2)", () => {
    // A store the runtime owns is filled by the runtime out of whatever the
    // writing transaction read: a piece's argument, result and internal
    // documents, the state documents a builtin mints from its own node's
    // cause, and the documents anchoring splits out of a value written into
    // any of those. No value schema can declare a covering policy for them,
    // because the atoms are a property of the transaction rather than of the
    // pattern, so the transaction declares that policy itself.
    // `docs/specs/cfc-enforcement-matrix.md` §4 states the route and the
    // conditions on it; one test per condition follows.

    it("declares the join on a document the substrate marker names", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        const entries = replicaEntries(storageManager, substrateId);
        expect(entries.some((entry) =>
          entry.origin === "declared" &&
          (entry.label.confidentiality ?? []).includes("secret")
        )).toBe(true);

        // A permanent change to a store's policy leaves a trace even at the
        // rung that admits it.
        const flags = writerFitDiagnostics(tx);
        expect(flags.length).toBe(1);
        expect(
          flags.some((flag) =>
            flag.includes("writer-fit(runtime-owned-store-declared)") &&
            flag.includes(`${substrateId} at /`) && flag.includes('"secret"')
          ),
        ).toBe(true);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects the same write on a document no substrate marker names", async () => {
      // The negative twin of the test above: one transaction, one marker, and
      // a second target the marker does not name. The route reaches the seam
      // and stops there.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-bystander-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        const bystander = runtime.getCell(
          signer.did(),
          "writer-fit-seam-bystander",
          undefined,
          tx,
        );
        bystander.set({ copied: `${raw.secret}!` });
        const bystanderId = bystander.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(`for ${bystanderId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("grows the declaration when a later transaction carries a wider join", async () => {
      // The declared component only ever tightens (§8.12.1), so a second
      // atom joins the first rather than replacing it. A piece created
      // before its inputs were labeled reaches the same path: nothing was
      // declared at birth, and the write that first carries a join declares
      // it then.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-grow-first");
        await seedSecretSource(runtime, "writer-fit-seam-grow-second", [
          "other",
        ]);

        const born = runtime.edit();
        const untainted = runtime.getCell(
          signer.did(),
          "writer-fit-seam-grow-substrate",
          undefined,
          born,
        );
        untainted.set({ copied: "public" });
        const substrateId = untainted.getAsNormalizedFullLink().id;
        expect((await born.commit()).ok).toBeDefined();
        expect(replicaEntries(storageManager, substrateId)).toEqual([]);

        const declaredClauses = async (sources: readonly string[]) => {
          const tx = runtime.edit();
          tx.setCfcEnforcementMode("enforce-strict");
          const copied = sources.map((name) =>
            (runtime.getCell(signer.did(), name, undefined, tx)
              .getRaw() as { secret?: string }).secret
          ).join("/");
          const result = runtime.getCell(
            signer.did(),
            "writer-fit-seam-grow-result",
            undefined,
            tx,
          );
          const substrate = runtime.getCell(
            signer.did(),
            "writer-fit-seam-grow-substrate",
            undefined,
            tx,
          );
          recordRuntimeOwnedStore(runtime, tx, result, substrate);
          substrate.set({ copied });
          tx.prepareCfc();
          expect((await tx.commit()).ok).toBeDefined();
          const declared = replicaEntries(storageManager, substrateId)
            .filter((entry) => entry.origin === "declared");
          // One entry per path per component: a second declaration at the
          // same path would coalesce, and a stored one that failed to
          // coalesce would rewrite the envelope on every reconcile.
          expect(declared.length).toBe(1);
          return declared[0].label.confidentiality ?? [];
        };

        expect(await declaredClauses(["writer-fit-seam-grow-first"]))
          .toEqual(["secret"]);
        // Re-declaring the same join changes nothing.
        expect(await declaredClauses(["writer-fit-seam-grow-first"]))
          .toEqual(["secret"]);
        const grown = await declaredClauses([
          "writer-fit-seam-grow-first",
          "writer-fit-seam-grow-second",
        ]);
        expect(grown).toContain("secret");
        expect(grown).toContain("other");
        // And the wider declaration survives a transaction that carries only
        // the narrower join: the declared component never shrinks.
        expect(await declaredClauses(["writer-fit-seam-grow-first"]))
          .toEqual(grown);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("declares on a later transaction that names no store of its own", async () => {
      // Instance 1: a piece whose result projects a list. Setup is one
      // transaction; the reactive update that appends to the list is another,
      // and it records no marker of its own. The enrollment made at setup is
      // what carries the claim there, so the array-length bookkeeping write
      // declares rather than refusing.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-later-source");

        const setup = runtime.edit();
        setup.setCfcEnforcementMode("enforce-strict");
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-later-result",
          undefined,
          setup,
        );
        const list = runtime.getCell<string[]>(
          signer.did(),
          "writer-fit-owned-later-list",
          { type: "array", items: { type: "string" } } as JSONSchema,
          setup,
        );
        recordRuntimeOwnedStore(runtime, setup, result, list);
        list.set(["first"]);
        const listId = list.getAsNormalizedFullLink().id;
        setup.prepareCfc();
        expect((await setup.commit()).ok).toBeDefined();
        expect(replicaEntries(storageManager, listId)).toEqual([]);

        const update = runtime.edit();
        update.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-owned-later-source",
          undefined,
          update,
        );
        const raw = source.getRaw() as { secret?: string };
        const listInUpdate = runtime.getCell<string[]>(
          signer.did(),
          "writer-fit-owned-later-list",
          { type: "array", items: { type: "string" } } as JSONSchema,
          update,
        );
        listInUpdate.set(["first", `${raw.secret}!`]);
        update.prepareCfc();
        expect((await update.commit()).ok).toBeDefined();

        const declared = replicaEntries(storageManager, listId)
          .filter((entry) => entry.origin === "declared");
        expect(declared.length).toBeGreaterThan(0);
        expect(
          declared.some((entry) =>
            (entry.label.confidentiality ?? []).includes("secret")
          ),
        ).toBe(true);
        expect(
          writerFitDiagnostics(update).some((flag) =>
            flag.includes("writer-fit(runtime-owned-store-declared)")
          ),
        ).toBe(true);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("declares a builtin's own result store on a later transaction", async () => {
      // Instance 2: a dialog writes its own result while the conversation
      // carries a material-risk caveat. The store is minted from the node's
      // cause on the builtin's first run and written by every turn afterwards,
      // each on a transaction of its own.

      const caveat = {
        type: "https://commonfabric.org/cfc/atom/Caveat",
        kind:
          "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
        source: {
          type: "https://commonfabric.org/cfc/atom/Resource",
          class: "HostileVendorBriefing",
          subject: "did:example:writer-fit-owned-builtin",
        },
      } as const;

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(
          runtime,
          "writer-fit-owned-builtin-source",
          [caveat],
        );

        const mint = runtime.edit();
        mint.setCfcEnforcementMode("enforce-strict");
        const node = runtime.getCell(
          signer.did(),
          "writer-fit-owned-builtin-node",
          undefined,
          mint,
        );
        const store = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-owned-builtin-store",
          undefined,
          mint,
        );
        recordRuntimeOwnedStore(runtime, mint, node, store);
        store.set({});
        const storeId = store.getAsNormalizedFullLink().id;
        mint.prepareCfc();
        expect((await mint.commit()).ok).toBeDefined();

        const turn = runtime.edit();
        turn.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-owned-builtin-source",
          undefined,
          turn,
        );
        const raw = source.getRaw() as { secret?: string };
        const storeInTurn = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-owned-builtin-store",
          undefined,
          turn,
        );
        storeInTurn.set({ copied: `${raw.secret}!` });
        turn.prepareCfc();
        expect((await turn.commit()).ok).toBeDefined();

        expect(
          replicaEntries(storageManager, storeId).some((entry) =>
            entry.origin === "declared" &&
            JSON.stringify(entry.label.confidentiality ?? []).includes(
              "prompt-injection-risk-unscreened",
            )
          ),
        ).toBe(true);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("taints every reader with what a grown declaration admits", async () => {
      // This is what makes the route safe to run on every write rather than
      // only while a piece is being set up. A declared clause list is read two
      // ways, and the two agree: as a ceiling a label clause is admitted when
      // SOME declared clause subsumes it, and as a reader's taint the whole
      // list is a conjunction every reader carries. So each upgrade admits
      // more data AND narrows the audience by the same step, however many
      // times it happens — a store an unbounded reactive stream has walked is
      // readable by fewer people than when it started, never by more.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        for (const clause of ["alpha", "beta", "gamma"]) {
          await seedSecretSource(
            runtime,
            `writer-fit-owned-walk-${clause}`,
            [clause],
          );
        }

        const born = runtime.edit();
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-walk-result",
          undefined,
          born,
        );
        const store = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-owned-walk-store",
          undefined,
          born,
        );
        recordRuntimeOwnedStore(runtime, born, result, store);
        store.set({ copied: "public" });
        const storeId = store.getAsNormalizedFullLink().id;
        expect((await born.commit()).ok).toBeDefined();

        // One upgrade per clause, each on its own transaction, none of which
        // names a store: the enrollment above is all they have.
        for (const clause of ["alpha", "beta", "gamma"]) {
          const tx = runtime.edit();
          tx.setCfcEnforcementMode("enforce-strict");
          const source = runtime.getCell(
            signer.did(),
            `writer-fit-owned-walk-${clause}`,
            undefined,
            tx,
          );
          const raw = source.getRaw() as { secret?: string };
          const storeInTx = runtime.getCell<{ copied?: string }>(
            signer.did(),
            "writer-fit-owned-walk-store",
            undefined,
            tx,
          );
          // A distinct value per round: an identical write diffs to nothing
          // and would leave the declaration where the round before put it.
          storeInTx.set({ copied: `${raw.secret}/${clause}` });
          tx.prepareCfc();
          expect((await tx.commit()).ok).toBeDefined();
        }

        const declared = replicaEntries(storageManager, storeId)
          .filter((entry) => entry.origin === "declared");
        expect(declared.length).toBe(1);
        expect(declared[0].label.confidentiality).toEqual([
          "alpha",
          "beta",
          "gamma",
        ]);

        // The negative the growth implies: a reader of the walked store
        // carries all three, so copying what it read into an undeclared store
        // is refused on every one of them.
        const readBack = runtime.edit();
        readBack.setCfcEnforcementMode("enforce-strict");
        const storeInRead = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-owned-walk-store",
          undefined,
          readBack,
        );
        const seen = storeInRead.getRaw() as { copied?: string };
        const sink = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-owned-walk-sink",
          undefined,
          readBack,
        );
        sink.set({ copied: `${seen.copied}?` });
        readBack.prepareCfc();
        const refused = await readBack.commit();
        expect(refused.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        for (const clause of ["alpha", "beta", "gamma"]) {
          expect(refused.error?.message).toContain(`"${clause}"`);
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a later write to a document beside a store it owns", async () => {
      // Widening the route in TIME must not widen it in SCOPE. An enrollment
      // names one store; a bystander written by a later transaction of the
      // same piece keeps its own ceiling.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-bystander-source");

        const setup = runtime.edit();
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-bystander-result",
          undefined,
          setup,
        );
        const store = runtime.getCell(
          signer.did(),
          "writer-fit-owned-bystander-store",
          undefined,
          setup,
        );
        recordRuntimeOwnedStore(runtime, setup, result, store);
        store.set({ copied: "public" });
        expect((await setup.commit()).ok).toBeDefined();

        const later = runtime.edit();
        later.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-owned-bystander-source",
          undefined,
          later,
        );
        const raw = source.getRaw() as { secret?: string };
        const bystander = runtime.getCell(
          signer.did(),
          "writer-fit-owned-bystander",
          undefined,
          later,
        );
        bystander.set({ copied: `${raw.secret}!` });
        const bystanderId = bystander.getAsNormalizedFullLink().id;
        later.prepareCfc();
        const committed = await later.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(`for ${bystanderId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("enrolls nothing from a marker the runtime did not record", async () => {
      // The across-transaction twin of the unauthorized-marker case: an
      // unmarked marker names nothing in its own transaction, and leaves
      // nothing behind for a later one either.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-forged-source");

        const forge = runtime.edit();
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-forged-result",
          undefined,
          forge,
        );
        const store = runtime.getCell(
          signer.did(),
          "writer-fit-owned-forged-store",
          undefined,
          forge,
        );
        recordRuntimeOwnedStore(runtime, forge, result, store, false);
        store.set({ copied: "public" });
        const storeId = store.getAsNormalizedFullLink().id;
        expect((await forge.commit()).ok).toBeDefined();

        const later = runtime.edit();
        later.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-owned-forged-source",
          undefined,
          later,
        );
        const raw = source.getRaw() as { secret?: string };
        const storeLater = runtime.getCell(
          signer.did(),
          "writer-fit-owned-forged-store",
          undefined,
          later,
        );
        storeLater.set({ copied: `${raw.secret}!` });
        later.prepareCfc();
        const committed = await later.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(`for ${storeId} at /`);
        // The stored value pins the store the forged marker named, so the
        // absent declaration below is that document's own.
        expect(storedDocument(storageManager, storeId)?.value).toEqual({
          copied: "public",
        });
        expect(
          replicaEntries(storageManager, storeId).some((entry) =>
            entry.origin === "declared"
          ),
        ).toBe(false);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("adds a clause rather than an alternative to one already there", async () => {
      // The line §8.12.7 draws, and safety invariant 1 with it. Adding a
      // CLAUSE is tightening, which §8.12.1 admits and §8.12.5 sanctions as
      // the upgrade. Adding an ALTERNATIVE to a clause already stored grows
      // that clause's reader set, which is a widening `canUpdateStoreLabel`
      // rejects and which §8.12.7 admits only through a grant record or an
      // intent-gated declassification event — neither of which a write-side
      // fit check is.
      //
      // So the route folds clause LISTS and never clause alternatives: a
      // stored `anyOf` comes back exactly as it went in, beside the new
      // clause rather than holding it.

      const audience = {
        anyOf: [
          userPrincipal(signer.did()),
          userPrincipal(OTHER_PRINCIPAL),
        ],
      };

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-clause-first", [
          audience,
        ]);
        await seedSecretSource(runtime, "writer-fit-owned-clause-second", [
          userPrincipal(THIRD_PRINCIPAL),
        ]);

        const enrol = runtime.edit();
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-clause-result",
          undefined,
          enrol,
        );
        const store = runtime.getCell(
          signer.did(),
          "writer-fit-owned-clause-store",
          undefined,
          enrol,
        );
        recordRuntimeOwnedStore(runtime, enrol, result, store);
        store.set({ copied: "public" });
        const storeId = store.getAsNormalizedFullLink().id;
        expect((await enrol.commit()).ok).toBeDefined();

        expect(
          (await writeSecretInto(
            runtime,
            "writer-fit-owned-clause-first",
            "writer-fit-owned-clause-store",
          )).error,
        ).toBeUndefined();
        expect(
          (await writeSecretInto(
            runtime,
            "writer-fit-owned-clause-second",
            "writer-fit-owned-clause-store",
            "second",
          )).error,
        ).toBeUndefined();

        const declared = replicaEntries(storageManager, storeId)
          .filter((entry) => entry.origin === "declared");
        expect(declared.length).toBe(1);
        const clauses = declared[0].label.confidentiality ?? [];
        // Two clauses. The `anyOf` carries the alternatives it arrived with
        // and no more — canonical order, not membership, is what normalizing
        // it changes — and the second clause stands beside it.
        expect(clauses.length).toBe(2);
        const orClause = clauses.find((clause) =>
          isObjectOrArray(clause) && "anyOf" in clause
        ) as { anyOf: unknown[] } | undefined;
        expect(orClause).toBeDefined();
        expect(orClause!.anyOf.length).toBe(2);
        expect(orClause!.anyOf).toContainEqual(userPrincipal(signer.did()));
        expect(orClause!.anyOf).toContainEqual(userPrincipal(OTHER_PRINCIPAL));
        expect(clauses).toContainEqual(userPrincipal(THIRD_PRINCIPAL));
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("names nothing where the owner is in another space", async () => {
      // A store in another space belongs to whoever holds that space's
      // replicas. Declaring a policy on it out of this piece's join would put
      // those bytes behind a promise made here, so a marker naming one counts
      // for nothing however it is authorized.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-foreign-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-owned-foreign-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-foreign-result",
          undefined,
          tx,
        );
        const store = runtime.getCell(
          signer.did(),
          "writer-fit-owned-foreign-store",
          undefined,
          tx,
        );
        const storeLink = store.getAsNormalizedFullLink();
        const resultLink = result.getAsNormalizedFullLink();
        // The marker as the runtime records it, except that the source names
        // another space — which is what the guard reads.
        tx.recordCfcWritePolicyInput({
          kind: "structural-provenance",
          target: {
            space: storeLink.space as `did:${string}:${string}`,
            scope: storeLink.scope as "space",
            id: storeLink.id,
            path: [],
          },
          claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
          sources: [{
            space: OTHER_SPACE,
            scope: "space",
            id: resultLink.id,
            path: [],
          }],
        }, runtimeWritePolicyAuthorization);
        store.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(`for ${storeLink.id} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("forgets what a piece enrolled when the piece is released", async () => {
      // The enrollment lasts as long as the piece's nodes do, which is what
      // bounds it: a list operation mints one piece per element, so an
      // enrollment that lived for the process would grow with every element a
      // churning list ever held.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-release-source");
        // A clause per write. Each route-2 upgrade declares what it carried,
        // so a later write reusing an earlier clause would fit the store's own
        // declaration whatever the enrollment says.
        await seedSecretSource(runtime, "writer-fit-owned-release-second", [
          "second-clause",
        ]);
        await seedSecretSource(runtime, "writer-fit-owned-release-third", [
          "third-clause",
        ]);

        const enrol = runtime.edit();
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-release-result",
          undefined,
          enrol,
        );
        const store = runtime.getCell(
          signer.did(),
          "writer-fit-owned-release-store",
          undefined,
          enrol,
        );
        recordRuntimeOwnedStore(runtime, enrol, result, store);
        store.set({ copied: "public" });
        const storeId = store.getAsNormalizedFullLink().id;
        expect((await enrol.commit()).ok).toBeDefined();

        // A write in a later transaction takes the route while the piece
        // holds the enrollment.
        const declared = await writeSecretInto(
          runtime,
          "writer-fit-owned-release-source",
          "writer-fit-owned-release-store",
        );
        expect(declared.error).toBeUndefined();

        // An unauthorized release changes nothing: pattern-authored code
        // reaches the runtime through a cell, and a release it made would
        // refuse another piece's writes.
        runtime.releaseRuntimeOwnedStores(
          result.getAsNormalizedFullLink(),
          undefined,
        );
        expect(
          (await writeSecretInto(
            runtime,
            "writer-fit-owned-release-second",
            "writer-fit-owned-release-store",
            "second",
          )).error,
        ).toBeUndefined();

        runtime.releaseRuntimeOwnedStores(
          result.getAsNormalizedFullLink(),
          runtimeWritePolicyAuthorization,
        );
        const refused = await writeSecretInto(
          runtime,
          "writer-fit-owned-release-third",
          "writer-fit-owned-release-store",
          "third",
        );
        expect(refused.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(refused.error?.message).toContain(`for ${storeId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps a store a second owner still holds", async () => {
      // Two scope instances of one causal piece are two registrations that
      // start and stop separately, so they are two owners of the same store —
      // the store key is scope-free, because the scoped instances of one
      // causal id are instances of one cell. Releasing either owner must
      // leave the other's writes admitted; dropping the store on the first
      // release would refuse the survivor.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-two-owners-source");
        await seedSecretSource(runtime, "writer-fit-owned-two-owners-other", [
          "other",
        ]);

        const store = runtime.getCell(
          signer.did(),
          "writer-fit-owned-two-owners-store",
          undefined,
        );
        const storeLink = store.getAsNormalizedFullLink();
        const first = runtime.getCell(
          signer.did(),
          "writer-fit-owned-two-owners-piece",
          undefined,
        );
        const firstLink = first.getAsNormalizedFullLink();
        // The same causal piece at a narrower scope: same id, different
        // instance, so `runtimeOwnedStoreOwnerKey` gives a different owner.
        const secondLink = { ...firstLink, scope: "user" } as typeof firstLink;

        const tx = runtime.edit();
        for (const owner of [firstLink, secondLink]) {
          const ownerKey = runtimeOwnedStoreOwnerKey(
            storeLink,
            owner,
            runtime.scopeKeyIdentity,
          );
          expect(ownerKey).toBeDefined();
          tx.enrollRuntimeOwnedStore(
            {
              space: storeLink.space,
              scope: storeLink.scope,
              id: storeLink.id,
              path: [],
            },
            ownerKey!,
            runtimeWritePolicyAuthorization,
          );
        }
        store.withTx(tx).set({ copied: "public" });
        expect((await tx.commit()).ok).toBeDefined();

        // The first owner goes; the second still holds the store.
        runtime.releaseRuntimeOwnedStores(
          firstLink,
          runtimeWritePolicyAuthorization,
        );
        expect(
          (await writeSecretInto(
            runtime,
            "writer-fit-owned-two-owners-source",
            "writer-fit-owned-two-owners-store",
          )).error,
        ).toBeUndefined();

        // The second goes too, and now nobody does.
        runtime.releaseRuntimeOwnedStores(
          secondLink,
          runtimeWritePolicyAuthorization,
        );
        const refused = await writeSecretInto(
          runtime,
          "writer-fit-owned-two-owners-other",
          "writer-fit-owned-two-owners-store",
          "second",
        );
        expect(refused.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(refused.error?.message).toContain(`for ${storeLink.id} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps the enrollment across a second instantiation", async () => {
      // The enrollment is released once, with the PIECE, not with each node
      // group. Every site that re-instantiates a piece — a pattern swap, a
      // start repair, a withdrawn-contribution recovery — tears the previous
      // node group down first and instantiates afterwards, so a release hung
      // on that group would leave a running piece un-enrolled wherever those
      // two steps were ever ordered the other way. Enrolling twice is what a
      // re-instantiation does, and it is idempotent.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-reinstate-source");

        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-reinstate-result",
          undefined,
        );
        const store = runtime.getCell(
          signer.did(),
          "writer-fit-owned-reinstate-store",
          undefined,
        );
        const storeId = store.getAsNormalizedFullLink().id;

        // Two instantiations, as a swap or a recovery makes them.
        for (const _ of [0, 1]) {
          const tx = runtime.edit();
          recordRuntimeOwnedStore(runtime, tx, result, store);
          expect((await tx.commit()).ok).toBeDefined();
        }

        const declared = await writeSecretInto(
          runtime,
          "writer-fit-owned-reinstate-source",
          "writer-fit-owned-reinstate-store",
        );
        expect(declared.error).toBeUndefined();

        // And one release still takes it out: the second enrollment did not
        // leave a second entry the release would miss.
        runtime.releaseRuntimeOwnedStores(
          result.getAsNormalizedFullLink(),
          runtimeWritePolicyAuthorization,
        );
        await seedSecretSource(runtime, "writer-fit-owned-reinstate-other", [
          "other",
        ]);
        const refused = await writeSecretInto(
          runtime,
          "writer-fit-owned-reinstate-other",
          "writer-fit-owned-reinstate-store",
          "second",
        );
        expect(refused.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(refused.error?.message).toContain(`for ${storeId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("declares on a document anchored inside a store it owns", async () => {
      // Anchoring splits one value across two documents. The child's id is
      // derived from the parent's rather than named by an author, and nothing
      // but this write puts anything in it, so it is the runtime's store
      // whenever the parent is.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-owned-anchor-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-owned-anchor-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-owned-anchor-result",
          undefined,
          tx,
        );
        const store = runtime.getCell<{ note: string }[]>(
          signer.did(),
          "writer-fit-owned-anchor-store",
          anchoringList(),
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, store);
        store.set([{ note: `${raw.secret}!` }]);
        const storeId = store.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        // The parent's own write is all links, so it takes shape-only stamps
        // and is never measured; the content — and the declaration — lands on
        // the document the write anchored.
        const declaredOn = writerFitDiagnostics(tx)
          .filter((flag) =>
            flag.includes("writer-fit(runtime-owned-store-declared)")
          );
        expect(declaredOn.length).toBe(1);
        expect(declaredOn[0]).not.toContain(storeId);
        expect(declaredOn[0]).toContain('"secret"');
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a document anchored inside an ordinary one", async () => {
      // The negative twin: the same anchored write under a parent the runtime
      // does not own. The parent's own write is all links, so it is never
      // measured; the anchored child is, and it is refused, because the
      // child's ownership comes from the parent's and there is none.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-plain-anchor-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-plain-anchor-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const store = runtime.getCell<{ note: string }[]>(
          signer.did(),
          "writer-fit-plain-anchor-store",
          anchoringList(),
          tx,
        );
        store.set([{ note: `${raw.secret}!` }]);
        const storeId = store.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain('"secret"');
        expect(committed.error?.message).not.toContain(`for ${storeId} at /`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a substrate write at a path its own schema declares", async () => {
      // A schema that declares at the written path owns the store's policy
      // there, and widening it from the join would make the walk's own
      // re-mint non-monotone on the next write. That store's route 2 is the
      // author's, in the schema.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-declared-source");

        // The field has to exist already: a key write into a document this
        // transaction is also creating materializes the whole document, and
        // lands at the root rather than at the declared field.
        const create = runtime.edit();
        runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-seam-declared-substrate",
          undefined,
          create,
        ).set({ copied: "public" });
        expect((await create.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-declared-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-declared-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-seam-declared-substrate",
          {
            type: "object",
            properties: {
              copied: {
                type: "string",
                ifc: { confidentiality: ["policy"] },
              },
            },
          },
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        substrate.key("copied").set(`${raw.secret}!`);
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain("at /copied");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a substrate write whose marker names only part of the document", async () => {
      // The route declares a policy for the whole store, so it takes a
      // marker only where the marker claims the whole store. Setup records
      // the empty path for every document it mints from a result cell, so
      // this excludes a stored argument link that points inside some other
      // document.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-partial-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-partial-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-partial-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell<{ copied?: string }>(
          signer.did(),
          "writer-fit-seam-partial-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate.key("copied"));
        substrate.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a clause naming a space other than the target's", async () => {
      // A `Space` clause is honored by a replica set, not by a reader check,
      // which is why residency admits only the target's own. Declaring a
      // foreign one would put the bytes in front of this space's members
      // under a promise made to another space's readers.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-foreign-source", [{
          type: "https://commonfabric.org/cfc/atom/Space",
          id: "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H",
        }]);

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-foreign-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-foreign-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-foreign-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(storedDocument(storageManager, substrateId)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a personal-space clause naming a space other than the target's", async () => {
      // `PersonalSpace(owner)` is the second spelling of a container
      // audience, so it answers to the same rule: the owner's personal
      // space is a space of its own, and a store here cannot keep a promise
      // made to that space's readers.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-personal-source", [{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H",
        }]);

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-personal-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-personal-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-personal-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(storedDocument(storageManager, substrateId)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("declares a personal-space clause naming the target's own space", async () => {
      // The same-space spelling is keepable, so the route takes it: the
      // clause names the space the bytes are already in, and if that space
      // stops being personal the audience and the replica set grow
      // together.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        const ownPersonalSpace = {
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: signer.did(),
        };
        await seedSecretSource(runtime, "writer-fit-seam-own-personal-source", [
          ownPersonalSpace,
        ]);

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-own-personal-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-own-personal-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-own-personal-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        expect(
          replicaEntries(storageManager, substrateId)
            .filter((entry) => entry.origin === "declared")
            .flatMap((entry) => entry.label.confidentiality ?? []),
        ).toContainEqual(ownPersonalSpace);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a substrate write whose marker the runtime did not record", async () => {
      // `recordCfcWritePolicyInput` is on the public transaction interface,
      // and pattern-authored code reaches the transaction its cells are bound
      // to, so a marker naming any document at all can be recorded by
      // anything holding one. Without the runtime's authorization the route
      // does not fire, and the document keeps the ceiling it resolves to.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-forged-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-forged-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-forged-result",
          undefined,
          tx,
        );
        const bystander = runtime.getCell<{ note?: string }>(
          signer.did(),
          "writer-fit-seam-forged-bystander",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, bystander, false);
        bystander.set({ note: `${raw.secret}!` });
        const bystanderId = bystander.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(`for ${bystanderId} at /`);
        expect(storedDocument(storageManager, bystanderId)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a substrate write named by a different provenance claim", async () => {
      // A whole-document address alone does not establish runtime ownership;
      // the provenance claim must name that authority.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-claim-source");

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-claim-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-claim-substrate",
          undefined,
          tx,
        );
        const link = substrate.getAsNormalizedFullLink();
        tx.recordCfcWritePolicyInput({
          kind: "structural-provenance",
          target: {
            space: link.space,
            scope: link.scope,
            id: link.id,
            path: [],
          },
          claim: "unrelated.claim",
          sources: [{
            space: link.space,
            scope: link.scope,
            id: link.id,
            path: [],
          }],
        });
        substrate.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a poisoned measurement on a substrate document", async () => {
      // The ungrantable read-failed marker is outside every ceiling, so it
      // is outside what the route may declare: a measurement the runtime
      // could not take proves nothing about the audience, and declaring it
      // would write a clause no reader can ever satisfy.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-poisoned-source", [{
          anyOf: [CFC_LABEL_READ_FAILED_ATOM, ownSpacePrincipal],
        }]);

        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-poisoned-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-poisoned-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-poisoned-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(committed.error?.message).toContain(CFC_LABEL_READ_FAILED_ATOM);
        expect(storedDocument(storageManager, substrateId)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps the clauses an ancestor path already declared", async () => {
      // The route declares the resolved ceiling as well as the offending
      // clauses. Reads resolve declared entries by longest prefix, so a mint
      // that carried only what was offending would shadow the ancestor
      // declaration at every path below it — lowering the store's promise
      // through the very entry meant to raise it.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-ancestor-first");
        await seedSecretSource(runtime, "writer-fit-seam-ancestor-second", [
          "other",
        ]);

        const writeUnder = async (sourceName: string, field: string) => {
          const tx = runtime.edit();
          tx.setCfcEnforcementMode("enforce-strict");
          const source = runtime.getCell(
            signer.did(),
            sourceName,
            undefined,
            tx,
          );
          const raw = source.getRaw() as { secret?: string };
          const result = runtime.getCell(
            signer.did(),
            "writer-fit-seam-ancestor-result",
            undefined,
            tx,
          );
          const substrate = runtime.getCell<Record<string, string>>(
            signer.did(),
            "writer-fit-seam-ancestor-substrate",
            undefined,
            tx,
          );
          recordRuntimeOwnedStore(runtime, tx, result, substrate);
          if (field === "") {
            substrate.set({ first: `${raw.secret}!` });
          } else {
            substrate.key(field).set(`${raw.secret}!`);
          }
          const substrateId = substrate.getAsNormalizedFullLink().id;
          tx.prepareCfc();
          expect((await tx.commit()).ok).toBeDefined();
          return replicaEntries(storageManager, substrateId);
        };

        // The document root declares the first join.
        expect(
          (await writeUnder("writer-fit-seam-ancestor-first", ""))
            .filter((entry) =>
              entry.origin === "declared" && entry.path.length === 0
            )
            .flatMap((entry) => entry.label.confidentiality ?? []),
        ).toEqual(["secret"]);

        // A later write below it carries a join the root does not cover, so
        // the route declares at the deeper path — and that declaration is
        // what a reader of the deeper path resolves, so it has to carry the
        // root's clause too.
        const deeper = (await writeUnder(
          "writer-fit-seam-ancestor-second",
          "second",
        ))
          .filter((entry) =>
            entry.origin === "declared" && entry.path.join("/") === "second"
          )
          .flatMap((entry) => entry.label.confidentiality ?? []);
        expect(deeper).toContain("secret");
        expect(deeper).toContain("other");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("leaves the persist-and-flag diagnostic in place under enforce-explicit", async () => {
      // The route is the strict rung's, like the reject it replaces. Every
      // rung below keeps the diagnostic that is its rollout signal, and
      // stores no declared policy it could never take back.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-explicit-source");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-explicit-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          signer.did(),
          "writer-fit-seam-explicit-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(
          signer.did(),
          "writer-fit-seam-explicit-substrate",
          undefined,
          tx,
        );
        recordRuntimeOwnedStore(runtime, tx, result, substrate);
        substrate.set({ copied: `${raw.secret}!` });
        const substrateId = substrate.getAsNormalizedFullLink().id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        expect(
          writerFitDiagnostics(tx).some((flag) =>
            flag.includes("writer-fit(persist-and-flag)") &&
            flag.includes(`${substrateId} at /`)
          ),
        ).toBe(true);
        // The stored value pins the flagged document, so the absent
        // declaration below is that document's own.
        expect(storedDocument(storageManager, substrateId)?.value).toEqual({
          copied: "s3cr3t!",
        });
        expect(
          replicaEntries(storageManager, substrateId)
            .filter((entry) => entry.origin === "declared"),
        ).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("declares on both documents a real setup writes", async () => {
      // Drives the production recorder rather than the marker the tests
      // above hand-record: `setup` marks the argument document and each
      // internal document its result projects to, and a first setup inside
      // a labeled transaction writes both.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-both-source");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-both-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const resultCell = runtime.getCell(
          signer.did(),
          "writer-fit-seam-both",
          seamResultSchema,
          tx,
        );
        await runtime.setup(
          tx,
          seamPattern,
          { title: `${raw.secret}!` },
          resultCell,
        );
        const argumentId = parseLink(
          resultCell.getMetaRaw("argument"),
          resultCell,
        )!.id!;
        const internalId = getDerivedInternalCellLink(
          resultCell,
          seamPattern.derivedInternalCells[0],
        ).id;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        for (const id of [argumentId, internalId]) {
          expect(
            replicaEntries(storageManager, id).filter((entry) =>
              entry.origin === "declared" &&
              (entry.label.confidentiality ?? []).includes("secret")
            ).length,
          ).toBe(1);
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("rejects a setup whose stored argument link names another document", async () => {
      // `setup` reads the argument address back out of the result cell's
      // stored meta, where it need not name the document that result cell's
      // cause mints. The marker follows the minted address, so a stored link
      // aimed elsewhere carries no route and that document keeps its own
      // ceiling.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-aimed-source");

        const aim = runtime.edit();
        const resultCell = runtime.getCell(
          signer.did(),
          "writer-fit-seam-aimed",
          seamResultSchema,
          aim,
        );
        const bystander = runtime.getCell<{ note?: string }>(
          signer.did(),
          "writer-fit-seam-aimed-bystander",
          undefined,
          aim,
        );
        bystander.set({ note: "public" });
        const bystanderId = bystander.getAsNormalizedFullLink().id;
        resultCell.withTx(aim).setMetaRaw(
          "argument",
          bystander.getAsWriteRedirectLink({ base: resultCell }),
          rawMetaWriteAuthorization,
        );
        expect((await aim.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-aimed-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const reused = runtime.getCell(
          signer.did(),
          "writer-fit-seam-aimed",
          seamResultSchema,
          tx,
        );
        await runtime.setup(
          tx,
          seamPattern,
          { title: `${raw.secret}!` },
          reused,
        );
        tx.prepareCfc();
        const committed = await tx.commit();
        expect(committed.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        // The stored value pins the bystander, so the absent declaration
        // below is that document's own.
        expect(storedDocument(storageManager, bystanderId)?.value).toEqual({
          note: "public",
        });
        expect(
          replicaEntries(storageManager, bystanderId)
            .filter((entry) => entry.origin === "declared"),
        ).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("commits a piece instantiation whose transaction read labeled data", async () => {
      // The end-to-end shape the hand-recorded marker above stands in for: a
      // real `setup` writing a real piece's argument document. The piece is
      // set up twice — first with nothing labeled in the transaction, then
      // inside one that read a labeled document — so the second setup
      // finds an argument document that already exists and declares
      // nothing, which a create-only route would refuse.

      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "writer-fit-seam-piece-source");

        const tx = runtime.edit();
        const resultCell = runtime.getCell(
          signer.did(),
          "writer-fit-seam-piece",
          seamResultSchema,
          tx,
        );
        await runtime.setup(
          tx,
          seamPattern,
          { title: "public" },
          resultCell,
        );
        const argumentId = parseLink(
          resultCell.getMetaRaw("argument"),
          resultCell,
        )!.id!;
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();

        const labeled = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "writer-fit-seam-piece-source",
          undefined,
          labeled,
        );
        const raw = source.getRaw() as { secret?: string };
        const reused = runtime.getCell(
          signer.did(),
          "writer-fit-seam-piece",
          seamResultSchema,
          labeled,
        );
        await runtime.setup(
          labeled,
          seamPattern,
          { title: `${raw.secret}!` },
          reused,
        );
        labeled.prepareCfc();
        expect((await labeled.commit()).ok).toBeDefined();

        const entries = replicaEntries(storageManager, argumentId);
        expect(entries.some((entry) =>
          entry.origin === "declared" &&
          (entry.label.confidentiality ?? []).includes("secret")
        )).toBe(true);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
