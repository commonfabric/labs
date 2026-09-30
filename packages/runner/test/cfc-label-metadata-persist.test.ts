import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-label-metadata");

describe("CFC persist-seam link-label re-derivation (inv-12 Stage 0)", () => {
  // Inv-12 Stage 0 (SC-14/SC-25 prerequisite; docs/specs/
  // cfc-label-metadata-confidentiality.md §3): the carried `cfcLabelView` on a
  // link write round-trips through the main thread (worker →
  // `CellHandle.deserialize` → `mapCellRefsToSigilLinks` → worker) and is
  // main-thread-influenceable. `prepareBoundaryCommit` must therefore treat an
  // inbound view as an untrusted display artifact and persist link-origin
  // labels from the worker-authoritative source — the link source's STORED
  // label map — so a tampered/redacted/incomplete view cannot WEAKEN what the
  // stored metadata provides (the round-trip hazard confirmed on the labs#4622
  // review thread: response-side redaction would otherwise persist redacted,
  // under-labeled views on copy-forward writes).

  type PersistedEntry = {
    path: string[];
    origin?: string;
    label: {
      confidentiality?: unknown[];
      integrity?: Array<{ type?: string }>;
    };
  };

  const setup = async (
    additionalEntries: Array<{
      path: string[];
      label: { confidentiality: string[] };
    }> = [],
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    // Seed a source doc whose STORED cfc metadata is the authoritative label
    // state: a root clause plus a sub-path entry carrying a full Caveat (with
    // its `source` identity). Tests seed stored ["cfc"] metadata via an
    // ungated path-[] full-document write (the same shape hydration
    // delivers).
    const sourceId = parseLink(
      runtime.getCell(signer.did(), "cfc-rederive-source").getAsLink(),
    ).id!;
    const fullCaveat = cfcAtom.caveat("derived-from", "did:key:alice");
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, signer.did());
    seedStoredEnvelope(seed, {
      space: signer.did(),
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
            { path: [], label: { confidentiality: ["source-root"] } },
            { path: ["secret"], label: { confidentiality: [fullCaveat] } },
            ...additionalEntries,
          ],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();

    return { storageManager, runtime, sourceId, fullCaveat };
  };

  const persistedEntriesFor = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): PersistedEntry[] => {
    const replica = storageManager.open(signer.did()).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: PersistedEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const commitLinkWrite = async (
    runtime: Runtime,
    sourceId: string,
    cfcLabelView: {
      version: 1;
      entries: Array<
        { path: string[]; label: { confidentiality?: CfcConfClause[] } }
      >;
    },
  ) => {
    const tx = runtime.edit();
    const target = runtime.getCell(
      signer.did(),
      "cfc-rederive-target",
      undefined,
      tx,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    tx.markCfcRelevant("test");
    tx.writeValueOrThrow({
      space: signer.did(),
      scope: "space",
      id: targetId,
      path: ["field"],
    }, linkRefFrom({ space: signer.did(), id: sourceId, path: [] }));
    // The link-write policy input a round-tripped write records: the source
    // address is authoritative (derived from the sigil link itself), but the
    // carried view is whatever the main thread handed back.
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: {
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["field"],
      },
      source: {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      },
      cfcLabelView,
    });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return parseLink(target.getAsLink()).id!;
  };

  it("persists the stored sub-path entry a tampered view dropped", async () => {
    const { storageManager, runtime, sourceId, fullCaveat } = await setup();
    try {
      // Round-tripped view with the ["secret"] entry (its whole clause)
      // dropped — the weakening the inbound view must not be able to cause.
      const persistedId = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: ["source-root"] } },
        ],
      });

      const entries = persistedEntriesFor(storageManager, persistedId);
      const secretEntry = entries.find((entry) =>
        entry.path.join("/") === "field/secret" && entry.origin === "link"
      );
      // Re-derived from the source's stored label map, independent of the
      // carried view: the full caveat (with `source`) must be persisted.
      expect(secretEntry).toBeDefined();
      expect(secretEntry!.label.confidentiality).toContainEqual(fullCaveat);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("joins the authoritative covering label into carried sub-path entries (no shadow weakening)", async () => {
    const { storageManager, runtime, sourceId } = await setup();
    try {
      // The shadow attack: the source's AUTHORITATIVE label state has only
      // the root entry (confidentiality ["source-root"] — see setup) above
      // the crafted path. A tampered carried view pushes a MORE SPECIFIC
      // entry at a path the stored metadata does not cover, with weaker
      // confidentiality. Under the per-component longest-prefix read
      // resolution the specific entry REPLACES the root for reads at/below
      // it, so without the authoritative join the crafted entry would
      // weaken ["field","crafted"] reads from ["source-root"] to ["weak"].
      const persistedId = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [
          { path: ["crafted"], label: { confidentiality: ["weak"] } },
        ],
      });

      const entries = persistedEntriesFor(storageManager, persistedId);
      const craftedEntry = entries.find((entry) =>
        entry.path.join("/") === "field/crafted" && entry.origin === "link"
      );
      expect(craftedEntry).toBeDefined();
      // The carried atom may ADD…
      expect(craftedEntry!.label.confidentiality).toContainEqual("weak");
      // …but the authoritative covering confidentiality rides along, so the
      // more-specific entry is at least as restrictive as what it shadows.
      expect(craftedEntry!.label.confidentiality).toContainEqual(
        "source-root",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  for (const segment of ["0", "*"]) {
    it(`joins every deepest authoritative cover for a ${segment} carried path`, async () => {
      const { storageManager, runtime, sourceId } = await setup([
        { path: ["rows"], label: { confidentiality: ["ancestor"] } },
        { path: ["rows", "0"], label: { confidentiality: ["exact"] } },
        { path: ["rows", "*"], label: { confidentiality: ["template"] } },
        { path: ["rows", "0"], label: { confidentiality: ["duplicate"] } },
        {
          path: ["rows", "0", "child", "deeper"],
          label: { confidentiality: ["descendant"] },
        },
      ]);
      try {
        const persistedId = await commitLinkWrite(runtime, sourceId, {
          version: 1,
          entries: [{
            path: ["rows", segment, "child"],
            label: { confidentiality: ["carried"] },
          }],
        });
        const persisted = persistedEntriesFor(storageManager, persistedId)
          .find((entry) =>
            entry.origin === "link" &&
            entry.path.join("/") === `field/rows/${segment}/child`
          );
        expect(persisted).toBeDefined();
        expect(persisted!.label.confidentiality).toEqual([
          "template",
          "exact",
          "duplicate",
          "carried",
        ]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }

  it("retains every deepest cover when trailing templates share many label parts", async () => {
    const atoms = Array.from({ length: 40 }, (_, i) => `source-${i}`);
    const { storageManager, runtime, sourceId } = await setup([
      { path: ["rows"], label: { confidentiality: ["ancestor"] } },
      ...atoms.map((atom) => ({
        path: ["rows", "*"],
        label: { confidentiality: [atom] },
      })),
      {
        path: ["rows", "0", "deep"],
        label: { confidentiality: ["descendant"] },
      },
    ]);
    try {
      const persistedId = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [{
          path: ["rows", "*"],
          label: { confidentiality: ["carried"] },
        }],
      });
      const template = persistedEntriesFor(storageManager, persistedId).find((
        entry,
      ) => entry.origin === "link" && entry.path.join("/") === "field/rows/*");
      expect(template?.label.confidentiality).toEqual([...atoms, "carried"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the full caveat when the view carries a redacted copy", async () => {
    const { storageManager, runtime, sourceId, fullCaveat } = await setup();
    try {
      // Round-tripped view whose caveat lost its `source` — exactly what a
      // display-redacted view (redactCaveatSourcesForDisplay) looks like
      // after a main-thread round trip.
      const redactedCaveat = {
        type: CFC_ATOM_TYPE.Caveat,
        kind: "derived-from",
      };
      const persistedId = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: ["source-root"] } },
          { path: ["secret"], label: { confidentiality: [redactedCaveat] } },
        ],
      });

      const entries = persistedEntriesFor(storageManager, persistedId);
      const secretEntries = entries.filter((entry) =>
        entry.path.join("/") === "field/secret" && entry.origin === "link"
      );
      const atoms = secretEntries.flatMap((entry) =>
        entry.label.confidentiality ?? []
      );
      // The authoritative stored atom wins outright: the persisted entry
      // carries the caveat WITH its source, no matter what the view dropped.
      expect(atoms).toContainEqual(fullCaveat);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps re-derived link labels under the runtime-evidence mint gate", async () => {
    // The re-derived entries take the same gate as carried ones (audit S4):
    // a non-builtin link write must not re-mint runtime evidence atoms at
    // the target, even when they come from the source's stored metadata.
    // And when the gate EMPTIES an integrity-only entry, no entry may be
    // pushed at all: an empty origin:"link" entry at a more-specific path
    // would SHADOW an ancestor link-origin confidentiality entry under the
    // per-component longest-prefix read resolution (cubic review on this
    // PR) — an under-labeling introduced by the very loop meant to prevent
    // weakening.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const sourceId = parseLink(
        runtime.getCell(signer.did(), "cfc-rederive-evidence-source")
          .getAsLink(),
      ).id!;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { attested: "x" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              // The root confidentiality an empty deeper entry would shadow.
              path: [],
              label: { confidentiality: ["source-root"] },
            }, {
              // Integrity-only: the mint gate empties it for this
              // non-builtin write.
              path: ["attested"],
              label: {
                integrity: [{ type: CFC_ATOM_TYPE.InjectionSafe }],
              },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-rederive-evidence-target",
        undefined,
        tx,
      );
      const targetId = target.getAsNormalizedFullLink().id;
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["field"],
      }, linkRefFrom({ space: signer.did(), id: sourceId, path: [] }));
      tx.recordCfcWritePolicyInput({
        kind: "link-write",
        target: {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["field"],
        },
        source: {
          space: signer.did(),
          scope: "space",
          id: sourceId,
          path: [],
        },
      });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(target.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: unknown[];
                  integrity?: Array<{ type?: string }>;
                };
              }>;
            };
          };
        } | undefined;
      };
      const entries =
        replica.getDocument(persistedId)?.cfc?.labelMap?.entries ?? [];
      // The re-derived link entry is there, carrying the source label, so the
      // integrity check below runs over a label map that was written.
      expect(entries.map((e) => e.path)).toEqual([["field"]]);
      expect(entries[0].label.confidentiality).toEqual(["source-root"]);
      const allIntegrity = entries.flatMap((e) => e.label.integrity ?? []);
      expect(
        allIntegrity.some((a) => a?.type?.endsWith("/InjectionSafe")),
      ).toBe(false);
      // The gate emptied the ["attested"] entry — nothing may persist there:
      // every persisted entry still carries label values.
      for (const entry of entries) {
        expect(
          (entry.label.confidentiality?.length ?? 0) > 0 ||
            (entry.label.integrity?.length ?? 0) > 0,
        ).toBe(true);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
