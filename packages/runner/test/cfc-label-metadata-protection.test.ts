import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { labelsReached, labelsThroughLink } from "./support/reached-labels.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { stampExternalIngest } from "../src/cfc/external-ingest.ts";
import {
  commitCfcFieldValue,
  containsCfcFieldCommitment,
} from "../src/cfc/label-representation.ts";
import type { CfcLabelMetadataProtectionMode } from "../src/cfc/mod.ts";
import { recordReferencedArgumentFields } from "../src/cfc/reference-initialization.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-label-metadata-protection",
);
const foreignSigner = await Identity.fromPassphrase(
  "runner-cfc-label-metadata-protection-foreign",
);
// The destination space (`spaceB`) and the foreign source space (`spaceA`).
const spaceB = signer.did();
const spaceA = foreignSigner.did();

type PersistedEntry = {
  path: string[];
  origin?: string;
  observes?: string;
  label: {
    confidentiality?: unknown[];
    integrity?: Array<Record<string, unknown>>;
  };
};

describe("CFC cross-space label-metadata persist transform (inv-12 Stage 1)", () => {
  // At the cross-space persist seam (docs/specs/
  // cfc-label-metadata-confidentiality.md §2/§5; spec §4.6.4.1 "Cross-space
  // derived labels"), prepareBoundaryCommit applies the classification table
  // to every source-bearing atom field of entries whose observations
  // originate OUTSIDE the destination space: the link entry a link write
  // mints at its slot when the reference names a document of another space
  // (the reference's own label, the carried sigil `cfcLabelView` root among
  // its parts), and flow-derived entries whose join consumed a labeled
  // foreign observation. A link write persists nothing of its source's
  // labels, so those stay where they are and are reached through the link.
  // Same-space-only labels persist verbatim. Behind
  // `cfcLabelMetadataProtection: off | observe | enforce`.

  const fullSource = { space: spaceA, id: "of:remote-origin", path: [] };
  const caveatAtom = {
    type: CFC_ATOM_TYPE.Caveat,
    kind: "derived-from",
    source: fullSource,
  };
  const userAtom = { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" };

  const makeRuntime = (
    mode: CfcLabelMetadataProtectionMode | undefined,
    extra: { cfcFlowLabels?: "off" | "observe" | "persist" } = {},
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...(mode !== undefined ? { cfcLabelMetadataProtection: mode } : {}),
      ...(extra.cfcFlowLabels !== undefined
        ? { cfcFlowLabels: extra.cfcFlowLabels }
        : {}),
    });
    return { storageManager, runtime };
  };

  // A store that declares the clauses the seeded source's join carries.
  // Writer-fit measures a join against the declaration at its path.
  const joinStoreSchema: JSONSchema = {
    type: "object",
    ifc: { confidentiality: [userAtom, caveatAtom] } as never,
  };

  const persistedEntriesFor = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    space: MemorySpace,
    id: string,
  ): PersistedEntry[] => {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: PersistedEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  // Seed a source doc in `sourceSpace` whose STORED cfc metadata carries a
  // root User clause and a sub-path Caveat entry, the labels a read through
  // a link to it reaches where they are. `extraRootClauses` adds further
  // clauses to the root entry.
  const seedSource = async (
    runtime: Runtime,
    sourceSpace: MemorySpace,
    name: string,
    extraRootClauses: { type: string; id: string }[] = [],
  ): Promise<string> => {
    const seed = runtime.edit();
    const sourceId = parseLink(
      runtime.getCell(sourceSpace, name, undefined, seed).getAsLink(),
    ).id!;
    writeSeedEnvelopeDoc(seed, sourceSpace);
    seedStoredEnvelope(seed, {
      space: sourceSpace,
      scope: "space",
      id: sourceId,
      path: [],
    }, {
      value: { secret: "classified", plain: "public" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [
            {
              path: [],
              label: { confidentiality: [userAtom, ...extraRootClauses] },
            },
            { path: ["secret"], label: { confidentiality: [caveatAtom] } },
          ],
        },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    return sourceId;
  };

  // The restriction a handle to the seeded source carries at its root: the
  // foreign reader, a caveat naming the foreign document, and an atom with
  // nothing to classify.
  const carriedRoot = [userAtom, caveatAtom, "opaque-tag"];

  // One cross-space (or same-space) link write: a value write in the target
  // space plus the link-write policy input naming the seeded source, with a
  // carried `cfcLabelView` (the in-value sigil copy) whose root holds
  // `rootClauses` and which also describes a position below the root.
  const commitLinkWrite = async (
    runtime: Runtime,
    sourceSpace: MemorySpace,
    sourceId: string,
    targetName: string,
    rootClauses: unknown[] = carriedRoot,
  ): Promise<{ targetId: string; tx: ReturnType<Runtime["edit"]> }> => {
    const tx = runtime.edit();
    const target = runtime.getCell(spaceB, targetName, undefined, tx);
    const targetId = target.getAsNormalizedFullLink().id;
    tx.markCfcRelevant("test");
    tx.writeValueOrThrow({
      space: spaceB,
      scope: "space",
      id: targetId,
      path: ["field"],
    }, linkRefFrom({ space: sourceSpace, id: sourceId, path: [] }));
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: {
        space: spaceB,
        scope: "space",
        id: targetId,
        path: ["field"],
      },
      source: {
        space: sourceSpace,
        scope: "space",
        id: sourceId,
        path: [],
      },
      cfcLabelView: {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: rootClauses as never },
        }, {
          // Below the root the view describes a position of the target,
          // which the target labels itself; nothing of it is persisted.
          path: ["carriedOnly"],
          label: { confidentiality: [userAtom] },
        }],
      },
    });
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    return { targetId, tx };
  };

  // The same link write with no carried view: a reference acquired under no
  // restriction, by an attempt that observed nothing.
  const commitBareLinkWrite = async (
    tx: ReturnType<Runtime["edit"]>,
    sourceId: string,
    targetId: URI,
    field: string,
  ) => {
    tx.markCfcRelevant("test");
    tx.writeValueOrThrow({
      space: spaceB,
      scope: "space",
      id: targetId,
      path: [field],
    }, linkRefFrom({ space: spaceA, id: sourceId, path: [] }));
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: { space: spaceB, scope: "space", id: targetId, path: [field] },
      source: { space: spaceA, scope: "space", id: sourceId, path: [] },
      cfcLabelView: {
        version: 1,
        entries: [{ path: [], label: { confidentiality: [userAtom] } }],
      },
    });
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
  };

  const entryAt = (
    entries: PersistedEntry[],
    path: string[],
  ): PersistedEntry | undefined =>
    entries.find((entry) =>
      entry.path.length === path.length &&
      entry.path.every((seg, i) => seg === path[i])
    );

  for (const backReference of [false, true]) {
    it(`stores no foreign clause along a pending foreign reference followed by a local reference${backReference ? " through an object back-reference" : ""}`, async () => {
      // Neither link carries its source's labels: the foreign reader and
      // the caveat naming the foreign document stay in the foreign space,
      // and a read through the chain reaches them there. With nothing
      // foreign persisted in this space, the transform has nothing to
      // commit, in its strictest mode as in any other.

      const { storageManager, runtime } = makeRuntime("enforce");
      try {
        await seedSource(runtime, spaceA, "chain-source");
        const tx = runtime.edit();
        const schema: JSONSchema = {
          type: "object",
          properties: {
            field: { type: "object", ifc: { integrity: ["argument"] } },
            self: { type: "object", ifc: { integrity: ["object"] } },
          },
        };
        const first = runtime.getCell(spaceB, "chain-first", schema, tx);
        const second = runtime.getCell(spaceB, "chain-second", schema, tx);
        second.set({
          field: backReference
            ? first.key("self").key("field")
            : first.key("field"),
        });
        first.set({
          field: runtime.getCell(spaceA, "chain-source", undefined, tx),
          ...(backReference ? { self: first } : {}),
        });
        for (const cell of [second, first]) {
          recordReferencedArgumentFields(tx, cell.getAsNormalizedFullLink(), [
            "field",
            "self",
          ]);
        }
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        for (const cell of [second, first]) {
          const entries = persistedEntriesFor(
            storageManager,
            spaceB,
            cell.getAsNormalizedFullLink().id,
          );
          expect(JSON.stringify(entries)).not.toContain("did:key:alice");
          expect(JSON.stringify(entries)).not.toContain("remote-origin");
          expect(containsCfcFieldCommitment(entries)).toBe(false);
        }
        const reached = labelsReached(
          runtime,
          second.getAsNormalizedFullLink(),
          ["field", "secret"],
        );
        expect(reached.confidentiality).toContainEqual(userAtom);
        expect(reached.confidentiality).toContainEqual(caveatAtom);
      } finally {
        await runtime.dispose();
      }
    });
  }

  describe("enforce", () => {
    it("persists committed fields for a cross-space link write", async () => {
      const { storageManager, runtime } = makeRuntime("enforce");
      try {
        const sourceId = await seedSource(runtime, spaceA, "xspace-source");
        const { targetId } = await commitLinkWrite(
          runtime,
          spaceA,
          sourceId,
          "xspace-target",
        );
        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        const linkEntries = entries.filter((e) => e.origin === "link");
        // One entry, at the slot: the reference's own label.
        expect(linkEntries.map((e) => e.path)).toEqual([["field"]]);
        const rootEntry = linkEntries[0];

        // The carried root's User clause committed.
        expect(rootEntry.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
        // Its Caveat, source committed.
        expect(rootEntry.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.Caveat,
          kind: "derived-from",
          source: commitCfcFieldValue(fullSource),
        });
        // An atom with nothing classified persists verbatim (the
        // transform's copy-on-write passthrough).
        expect(rootEntry.label.confidentiality).toContainEqual("opaque-tag");

        // No plaintext DID survives anywhere in the persisted entries'
        // committed families.
        expect(JSON.stringify(entries)).not.toContain("did:key:alice");

        // The source's own sub-path label is not at the slot; it is reached
        // through the link, where the source stores it.
        expect(JSON.stringify(entries)).not.toContain("remote-origin");
        expect(
          labelsThroughLink(
            runtime,
            { space: spaceB, id: targetId, path: ["field"] },
            { space: spaceA, id: sourceId, path: ["secret"] },
          ).confidentiality,
        ).toContainEqual(caveatAtom);
      } finally {
        await runtime.dispose();
      }
    });

    it("persists a same-space link write verbatim (nothing foreign to protect)", async () => {
      const { storageManager, runtime } = makeRuntime("enforce");
      try {
        const sourceId = await seedSource(runtime, spaceB, "same-source");
        const { targetId } = await commitLinkWrite(
          runtime,
          spaceB,
          sourceId,
          "same-target",
        );
        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        const linkEntries = entries.filter((e) => e.origin === "link");
        expect(linkEntries.map((e) => e.path)).toEqual([["field"]]);
        expect(linkEntries[0].label.confidentiality).toContainEqual(userAtom);
        expect(linkEntries[0].label.confidentiality).toContainEqual(
          caveatAtom,
        );
        expect(containsCfcFieldCommitment(entries)).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });

    it("re-deriving a transformed envelope is a no-op (SC-11 post-transform idempotence)", async () => {
      const { storageManager, runtime } = makeRuntime("enforce");
      try {
        const sourceId = await seedSource(runtime, spaceA, "sc11-source");
        const { targetId } = await commitLinkWrite(
          runtime,
          spaceA,
          sourceId,
          "sc11-target",
        );
        const after1 = persistedEntriesFor(storageManager, spaceB, targetId);
        expect(containsCfcFieldCommitment(after1)).toBe(true);

        // Recompute: the same link-write input derives the same label from
        // the same (plaintext) carried view. The canonical equality is
        // computed POST-transform, so the recompute must not rewrite the
        // ["cfc"] envelope.
        const tx2 = runtime.edit();
        tx2.markCfcRelevant("test");
        tx2.recordCfcWritePolicyInput({
          kind: "link-write",
          target: {
            space: spaceB,
            scope: "space",
            id: targetId,
            path: ["field"],
          },
          source: {
            space: spaceA,
            scope: "space",
            id: sourceId,
            path: [],
          },
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: carriedRoot as never },
            }, {
              path: ["carriedOnly"],
              label: { confidentiality: [userAtom] },
            }],
          },
        });
        tx2.prepareCfc();
        const cfcWrites = [...(tx2.getWriteDetails?.(spaceB) ?? [])].filter(
          (detail) =>
            detail.address.id === targetId &&
            detail.address.path[0] === "cfc",
        );
        expect(cfcWrites).toEqual([]);
        expect((await tx2.commit().settled).ok).toBeDefined();
        const after2 = persistedEntriesFor(storageManager, spaceB, targetId);
        expect(after2).toEqual(after1);
      } finally {
        await runtime.dispose();
      }
    });

    it("keeps pre-existing verbatim entries while adding committed ones (mixed coexistence)", async () => {
      // The migration scenario: an envelope persisted BEFORE the dial
      // flipped holds verbatim foreign entries; flipping to enforce commits
      // only NEW cross-space entries — no rewrite of the existing ones —
      // and consumers dispatch on the marker shape, so both forms coexist.
      // The pre-flip world is staged with the dial pinned off; the flipped
      // half raises the same runtime's dial per transaction below.
      const { storageManager, runtime } = makeRuntime("off");
      try {
        const sourceId = await seedSource(runtime, spaceA, "mixed-source");
        const targetName = "mixed-target";
        // tx1 (dial off, the pre-Stage-1 world): a cross-space link write
        // whose reference carries the foreign reader persists it VERBATIM at
        // ["legacyField"].
        const tx1 = runtime.edit();
        const target = runtime.getCell(spaceB, targetName, undefined, tx1);
        const targetId = target.getAsNormalizedFullLink().id;
        await commitBareLinkWrite(tx1, sourceId, targetId, "legacyField");

        // tx2: RAISE the dial (raising below the pin is allowed) and add a
        // second such link write at ["field"].
        const tx2 = runtime.edit();
        tx2.setCfcLabelMetadataProtectionMode("enforce");
        await commitBareLinkWrite(tx2, sourceId, targetId, "field");

        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        const linkEntries = entries.filter((e) => e.origin === "link");
        // Old verbatim entry carried forward untouched (no envelope
        // rewrite of pre-Stage-1 forms)…
        const legacy = entryAt(linkEntries, ["legacyField"]);
        expect(legacy).toBeDefined();
        expect(legacy!.label.confidentiality).toContainEqual(userAtom);
        // …coexisting with the new committed link entry.
        const fresh = entryAt(linkEntries, ["field"]);
        expect(fresh).toBeDefined();
        expect(fresh!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
      } finally {
        await runtime.dispose();
      }
    });

    it("commits flow-derived entries whose join consumed a foreign labeled read", async () => {
      const { storageManager, runtime } = makeRuntime("enforce", {
        // `persist` is the rung that writes the flow join into the stored
        // label map. The assertions below read that `derived` entry.
        cfcFlowLabels: "persist",
      });
      try {
        await seedSource(runtime, spaceA, "flow-source");
        const tx = runtime.edit();
        const source = runtime.getCell(spaceA, "flow-source", undefined, tx);
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("classified");
        const derived = runtime.getCell<{ copied: string }>(
          spaceB,
          "flow-derived",
          joinStoreSchema as never,
          tx,
        );
        derived.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        expect((await tx.commit().settled).ok).toBeDefined();

        const derivedId = derived.getAsNormalizedFullLink().id;
        const entries = persistedEntriesFor(storageManager, spaceB, derivedId);
        const flowEntry = entries.find((e) =>
          e.origin === "derived" && e.observes === "value"
        );
        expect(flowEntry).toBeDefined();
        // The foreign User clause landed committed; Space-free plaintext
        // DIDs are gone.
        expect(flowEntry!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
        // The store's declaration is authored in this space and persists
        // as written. Filtering it out leaves the entries the cross-space
        // transform governs.
        expect(
          JSON.stringify(entries.filter((e) => e.origin !== "declared")),
        ).not.toContain("did:key:alice");
      } finally {
        await runtime.dispose();
      }
    });

    it("commits the runtime-owned-store declaration built from that same join", async () => {
      // The §8.12.5 route-2 declaration a store the runtime owns mints carries the
      // flow join as its content, so it is the one `declared` entry the
      // transform applies to. Leaving it verbatim beside the committed
      // derived stamp of the same atoms would publish in one entry what the
      // other protects.

      const { storageManager, runtime } = makeRuntime("enforce", {
        // `persist` is the rung that writes the flow join into the stored
        // label map. The declaration the assertions below read is minted
        // from that join.
        cfcFlowLabels: "persist",
      });
      try {
        await seedSource(runtime, spaceA, "substrate-source");
        const tx = runtime.edit();
        // Route 2 runs at a rung that rejects a writer-fit misfit. The
        // `declared` entry the assertions below read is minted there.
        tx.setCfcEnforcementMode("enforce-strict");
        const source = runtime.getCell(
          spaceA,
          "substrate-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const result = runtime.getCell(
          spaceB,
          "substrate-result",
          undefined,
          tx,
        );
        const substrate = runtime.getCell(spaceB, "substrate", undefined, tx);
        const resultLink = result.getAsNormalizedFullLink();
        const substrateLink = substrate.getAsNormalizedFullLink();
        tx.recordCfcWritePolicyInput({
          kind: "structural-provenance",
          target: {
            space: substrateLink.space,
            scope: substrateLink.scope,
            id: substrateLink.id,
            path: [],
          },
          claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
          sources: [{
            space: resultLink.space,
            scope: resultLink.scope,
            id: resultLink.id,
            path: [],
          }],
        }, runtimeWritePolicyAuthorization);
        substrate.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        expect((await tx.commit().settled).ok).toBeDefined();

        const entries = persistedEntriesFor(
          storageManager,
          spaceB,
          substrateLink.id,
        );
        const declared = entries.find((e) => e.origin === "declared");
        expect(declared).toBeDefined();
        expect(declared!.label.confidentiality).toContainEqual({
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue("did:key:alice"),
        });
        expect(JSON.stringify(entries)).not.toContain("did:key:alice");
      } finally {
        await runtime.dispose();
      }
    });

    it("persists same-space flow-derived entries verbatim", async () => {
      const { storageManager, runtime } = makeRuntime("enforce", {
        // `persist` is the rung that writes the flow join into the stored
        // label map. The assertions below read that `derived` entry.
        cfcFlowLabels: "persist",
      });
      try {
        // The source carries its own space clause beside the User clause.
        // Residency admits a space's own clause, and the store below
        // declares the other two.
        await seedSource(runtime, spaceB, "flow-same-source", [{
          type: CFC_ATOM_TYPE.Space,
          id: spaceB,
        }]);
        const tx = runtime.edit();
        const source = runtime.getCell(
          spaceB,
          "flow-same-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const derived = runtime.getCell<{ copied: string }>(
          spaceB,
          "flow-same-derived",
          joinStoreSchema as never,
          tx,
        );
        derived.set({ copied: `${raw.secret}!` });
        tx.prepareCfc();
        expect((await tx.commit().settled).ok).toBeDefined();

        const derivedId = derived.getAsNormalizedFullLink().id;
        const entries = persistedEntriesFor(storageManager, spaceB, derivedId);
        const flowEntry = entries.find((e) => e.origin === "derived");
        expect(flowEntry).toBeDefined();
        expect(flowEntry!.label.confidentiality).toContainEqual(userAtom);
        expect(containsCfcFieldCommitment(entries)).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("observe", () => {
    it("persists verbatim and emits the divergence diagnostic", async () => {
      const { storageManager, runtime } = makeRuntime("observe");
      try {
        const sourceId = await seedSource(runtime, spaceA, "observe-source");
        const { targetId, tx } = await commitLinkWrite(
          runtime,
          spaceA,
          sourceId,
          "observe-target",
        );
        const entries = persistedEntriesFor(storageManager, spaceB, targetId);
        // Verbatim bytes: the plaintext atoms persisted, no markers.
        expect(containsCfcFieldCommitment(entries)).toBe(false);
        const linkEntries = entries.filter((e) => e.origin === "link");
        expect(entryAt(linkEntries, ["field"])!.label.confidentiality)
          .toContainEqual(userAtom);
        // The rollout metric: a structured divergence diagnostic.
        expect(
          tx.getCfcState().diagnostics.some((d) =>
            d.includes("label-metadata-protection(observe)")
          ),
        ).toBe(true);
      } finally {
        await runtime.dispose();
      }
    });

    it("emits no diagnostic for a same-space write (no divergence)", async () => {
      const { runtime } = makeRuntime("observe");
      try {
        const sourceId = await seedSource(runtime, spaceB, "observe-same-src");
        const { tx } = await commitLinkWrite(
          runtime,
          spaceB,
          sourceId,
          "observe-same-target",
        );
        expect(
          tx.getCfcState().diagnostics.some((d) =>
            d.includes("label-metadata-protection(observe)")
          ),
        ).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("off", () => {
    it("persists the verbatim plaintext form", async () => {
      const offRun = makeRuntime("off");
      try {
        const sourceId = await seedSource(offRun.runtime, spaceA, "off-source");
        await commitLinkWrite(offRun.runtime, spaceA, sourceId, "off-target");
        const offTarget = parseLink(
          offRun.runtime.getCell(spaceB, "off-target").getAsLink(),
        ).id!;
        const offEntries = persistedEntriesFor(
          offRun.storageManager,
          spaceB,
          offTarget,
        );
        expect(offEntries.length).toBeGreaterThan(0);
        expect(containsCfcFieldCommitment(offEntries)).toBe(false);
        expect(JSON.stringify(offEntries)).toContain("did:key:alice");
      } finally {
        await offRun.runtime.dispose();
      }
    });
  });

  it("keeps Space.id plaintext in a committed cross-space entry (§4.9.3)", async () => {
    const { storageManager, runtime } = makeRuntime("enforce");
    try {
      const sourceId = await seedSource(runtime, spaceA, "space-atom-source");
      // A reference carrying a Space clause beside the User clause.
      const { targetId } = await commitLinkWrite(
        runtime,
        spaceA,
        sourceId,
        "space-atom-target",
        [{ type: CFC_ATOM_TYPE.Space, id: spaceA }, userAtom],
      );
      const entries = persistedEntriesFor(storageManager, spaceB, targetId);
      const rootEntry = entries.filter((e) => e.origin === "link").find((e) =>
        e.path.length === 1 && e.path[0] === "field"
      );
      expect(rootEntry).toBeDefined();
      // Space.id verbatim — the §4.9.3 ACL point query dereferences it —
      // while the User clause committed.
      expect(rootEntry!.label.confidentiality).toContainEqual({
        type: CFC_ATOM_TYPE.Space,
        id: spaceA,
      });
      expect(rootEntry!.label.confidentiality).toContainEqual({
        type: CFC_ATOM_TYPE.User,
        subject: { digestOf: hashStringOf("did:key:alice") },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("mints the local external-ingest mark verbatim (no cross-space observation feeds it)", async () => {
    const { storageManager, runtime } = makeRuntime("enforce");
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(spaceB, "ingest-target", undefined, tx);
      const targetId = target.getAsNormalizedFullLink().id;
      target.set({ inbox: ["hello"] });
      stampExternalIngest(tx, {
        target: {
          space: spaceB,
          scope: "space",
          id: targetId as never,
          path: [],
        },
        channel: "email",
        audience: "did:key:local-user",
        receivedAt: "2026-07-09T00:00:00Z",
        valueDigest: "digest",
      });
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      const entries = persistedEntriesFor(storageManager, spaceB, targetId);
      const mark = entries.find((e) => e.origin === "external-ingest");
      expect(mark).toBeDefined();
      const atom = mark!.label.integrity?.[0] as Record<string, unknown>;
      expect(atom.audience).toBe("did:key:local-user");
    } finally {
      await runtime.dispose();
    }
  });

  describe("legacy maxConfidentiality fit on committed labels (policy evaluation off)", () => {
    // The default `cfcPolicyEvaluation: "off"` decision path for schema
    // `maxConfidentiality` froze the pre-dial deepEqual membership check. A
    // consumed read whose stored label carries a COMMITTED clause must still
    // fit a plaintext ceiling naming the same principal (digest the
    // candidate and compare — same-form matching), and still reject a
    // ceiling naming someone else (codex/cubic P1 on this PR).
    const seedCommitted = async (runtime: Runtime, name: string) => {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(spaceB, name, undefined, seed).getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, spaceB);
      seedStoredEnvelope(seed, {
        space: spaceB,
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "classified" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [{
                  type: CFC_ATOM_TYPE.User,
                  subject: commitCfcFieldValue("did:key:alice"),
                }],
              },
            }],
          },
        },
      });
      expect((await seed.commit().settled).ok).toBeDefined();
    };

    const writeUnderCeiling = async (
      runtime: Runtime,
      sourceName: string,
      targetName: string,
      ceiling: unknown[],
    ) => {
      const tx = runtime.edit();
      const source = runtime.getCell(spaceB, sourceName, undefined, tx);
      expect((source.getRaw() as { secret?: string }).secret).toBe(
        "classified",
      );
      const targetSchema: JSONSchema = {
        type: "object",
        // The store declares the committed clause the consumed read
        // carries.
        ifc: {
          confidentiality: [{
            type: CFC_ATOM_TYPE.User,
            subject: commitCfcFieldValue("did:key:alice"),
          }],
        } as never,
        properties: {
          out: {
            type: "string",
            ifc: { maxConfidentiality: ceiling } as never,
          },
        },
        required: ["out"],
      };
      const target = runtime.getCell<{ out: string }>(
        spaceB,
        targetName,
        targetSchema as never,
        tx,
      );
      target.set({ out: "derived" });
      tx.prepareCfc();
      return await tx.commit().settled;
    };

    it("fits a committed User clause under a plaintext ceiling naming the same principal", async () => {
      const { runtime } = makeRuntime(undefined);
      try {
        await seedCommitted(runtime, "legacy-fit-source");
        const result = await writeUnderCeiling(
          runtime,
          "legacy-fit-source",
          "legacy-fit-target",
          [userAtom],
        );
        expect(result.ok).toBeDefined();
      } finally {
        await runtime.dispose();
      }
    });

    it("still rejects a committed clause under a ceiling naming another principal", async () => {
      const { runtime } = makeRuntime(undefined);
      try {
        await seedCommitted(runtime, "legacy-reject-source");
        const result = await writeUnderCeiling(
          runtime,
          "legacy-reject-source",
          "legacy-reject-target",
          [{ type: CFC_ATOM_TYPE.User, subject: "did:key:bob" }],
        );
        expect(result.error?.message).toContain("maxConfidentiality failed");
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("uses cfcAtom helpers consistently (guard against constant drift)", () => {
    // The seeded caveat matches the canonical helper output so the tests
    // above exercise the same shapes production mints.
    expect(cfcAtom.caveat("derived-from", fullSource as never)).toEqual(
      caveatAtom,
    );
  });
});
