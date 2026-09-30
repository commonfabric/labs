import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { URI } from "@commonfabric/memory/interface";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { Cell } from "../src/cell.ts";
import type { InspectConfLabelResult } from "../src/cfc/label-introspection.ts";
import {
  cfcLabelViewForCell,
  redactCaveatSourcesForDisplay,
} from "../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-inspect-conf-label-builtin",
);
const space = signer.did();

// Inv-12 Stage 2: the pattern-facing `inspectConfLabel` builtin — the ONLY
// application surface for label-metadata introspection (spec §4.6.4.1). End to
// end: result labeling through the flow derivation, the fail-closed flow-off
// degradation, and the untouched display path.

const SOURCE_A = { space: "did:key:remote-a", id: "of:origin-a", path: [] };

const caveatAtom = {
  type: CFC_ATOM_TYPE.Caveat,
  kind: "prompt-influence",
  source: SOURCE_A,
};

const seedLabeledDoc = async (
  runtime: Runtime,
  cause: string,
  options: { origin?: "derived" | "declared" } = {},
): Promise<string> => {
  const seed = runtime.edit();
  const id = parseLink(
    runtime.getCell(
      space,
      cause,
      { type: "object", properties: { body: { type: "string" } } },
    ).getAsLink(),
  ).id!;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id: id as URI, path: [] }, {
    value: { body: "payload" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["body"],
          label: { confidentiality: ["secret", caveatAtom] },
          origin: options.origin ?? "derived",
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
  return id;
};

const waitForStatus = async (
  runtime: Runtime,
  result: Cell<any>,
): Promise<unknown> => {
  // The builtin's node runs only while something demands its output, so the
  // wait has to hold a standing observation of the result cell rather than
  // sample it. `waitForCellValue` sinks on the cell, and a sink subscribes as
  // a scheduler effect that reads the value — the liveness root that keeps the
  // node awake — for as long as the wait is outstanding.
  const value = await waitForCellValue<{ status?: string }>(
    runtime,
    result,
    (value) => value?.status !== undefined,
  );
  // Plain-JSON snapshot so exact toEqual comparisons see bytes, not a
  // live query proxy.
  return JSON.parse(JSON.stringify(value));
};

const storedConfidentialityOf = (
  runtime: Runtime,
  result: Cell<any>,
): unknown[] => {
  const rtx = runtime.edit();
  try {
    const link = result.withTx(rtx).resolveAsCell()
      .getAsNormalizedFullLink();
    const stored = readStoredCfcMetadata(rtx, {
      space: link.space,
      id: link.id,
    });
    return (stored?.labelMap.entries ?? []).flatMap((entry) =>
      entry.label.confidentiality ?? []
    );
  } finally {
    rtx.commit();
  }
};

const storedValueOf = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  runtime: Runtime,
  result: Cell<any>,
): unknown => {
  const rtx = runtime.edit();
  try {
    const link = result.withTx(rtx).resolveAsCell()
      .getAsNormalizedFullLink();
    return (storageManager.open(link.space).replica as unknown as {
      getDocument(id: string): { value?: unknown } | undefined;
    }).getDocument(link.id)?.value;
  } finally {
    rtx.commit();
  }
};

describe("inspectConfLabel builtin (inv-12 Stage 2)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];

  const boot = (cfcFlowLabels: "off" | "persist") => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels,
    });
    tx = runtime.edit();
    ({ commonfabric: builder } = createTrustedBuilder(runtime));
  };

  afterEach(async () => {
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  describe("with flow labels persisting (the carrying mode)", () => {
    beforeEach(() => boot("persist"));

    it("returns matching atoms and labels the result via the flow derivation", async () => {
      await seedLabeledDoc(runtime, "inspect-src");
      const source = runtime.getCell(space, "inspect-src", undefined, tx);

      const testPattern = builder.pattern<{ doc: unknown }>(({ doc }) =>
        builder.inspectConfLabel(doc, "/body", {
          atomType: CFC_ATOM_TYPE.Caveat,
        })
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { doc: source }, resultCell);
      // The blessed pre-commit chokepoint (what production runner paths call):
      // the builtin's initial run happens inside THIS tx, records the
      // metadata observation, and marks it CFC-relevant, which is what lets
      // the commit through.
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(
        runtime,
        result,
      ) as InspectConfLabelResult;
      await runtime.idle();

      expect(value.status).toBe("ok");
      if (value.status !== "ok") throw new Error("unreachable");
      expect(value.atoms).toHaveLength(1);
      expect(value.atoms[0]).toMatchObject({
        targetPath: "/body",
        clauseIndex: 1,
        alternativeIndex: 0,
        atomIndex: 0,
      });
      // The projection is the STORED atom verbatim — including the source
      // the display path redacts (introspection is the labeled channel).
      expect(value.atoms[0].atom).toEqual(caveatAtom);

      // The result's persisted label carries the consumed metadata
      // observation: result label ⊇ the population-rule label (the derived
      // entry's own confidentiality — the §4.6.4.2 interim fallback).
      const confidentiality = storedConfidentialityOf(runtime, result);
      expect(confidentiality).toContainEqual("secret");
    });

    it("joins query-input confidentiality into the result label", async () => {
      await seedLabeledDoc(runtime, "inspect-src-qi");
      // The query's atomType arrives through a doc labeled "query-secret":
      // reading it is an ordinary consumed read, so the flow join — and with
      // it the result label — carries the query-input confidentiality.
      const seed = runtime.edit();
      const queryTypeId = parseLink(
        runtime.getCell(space, "inspect-query-type", { type: "string" })
          .getAsLink(),
      ).id!;
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        space,
        scope: "space",
        id: queryTypeId as URI,
        path: [],
      }, {
        value: CFC_ATOM_TYPE.Caveat,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: ["query-secret"] },
              origin: "derived",
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const source = runtime.getCell(space, "inspect-src-qi", undefined, tx);
      const queryType = runtime.getCell<string>(
        space,
        "inspect-query-type",
        undefined,
        tx,
      );

      const testPattern = builder.pattern<{ doc: unknown; atomType: string }>(
        ({ doc, atomType }) =>
          builder.inspectConfLabel(doc, "/body", { atomType }),
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result-qi",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { doc: source, atomType: queryType },
        resultCell,
      );
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(
        runtime,
        result,
      ) as InspectConfLabelResult;
      await runtime.idle();
      expect(value.status).toBe("ok");

      const confidentiality = storedConfidentialityOf(runtime, result);
      expect(confidentiality).toContainEqual("secret");
      expect(confidentiality).toContainEqual("query-secret");
    });

    it("normalizes hidden outcomes end to end", async () => {
      // Missing metadata (a doc with no cfc envelope at all).
      const bare = runtime.edit();
      const bareId = parseLink(
        runtime.getCell(space, "inspect-bare", { type: "object" }).getAsLink(),
      ).id!;
      bare.writeOrThrow(
        { space, scope: "space", id: bareId as URI, path: [] },
        { value: { body: "plain" } },
      );
      expect((await bare.commit()).ok).toBeDefined();

      const source = runtime.getCell(space, "inspect-bare", undefined, tx);
      const testPattern = builder.pattern<{ doc: unknown }>(({ doc }) =>
        builder.inspectConfLabel(doc, "/body", {
          atomType: CFC_ATOM_TYPE.Caveat,
        })
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result-missing",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { doc: source }, resultCell);
      // The blessed pre-commit chokepoint (what production runner paths call):
      // the builtin's initial run happens inside THIS tx, records the
      // metadata observation, and marks it CFC-relevant, which is what lets
      // the commit through.
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(runtime, result);
      await runtime.idle();
      expect(value).toEqual({ status: "notAvailable" });
    });

    it("fails closed on declared-entry source projections (unreadable match)", async () => {
      await seedLabeledDoc(runtime, "inspect-src-declared", {
        origin: "declared",
      });
      const source = runtime.getCell(
        space,
        "inspect-src-declared",
        undefined,
        tx,
      );
      const testPattern = builder.pattern<{ doc: unknown }>(({ doc }) =>
        builder.inspectConfLabel(doc, "/body", {
          atomType: CFC_ATOM_TYPE.Caveat,
        })
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result-declared",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { doc: source }, resultCell);
      // The blessed pre-commit chokepoint (what production runner paths call):
      // the builtin's initial run happens inside THIS tx, records the
      // metadata observation, and marks it CFC-relevant, which is what lets
      // the commit through.
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(runtime, result);
      await runtime.idle();
      expect(value).toEqual({ status: "notAvailable" });
    });

    it("treats a missing target as unobservable", async () => {
      // No target bound at all: the input slot resolves to no cell, and the
      // outcome is the SAME notAvailable as every hidden arm.
      const testPattern = builder.pattern(() =>
        builder.inspectConfLabel(undefined, "/body", {})
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result-notarget",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(runtime, result);
      await runtime.idle();
      expect(value).toEqual({ status: "notAvailable" });
    });

    it("refuses labels-of-labels addressing", async () => {
      await seedLabeledDoc(runtime, "inspect-src-lol");
      const source = runtime.getCell(space, "inspect-src-lol", undefined, tx);
      const testPattern = builder.pattern<{ doc: unknown }>(({ doc }) =>
        builder.inspectConfLabel(doc, "/cfc/labels/value/body", {})
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result-lol",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { doc: source }, resultCell);
      // The blessed pre-commit chokepoint (what production runner paths call):
      // the builtin's initial run happens inside THIS tx, records the
      // metadata observation, and marks it CFC-relevant, which is what lets
      // the commit through.
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(runtime, result);
      await runtime.idle();
      expect(value).toEqual({ status: "notAvailable" });
    });
  });

  describe("with flow labels off (the fail-closed degradation)", () => {
    beforeEach(() => boot("off"));

    it("withholds protected results instead of emitting them unlabeled", async () => {
      await seedLabeledDoc(runtime, "inspect-src-off");
      const source = runtime.getCell(space, "inspect-src-off", undefined, tx);
      const testPattern = builder.pattern<{ doc: unknown }>(({ doc }) =>
        builder.inspectConfLabel(doc, "/body", {
          atomType: CFC_ATOM_TYPE.Caveat,
        })
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result-off",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { doc: source }, resultCell);
      // The blessed pre-commit chokepoint (what production runner paths call):
      // the builtin's initial run happens inside THIS tx, records the
      // metadata observation, and marks it CFC-relevant, which is what lets
      // the commit through.
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(runtime, result);
      await runtime.idle();
      // The match exists, but the result cannot carry its label (flow labels
      // are not persisting): the fail-closed arm returns the SAME
      // notAvailable as every other hidden arm — never an unlabeled copy of
      // protected metadata.
      expect(value).toEqual({ status: "notAvailable" });

      // And nothing protected landed on the result doc. The stored value
      // pins that document, so an empty confidentiality list is its own.
      expect(storedValueOf(storageManager, runtime, result)).toEqual({
        status: "notAvailable",
      });
      const confidentiality = storedConfidentialityOf(runtime, result);
      expect(confidentiality).toEqual([]);
    });

    it("still answers purely public queries (miss from public consultation)", async () => {
      await seedLabeledDoc(runtime, "inspect-src-off-pub", {
        origin: "declared",
      });
      const source = runtime.getCell(
        space,
        "inspect-src-off-pub",
        undefined,
        tx,
      );
      const testPattern = builder.pattern<{ doc: unknown }>(({ doc }) =>
        builder.inspectConfLabel(doc, "/body", {
          atomType: CFC_ATOM_TYPE.Expires,
        })
      );
      const resultCell = runtime.getCell(
        space,
        "inspect-result-off-pub",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { doc: source }, resultCell);
      // The blessed pre-commit chokepoint (what production runner paths call):
      // the builtin's initial run happens inside THIS tx, records the
      // metadata observation, and marks it CFC-relevant, which is what lets
      // the commit through.
      runtime.prepareTxForCommit(tx);
      tx.commit();

      const value = await waitForStatus(runtime, result);
      await runtime.idle();
      // Establishing this miss consulted only public type observations, so
      // it flows under any dial.
      expect(value).toEqual({ status: "ok", atoms: [] });
    });
  });

  describe("display path (unchanged by Stage 2)", () => {
    beforeEach(() => boot("persist"));

    it("getCfcLabel's view stays byte-identical: redacted source, no query surface", async () => {
      await seedLabeledDoc(runtime, "inspect-src-display");
      const checkTx = runtime.edit();
      const cell = runtime.getCell(
        space,
        "inspect-src-display",
        undefined,
        checkTx,
      );
      const view = cfcLabelViewForCell(cell);
      expect(view).toBeDefined();
      const redacted = redactCaveatSourcesForDisplay(view!);
      // The exact display bytes (audit 28b redaction): Caveat.source dropped,
      // kind/type kept, the string atom untouched. Introspection returns the
      // source through its LABELED channel; the display path must not.
      expect(JSON.parse(JSON.stringify(redacted))).toEqual({
        version: 1,
        entries: [{
          path: ["body"],
          label: {
            confidentiality: [
              "secret",
              { type: CFC_ATOM_TYPE.Caveat, kind: "prompt-influence" },
            ],
          },
        }],
      });
      await checkTx.commit();
    });
  });
});
