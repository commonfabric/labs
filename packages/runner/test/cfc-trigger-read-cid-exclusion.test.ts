import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-trigger-cid");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
  origin?: string;
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
};

describe("CFC trigger reads: cid: exclusion", () => {
  it("keeps cid: trigger reads out of the flow derivation even when they bypass ingest filtering", async () => {
    // §8.9.2 trigger reads name runtime-surface documents only by accident or
    // forgery: `addCfcTriggerReads` drops them at ingest (`flowReadExcluded` on
    // the raw notification path), and `forEachFlowObservation` keeps an
    // id-based `cid:` skip as defense in depth for entries that arrive by other
    // construction paths. That second layer matters because `cid:` schema docs
    // live on an unverified write path any same-space writer can reach (audit
    // S5): a poisoned labelMap on one must not join the flow derivation through
    // a smuggled trigger entry.

    const storageManager = StorageManager.emulate({ as: signer });
    // The legitimate source's confidentiality names this space's
    // readers, the audience of everything the space stores. A write
    // carrying it fits the out doc's write ceiling, so the out doc
    // declares no policy of its own and the join reaches its label
    // map as a `derived` entry.
    const sourceAtom = cfcAtom.space(signer.did());
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Persisting flow labels is what stamps the `derived` entry
      // this test reads back off the out doc.
      cfcFlowLabels: "persist",
    });
    try {
      // A legitimately labeled user doc — its trigger read SHOULD join, which
      // proves the derivation machinery ran (the cid: assertion below is not
      // vacuously green).
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-trigger-cid-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
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
              label: { confidentiality: [sourceAtom] },
            }],
          },
        },
      });
      // A cid: doc carrying a labelMap — the commit boundary verifies its
      // VALUE against its id, never its envelope, so its label is
      // attacker-controlled and must stay out of flow joins.
      const poisoned = { secret: "poisoned" };
      const cidId = `cid:${taggedHashStringOf(poisoned)}` as typeof sourceId;
      seedStoredEnvelope(seed, {
        space: signer.did(),
        scope: "space",
        id: cidId,
        path: [],
      }, {
        value: poisoned,
        cfc: {
          version: 1,
          schemaHash: "poison-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["cid-secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      // Ingest layer: `addCfcTriggerReads` drops the cid: address, keeps the
      // user doc's.
      tx.addCfcTriggerReads([
        {
          space: signer.did(),
          id: sourceId,
          type: "application/json",
          path: ["value", "secret"],
        },
        {
          space: signer.did(),
          id: cidId,
          type: "application/json",
          path: ["value", "secret"],
        },
      ]);
      expect(tx.getCfcState().triggerReads.length).toBe(1);
      expect(tx.getCfcState().triggerReads[0].id).toBe(sourceId);

      // Derivation layer: the state itself is sealed (getCfcState() is a
      // read-only view, #4517), so smuggling by mutating it now throws —
      // that seals the external construction path this test used to
      // simulate.
      expect(() => {
        (tx.getCfcState().triggerReads as unknown as unknown[]).push({
          space: signer.did(),
          id: cidId,
          scope: "space",
          path: ["secret"],
        });
      }).toThrow("read-only");
      // The guard still matters for INTERNAL construction paths that might
      // bypass the ingest filter, so exercise it directly: hand
      // deriveFlowJoin a state carrying the smuggled canonical entry via a
      // delegating wrapper tx (methods bound to the real tx so its
      // ES-private state keeps working).
      const smuggledState = {
        ...tx.getCfcState(),
        triggerReads: [
          ...tx.getCfcState().triggerReads,
          {
            space: signer.did(),
            id: cidId,
            scope: "space",
            path: ["secret"],
          },
        ],
      };
      const smuggledTx = new Proxy(tx, {
        get(target, prop) {
          if (prop === "getCfcState") return () => smuggledState;
          const member = Reflect.get(target, prop, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      }) as IExtendedStorageTransaction;
      const join = deriveFlowJoin(smuggledTx);
      // The legitimate trigger's label joins; the poisoned cid: one is
      // skipped by the derivation-side guard.
      expect(join.confidentiality).toContainEqual(sourceAtom);
      expect(join.confidentiality).not.toContainEqual("cid-secret");

      // The transaction reads nothing — only the triggers connect it to the
      // labeled docs.
      const out = runtime.getCell(
        signer.did(),
        "cfc-trigger-cid-out",
        undefined,
        tx,
      );
      out.set({ flag: 1 });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const outId = out.getAsNormalizedFullLink().id;
      const entries = replicaEntries(storageManager, outId);
      const derived = entries.find((e) => e.origin === "derived");
      // The legitimate trigger joined…
      expect(derived).toBeDefined();
      expect(derived!.label.confidentiality).toContainEqual(
        sourceAtom,
      );
      // …the poisoned cid: trigger did not — on ANY entry of the out doc.
      for (const entry of entries) {
        expect(entry.label.confidentiality ?? []).not.toContainEqual(
          "cid-secret",
        );
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
