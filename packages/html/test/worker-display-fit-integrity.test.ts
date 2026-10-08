/**
 * What the display boundary releases when a rendered value rests on an
 * endorsed output and on a secret nothing endorsed wrote. An exchange rule
 * releases the room clause on evidence that the tally wrote a value; it runs
 * at each location the reads behind the value consumed, so the tally's count
 * is released and Alice's note beside it is not.
 *
 * `Deno.test` rather than `describe`/`it`: this package installs its fake
 * clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
 * a `@std/testing/bdd` `it()` callback never receives that context.
 */

import { expect } from "@std/expect";

import { CFC_ATOM_TYPE, type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  hostValueOf,
  KeepAsCell,
  readProjected,
  Runtime,
} from "@commonfabric/runner";
import {
  buildCfcPolicySnapshot,
  evaluateExchangeRules,
  isValueIntrinsicExchangeRule,
  type RenderConfidentialityResolver,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import {
  cellLabelRefusal,
  cellLabelSources,
  readRefusal,
} from "../src/worker/display-fit.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

const TALLY = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: {
    kind: "verified",
    moduleIdentity: "module:conclave",
    symbol: "tallyBallot",
  },
};

/** The public-only ceiling a viewer outside the room renders under. */
const PUBLIC_ONLY: RenderPolicy = {
  declassifyConfidentiality: [],
  maxConfidentiality: [],
};

Deno.test("display fit release-gate integrity", async (t) => {
  const signer = await Identity.fromPassphrase("display fit integrity");
  const space = signer.did();
  const room = cfcAtom.space(space);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });

  // The rule a module policy would carry: the tally's output leaves the room.
  const snapshot = buildCfcPolicySnapshot([{
    id: "conclave-release",
    rules: [{
      id: "release-ballot",
      appliesTo: room,
      preCondition: { integrity: [TALLY] },
      post: { dropClause: true },
    }],
  }]);
  const resolveConfidentiality: RenderConfidentialityResolver = (label) =>
    evaluateExchangeRules(
      {
        confidentiality: [...label.confidentiality],
        integrity: [...(label.integrity ?? [])],
      },
      snapshot,
      label.valueIntrinsicOnly === true
        ? { admitsRule: isValueIntrinsicExchangeRule }
        : {},
    ).label.confidentiality ?? [];
  const sources = { resolveConfidentiality };

  /** Stores `value` as the document `cause`, with `entries` as its label map. */
  const seedEntries = async (
    cause: string,
    value: string | Record<string, string>,
    entries: readonly {
      path: string[];
      integrity?: readonly CfcAtom[];
    }[],
  ): Promise<Cell<unknown>> => {
    const cell = runtime.getCell(space, cause);
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          // Each entry is a flow stamp, as a write under the tally stores one.
          entries: entries.map(({ path, integrity }) => ({
            path,
            origin: "derived" as const,
            observes: "value" as const,
            label: {
              confidentiality: [room],
              integrity: [...(integrity ?? [])],
            },
          })),
        },
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    return cell;
  };

  /** Stores `value` as the document `cause`, labeled with the room and `integrity`. */
  const seed = (
    cause: string,
    value: string,
    integrity: readonly CfcAtom[] = [],
  ): Promise<Cell<unknown>> =>
    seedEntries(cause, value, [{ path: [], integrity }]);

  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  try {
    const ballot = await seed("ballot", "1", [TALLY]);
    const note = await seed("alice-note", "alice-secret");

    // A public record linking to both, as a view would hold them.
    const record = runtime.getCell(space, "record");
    const tx = runtime.edit();
    record.withTx(tx).setRawUntyped({
      count: link(ballot),
      note: link(note),
    } as never);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    const view = record.asSchema({
      type: "object",
      properties: { count: {}, note: {} },
    });

    await t.step(
      "refuses a value read across an endorsed output and a secret",
      () => {
        const read = readProjected(view, hostValueOf);
        expect(JSON.stringify(read.value)).toContain("alice-secret");
        expect(readRefusal(view, [read.consumed], PUBLIC_ONLY, sources))
          .toMatchObject({ labelSource: "consumed" });
      },
    );

    await t.step(
      "refuses a secret decided together with a separate read of an endorsed output",
      () => {
        const reads = [
          readProjected(ballot, hostValueOf).consumed,
          readProjected(note, hostValueOf).consumed,
        ];
        expect(readRefusal(view, reads, PUBLIC_ONLY, sources))
          .toMatchObject({ labelSource: "consumed" });
      },
    );

    await t.step("refuses the secret read on its own", () => {
      const read = readProjected(note, hostValueOf);
      expect(readRefusal(view, [read.consumed], PUBLIC_ONLY, sources))
        .toMatchObject({ labelSource: "consumed" });
    });

    await t.step("admits the endorsed output read on its own", () => {
      const read = readProjected(ballot, hostValueOf);
      expect(readRefusal(ballot, [read.consumed], PUBLIC_ONLY, sources))
        .toBeUndefined();
    });

    const second = await seed("ballot-2", "2", [TALLY]);

    await t.step("admits two endorsed outputs decided together", () => {
      const reads = [
        readProjected(ballot, hostValueOf).consumed,
        readProjected(second, hostValueOf).consumed,
      ];
      expect(readRefusal(view, reads, PUBLIC_ONLY, sources)).toBeUndefined();
    });

    // A stored label whose root carries the tally's evidence and whose `/b`
    // carries the room clause on its own.
    const mixed = await seedEntries(
      "mixed",
      { a: "1", b: "alice-secret" },
      [{ path: [], integrity: [TALLY] }, { path: ["b"] }],
    );

    await t.step(
      "admits a stored label whose root evidence vouches for a child's clause",
      () => {
        // A label view carries no origin and folds an ancestor's entry in
        // beside a narrower cell's own, so a cell's stored label is fitted on
        // its root's integrity. The reads behind a rendered value are what
        // the boundary decides location by location.

        expect(
          cellLabelRefusal(
            mixed,
            cellLabelSources(mixed),
            PUBLIC_ONLY,
            sources,
          ),
        ).toBeUndefined();
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
