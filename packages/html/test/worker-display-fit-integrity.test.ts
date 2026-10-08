/**
 * What the display boundary releases when a rendered value rests on an
 * endorsed output and on a secret nothing endorsed wrote. An exchange rule
 * releases the room clause on evidence that the tally wrote a value; read
 * through one access, the tally's count and Alice's note are fitted against
 * the evidence both of them carry between them.
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
  type DisplayFitSources,
  readRefusal,
  type RenderLabelSummary,
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
  // Under `off`, the display fit pools the integrity of every read behind a
  // rendered value, so the tally's `TransformedBy` releases the room clause on
  // Alice's note. Each such release is the behavior to remove; `enforce`
  // refuses it, and the controls show the note read on its own is refused.

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
    ).label.confidentiality ?? [];
  const divergences: RenderLabelSummary[] = [];
  const sourcesAt = (
    releaseGateIntegrity?: DisplayFitSources["releaseGateIntegrity"],
  ): DisplayFitSources => ({
    resolveConfidentiality,
    releaseGateIntegrity,
    noteReleaseGateDivergence: (refusal) => divergences.push(refusal),
  });
  const sources = sourcesAt();

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
          entries: entries.map(({ path, integrity }) => ({
            path,
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
      "admits a value read across an endorsed output and a secret",
      () => {
        const read = readProjected(view, hostValueOf);
        expect(JSON.stringify(read.value)).toContain("alice-secret");
        expect(read.consumed.confidentiality).toContainEqual(room);
        expect(readRefusal(view, [read.consumed], PUBLIC_ONLY, sources))
          .toBeUndefined();
      },
    );

    await t.step(
      "admits a secret decided together with a separate read of an endorsed output",
      () => {
        const reads = [
          readProjected(ballot, hostValueOf).consumed,
          readProjected(note, hostValueOf).consumed,
        ];
        expect(readRefusal(view, reads, PUBLIC_ONLY, sources)).toBeUndefined();
      },
    );

    await t.step("refuses the secret read on its own", () => {
      const read = readProjected(note, hostValueOf);
      expect(readRefusal(view, [read.consumed], PUBLIC_ONLY, sources))
        .toMatchObject({ labelSource: "consumed" });
    });

    // A stored label whose root carries the tally's evidence and whose `/b`
    // carries the room clause on its own. How a store comes to hold it is
    // the writers' business; the fit decides on what the label says.
    const mixed = await seedEntries(
      "mixed",
      { a: "1", b: "alice-secret" },
      [{ path: [], integrity: [TALLY] }, { path: ["b"] }],
    );

    await t.step(
      "admits a stored label whose root evidence vouches for a child's clause",
      () => {
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

    await t.step(
      "observe: admits a value read across an endorsed output and a secret, and reports the join's refusal",
      () => {
        divergences.length = 0;
        const read = readProjected(view, hostValueOf);
        expect(
          readRefusal(view, [read.consumed], PUBLIC_ONLY, sourcesAt("observe")),
        ).toBeUndefined();
        expect(divergences).toEqual([{
          labelSource: "consumed",
          confidentiality: [room],
          integrity: [],
        }]);
      },
    );

    await t.step(
      "observe: reports nothing for the endorsed output read on its own",
      () => {
        divergences.length = 0;
        const read = readProjected(ballot, hostValueOf);
        expect(
          readRefusal(
            ballot,
            [read.consumed],
            PUBLIC_ONLY,
            sourcesAt("observe"),
          ),
        ).toBeUndefined();
        expect(divergences).toEqual([]);
      },
    );

    await t.step(
      "enforce: refuses a value read across an endorsed output and a secret",
      () => {
        const read = readProjected(view, hostValueOf);
        expect(
          readRefusal(view, [read.consumed], PUBLIC_ONLY, sourcesAt("enforce")),
        ).toMatchObject({ labelSource: "consumed" });
      },
    );

    await t.step(
      "enforce: refuses a secret decided together with a separate read of an endorsed output",
      () => {
        const reads = [
          readProjected(ballot, hostValueOf).consumed,
          readProjected(note, hostValueOf).consumed,
        ];
        expect(readRefusal(view, reads, PUBLIC_ONLY, sourcesAt("enforce")))
          .toMatchObject({ labelSource: "consumed" });
      },
    );

    await t.step("enforce: admits the endorsed output read on its own", () => {
      const read = readProjected(ballot, hostValueOf);
      expect(
        readRefusal(ballot, [read.consumed], PUBLIC_ONLY, sourcesAt("enforce")),
      ).toBeUndefined();
    });

    await t.step(
      "enforce: refuses a stored label whose root evidence vouches for a child's clause",
      () => {
        expect(
          cellLabelRefusal(
            mixed,
            cellLabelSources(mixed),
            PUBLIC_ONLY,
            sourcesAt("enforce"),
          ),
        ).toMatchObject({ labelSource: "stored" });
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
