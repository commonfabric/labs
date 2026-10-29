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
import { labelsReached } from "./support/reached-labels.ts";
import type { CfcLabelView } from "../src/cfc/label-view.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-label-metadata");

describe("cfc-label-metadata-persist", () => {
  // The carried `cfcLabelView` on a link write round-trips through the main
  // thread (worker → `CellHandle.deserialize` → `mapCellRefsToSigilLinks` →
  // worker), so the persist seam treats it as an untrusted artifact. What a
  // link slot persists is the reference's own label (CFC §8.2.3, §8.12.8):
  // the view's root entry is the restriction under which the handle was
  // acquired and joins the slot's entry; below its root the view describes
  // positions of the target, which the target labels itself, and nothing of
  // it is persisted. A read through the link composes the slot's restriction
  // with the labels the target stores (§8.2.4), so a view that drops or
  // redacts what the target holds weakens nothing.

  type PersistedEntry = {
    path: string[];
    origin?: string;
    label: {
      confidentiality?: unknown[];
      integrity?: Array<{ type?: string }>;
    };
  };

  type CarriedView = CfcLabelView;

  const setup = async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    // A source whose stored metadata holds a root clause and a sub-path
    // entry carrying a full Caveat, `source` identity included, seeded by an
    // ungated path-[] full-document write (the shape hydration delivers).
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
          ],
        },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();

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

  // Links `sourceId` into a fresh target at `field`, recording the link-write
  // policy input a round-tripped write records: the source address is what
  // the sigil link itself says, and the carried view is whatever the main
  // thread handed back. Answers the target's document id and its link.
  const commitLinkWrite = async (
    runtime: Runtime,
    sourceId: string,
    cfcLabelView?: CarriedView,
  ) => {
    const tx = runtime.edit();
    const target = runtime.getCell(
      signer.did(),
      "cfc-rederive-target",
      undefined,
      tx,
    );
    const targetLink = target.getAsNormalizedFullLink();
    tx.markCfcRelevant("test");
    tx.writeValueOrThrow({
      space: signer.did(),
      scope: "space",
      id: targetLink.id,
      path: ["field"],
    }, linkRefFrom({ space: signer.did(), id: sourceId, path: [] }));
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: {
        space: signer.did(),
        scope: "space",
        id: targetLink.id,
        path: ["field"],
      },
      source: {
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      },
      ...(cfcLabelView === undefined ? {} : { cfcLabelView }),
    });
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    return { targetId: parseLink(target.getAsLink()).id!, targetLink };
  };

  const linkEntries = (entries: PersistedEntry[]): PersistedEntry[] =>
    entries.filter((entry) => entry.origin === "link");

  it("persists the restriction a carried view holds at its root", async () => {
    const { storageManager, runtime, sourceId } = await setup();
    try {
      const { targetId } = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [{ path: [], label: { confidentiality: ["acquired"] } }],
      });

      const entries = linkEntries(
        persistedEntriesFor(storageManager, targetId),
      );
      expect(entries.map((entry) => entry.path)).toEqual([["field"]]);
      expect(entries[0].label.confidentiality).toEqual(["acquired"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists nothing a carried view holds below its root", async () => {
    const { storageManager, runtime, sourceId } = await setup();
    try {
      const { targetId } = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [
          { path: ["crafted"], label: { confidentiality: ["weak"] } },
          { path: ["rows", "*"], label: { confidentiality: ["template"] } },
          { path: ["rows", "0"], label: { confidentiality: ["exact"] } },
        ],
      });

      expect(persistedEntriesFor(storageManager, targetId)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists none of the source's labels at the slot", async () => {
    const { storageManager, runtime, sourceId } = await setup();
    try {
      const { targetId } = await commitLinkWrite(runtime, sourceId);

      expect(persistedEntriesFor(storageManager, targetId)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  for (
    const [shape, view] of [
      ["drops", {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: ["source-root"] } },
        ],
      }],
      ["redacts", {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: ["source-root"] } },
          {
            path: ["secret"],
            label: {
              confidentiality: [{
                type: CFC_ATOM_TYPE.Caveat,
                kind: "derived-from",
              }],
            },
          },
        ],
      }],
    ] as const satisfies readonly [string, CarriedView][]
  ) {
    it(`reaches the full stored sub-path label through a link whose view ${shape} it`, async () => {
      // A display-redacted view (`redactCaveatSourcesForDisplay`) loses the
      // caveat's `source` on its way back through the main thread; a
      // tampered one loses the entry. Neither reaches the target's stored
      // label, which is what a read through the link consults.

      const { storageManager, runtime, sourceId, fullCaveat } = await setup();
      try {
        const { targetId, targetLink } = await commitLinkWrite(
          runtime,
          sourceId,
          view,
        );

        const entries = persistedEntriesFor(storageManager, targetId);
        expect(entries.map((entry) => entry.path)).toEqual([["field"]]);
        expect(JSON.stringify(entries)).not.toContain("derived-from");
        const reached = labelsReached(runtime, targetLink, ["field", "secret"]);
        expect(reached.confidentiality).toContainEqual(fullCaveat);
        expect(reached.confidentiality).toContain("source-root");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }

  it("keeps runtime-minted integrity in a carried view under the mint gate", async () => {
    // A non-builtin link write cannot mint runtime evidence at the slot,
    // whatever its view carries. The gate leaves a view whose root holds
    // only such an atom with nothing, and nothing is what the slot persists:
    // the runtime's own endorsement of the reference never makes an entry
    // by itself.

    const { storageManager, runtime, sourceId } = await setup();
    try {
      const injectionSafe = { type: CFC_ATOM_TYPE.InjectionSafe };
      const { targetId } = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [{ path: [], label: { integrity: [injectionSafe] } }],
      });
      expect(persistedEntriesFor(storageManager, targetId)).toEqual([]);

      const { targetId: labeledId } = await commitLinkWrite(runtime, sourceId, {
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: ["acquired"],
            integrity: [injectionSafe],
          },
        }],
      });
      const entries = linkEntries(
        persistedEntriesFor(storageManager, labeledId),
      );
      expect(entries.map((entry) => entry.path)).toEqual([["field"]]);
      expect(entries[0].label.confidentiality).toEqual(["acquired"]);
      expect(
        (entries[0].label.integrity ?? []).some((atom) =>
          atom.type === CFC_ATOM_TYPE.InjectionSafe
        ),
      ).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
