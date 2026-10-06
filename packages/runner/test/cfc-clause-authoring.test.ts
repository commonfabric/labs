import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { isOrClause } from "../src/cfc/clause.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  CFC_LABEL_READ_FAILED_ATOM,
  cfcObservationFitsCeiling,
} from "../src/cfc/observation.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-clause-authoring");

// Epic A4 (docs/history/plans/cfc-future-work-implementation.md): authors may write
// disjunctive confidentiality clauses (`{anyOf:[…]}`) in schema
// `ifc.confidentiality`. Principal-like alternatives persist intact; Expires /
// Caveat alternatives are rejected fail-closed (spec §3.1.8).

const userA = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:alice",
};
const userB = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "did",
  subject: "did:key:bob",
};

describe("CFC authored disjunctive confidentiality", () => {
  it("persists a principal-like OR-clause intact", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [userB, userA] }] },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "authored-or", schema, tx);
      cell.set("participant-readable");
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();

      const readTx = runtime.edit();
      const metadata = readStoredCfcMetadata(readTx, {
        space: signer.did(),
        id: runtime.getCell(signer.did(), "authored-or", schema, readTx)
          .getAsNormalizedFullLink().id,
      });
      await readTx.commit().settled;

      const conf = (metadata?.labelMap.entries ?? []).flatMap(
        (entry) => entry.label.confidentiality ?? [],
      );
      const orClause = conf.find(isOrClause) as
        | { anyOf: unknown[] }
        | undefined;
      expect(orClause).toBeDefined();
      // The wire form is preserved (a clause-unaware reader sees one opaque
      // object, never a flattened atom list) and canonically ordered.
      expect(orClause!.anyOf).toHaveLength(2);
      expect(orClause!.anyOf).toContainEqual(userA);
      expect(orClause!.anyOf).toContainEqual(userB);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persisted clause read by a clause-UNAWARE flat reader is outside every ceiling (mixed-version fail-closed, design decision 1)", async () => {
    // The mixed-version story of design decision 1
    // (docs/history/plans/cfc-future-work-implementation.md, Epic A): a reader that
    // predates clause subsumption (#4470) deepEquals the WHOLE `{anyOf:[…]}`
    // object against each ceiling entry, so an authored clause can only ever
    // over-restrict on old readers — never leak. Confirmed end-to-end: schema
    // → committed labelMap → read-back label → flat fit.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [userB, userA] }] },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "mixed-version", schema, tx);
      cell.set("participant-readable");
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();

      const readTx = runtime.edit();
      const metadata = readStoredCfcMetadata(readTx, {
        space: signer.did(),
        id: runtime.getCell(signer.did(), "mixed-version", schema, readTx)
          .getAsNormalizedFullLink().id,
      });
      await readTx.commit().settled;

      const label = (metadata?.labelMap.entries ?? []).flatMap(
        (entry) => entry.label.confidentiality ?? [],
      );
      const clause = label.find(isOrClause)!;
      expect(clause).toBeDefined();

      // Faithful local reimplementation of the PRE-A2 fit — atomsOutsideCeiling
      // as of #4055, before #4470 rewrote it to clause subsumption: plain
      // deepEqual set-membership plus the ungrantable read-failed marker, no
      // clause awareness.
      const flatAtomsOutsideCeiling = (
        confidentiality: readonly unknown[],
        ceiling: readonly unknown[],
      ): unknown[] =>
        confidentiality.filter((value) =>
          deepEqual(value, CFC_LABEL_READ_FAILED_ATOM) ||
          !ceiling.some((allowed) => deepEqual(allowed, value))
        );

      // Ceilings naming each alternative — alone, together, and among
      // unrelated atoms. The flat reader compares the whole clause object to
      // each entry, so none admits it: fit fails everywhere.
      const ceilings: (readonly unknown[])[] = [
        [], // declared public-only
        [userA],
        [userB],
        [userA, userB], // names every alternative — still not the clause object
        [userA, userB, "did:key:carol"],
      ];
      for (const ceiling of ceilings) {
        const outside = flatAtomsOutsideCeiling(label, ceiling);
        expect(outside).toContainEqual(clause);
        expect(flatAtomsOutsideCeiling([clause], ceiling)).toHaveLength(1);
      }

      // Contrast: the CURRENT clause-aware fit admits the same read-back
      // clause at a flat ceiling naming one alternative (A2's weaker-clause
      // direction), and still rejects it at public-only. The flat reader is
      // strictly MORE restrictive than the clause-aware one — fail-closed by
      // construction, not by coincidence.
      expect(cfcObservationFitsCeiling([clause], [userA])).toBe(true);
      expect(cfcObservationFitsCeiling([clause], [])).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a flat atom alongside an OR-clause with a string alternative", async () => {
    // Exercises the non-clause `continue` and non-record-alternative branches
    // of the boundary's authored-clause validator: a flat atom is skipped (not
    // an OR-clause), a string alternative is not a forbidden typed atom, and a
    // record alternative that is not Caveat/Expires passes — so the write
    // commits.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const schema = {
        type: "string",
        ifc: {
          confidentiality: [userA, { anyOf: ["did:key:carol", userB] }],
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "authored-mixed", schema, tx);
      cell.set("ok");
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a Caveat alternative fail-closed (spec §3.1.8)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const caveat = {
        type: "https://commonfabric.org/cfc/atom/Caveat",
        kind:
          "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
        source: userA,
      };
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [userA, caveat] }] },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "authored-caveat", schema, tx);
      cell.set("bad");
      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit().settled;
      expect(result.error?.message).toContain("OR-clause alternative");
      expect(result.error?.message).toContain("Caveat");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("schema-merge treats order-differing OR-clauses as equivalent (not a weakening)", () => {
    // Two schema inputs presenting the same clause with alternatives in a
    // different order must merge without a "cannot be weakened" reject — the
    // merge normalizes clauses before the subset check (Epic A4 review fix).
    const merged = mergeCfcSchemaEnvelopes(
      { type: "string", ifc: { confidentiality: [{ anyOf: [userA, userB] }] } },
      { type: "string", ifc: { confidentiality: [{ anyOf: [userB, userA] }] } },
    ) as JSONSchemaObj;
    const conf = (merged.ifc?.confidentiality ?? []) as unknown[];
    // Coalesces to ONE clause (not two order-variants, not a merged/unioned
    // superset clause).
    expect(conf).toHaveLength(1);
    expect(isOrClause(conf[0])).toBe(true);
    expect((conf[0] as { anyOf: unknown[] }).anyOf).toHaveLength(2);
  });

  it("schema-merge still rejects a genuinely narrower clause set as weakening", () => {
    // Dropping a conjunctive clause IS a weakening and must still reject.
    expect(() =>
      mergeCfcSchemaEnvelopes(
        {
          type: "string",
          ifc: { confidentiality: [{ anyOf: [userA, userB] }, userA] },
        },
        {
          type: "string",
          ifc: { confidentiality: [{ anyOf: [userB, userA] }] },
        },
      )
    ).toThrow("cannot be weakened");
  });

  it("rejects an Expires alternative fail-closed", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const expires = {
        type: "https://commonfabric.org/cfc/atom/Expires",
        timestamp: 1781000000,
      };
      const schema = {
        type: "string",
        ifc: { confidentiality: [{ anyOf: [userA, expires] }] },
      } as const satisfies JSONSchema;

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "authored-expires",
        schema,
        tx,
      );
      cell.set("bad");
      expect(tx.prepareCfc()).toBe("");
      const result = await tx.commit().settled;
      expect(result.error?.message).toContain("OR-clause alternative");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
