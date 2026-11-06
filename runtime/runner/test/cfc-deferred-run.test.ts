/**
 * A run the runner defers into a transaction of its own, until a piece's
 * execution family is named or until the asking transaction commits, is
 * still decided by the transaction that asked for it, so what that
 * transaction observed joins the flow label of everything the deferred run
 * writes (spec §8.9.2). Each case reads another principal's document before
 * the run, and the deferred-start committer is the positive control that the
 * run was deferred, or, where it is never called, that it was not.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-deferred-run");
const space = signer.did();

/** The confidentiality of another principal's data. */
const BOB = "bob-secret";

describe("cfc-deferred-run", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  /** The deferred starts committed so far, in order. */
  let deferredStarts: {
    tx: IExtendedStorageTransaction;
    resultCell: Cell<unknown>;
    committed: Promise<void>;
  }[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The stamps below reach storage at "persist".
      cfcFlowLabels: "persist",
    });
    deferredStarts = [];
    runtime.runner.accessForTestingOnly.deferredStartCommitter = (
      tx,
      resultCell,
      commit,
    ) => {
      const verdict = commit();
      deferredStarts.push({
        tx,
        resultCell,
        committed: verdict.then(({ error }) => {
          expect(error).toBeUndefined();
        }),
      });
      return verdict;
    };
  });

  afterEach(async () => {
    runtime.runner.accessForTestingOnly.deferredStartCommitter = undefined;
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Seeds a document of Bob's, whose every read carries `confidentiality`,
   * {@link BOB} unless given. Seeding it again relabels the same document.
   */
  const seedBobsDocument = async (
    confidentiality = [BOB],
  ): Promise<IMemorySpaceAddress> => {
    const tx = runtime.edit();
    const id = runtime.getCell(space, "bobs-document", undefined, tx)
      .getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(tx, space);
    const address: IMemorySpaceAddress = {
      space,
      scope: "space",
      id,
      path: [],
    };
    seedStoredEnvelope(tx, address, {
      value: { note: "Bob's" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: confidentiality.length === 0
            ? []
            : [{ path: [], label: { confidentiality } }],
        },
      },
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    return address;
  };

  /**
   * The patterns set up below. `wider` writes a result field `b` that
   * `plain` does not, so a setup of `wider` over `plain` stamps `b` afresh.
   */
  const patterns = () => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const { lift } = cf as unknown as {
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const double = lift((x: number) => x * 2);
    const triple = lift((x: number) => x * 3);
    return {
      cf,
      plain: cf.pattern<{ x: number }>(({ x }) => ({ a: double(x) })),
      wider: cf.pattern<{ x: number }>(({ x }) => ({
        a: double(x),
        b: triple(x),
      })),
    };
  };

  /**
   * Runs `pattern` on the result document `cause`, in a transaction that
   * first reads Bob's document when `bobs` is given, and returns the result
   * cell once the transaction commits.
   */
  const runOn = async (
    cause: string,
    pattern: ReturnType<typeof patterns>["plain"],
    bobs?: IMemorySpaceAddress,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    if (bobs !== undefined) {
      runtime.getCellFromLink(bobs, undefined, tx).get();
    }
    const resultCell = runtime.getCell(space, cause, undefined, tx);
    const result = runtime.run(tx, pattern, { x: 1 }, resultCell);
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await runtime.idle();
    return result;
  };

  /** The label entries stored on `cell`'s document. */
  const entriesOf = (cell: Cell<unknown>): readonly LabelMapEntry[] => {
    const tx = runtime.edit();
    try {
      return readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink())
        ?.labelMap.entries ?? [];
    } finally {
      tx.abort("label read");
    }
  };

  /** The confidentiality of every entry stored on `cell`'s document. */
  const confidentialityOf = (cell: Cell<unknown>): unknown[] =>
    entriesOf(cell).flatMap((entry) => entry.label.confidentiality ?? []);

  it("stamps Bob's clause on a setup run in the asking transaction", async () => {
    const bobs = await seedBobsDocument();
    const { wider } = patterns();
    const result = await runOn("fresh-result", wider, bobs);

    expect(deferredStarts).toEqual([]);
    expect(confidentialityOf(result)).toContain(BOB);
  });

  it("stamps Bob's clause on a deferred setup decided by a read of Bob's document", async () => {
    const bobs = await seedBobsDocument();
    const { plain, wider } = patterns();
    const result = await runOn("deferred-result", plain);
    expect(deferredStarts).toEqual([]);
    runtime.runner.stop(result);

    await runOn("deferred-result", wider, bobs);
    expect(deferredStarts.length).toBe(1);
    await deferredStarts[0].committed;

    expect(confidentialityOf(result)).toContain(BOB);
  });

  it("stamps the clause of label metadata the asking transaction observed on a deferred setup", async () => {
    const bobs = await seedBobsDocument([]);
    const { plain, wider } = patterns();
    const result = await runOn("metadata-result", plain);
    runtime.runner.stop(result);

    const tx = runtime.edit();
    tx.recordCfcLabelMetadataObservation({
      target: { ...bobs, path: ["cfc"] },
      observes: "labelMetadata",
      confidentiality: [BOB],
    });
    const resultCell = runtime.getCell(space, "metadata-result", undefined, tx);
    runtime.run(tx, wider, { x: 1 }, resultCell);
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await runtime.idle();
    expect(deferredStarts.length).toBe(1);
    await deferredStarts[0].committed;

    expect(confidentialityOf(result)).toContain(BOB);
  });

  it("stamps no clause on a deferred setup whose asking transaction read nothing labeled", async () => {
    await seedBobsDocument();
    const { plain, wider } = patterns();
    const result = await runOn("public-result", plain);
    runtime.runner.stop(result);

    await runOn("public-result", wider);
    expect(deferredStarts.length).toBe(1);
    await deferredStarts[0].committed;

    // The deferred setup stamps nothing on a document this public, so what
    // the document stores is what pins it: `wider`'s result, with its `b`.
    const tx = runtime.edit();
    try {
      expect(Object.keys(result.withTx(tx).getRaw() ?? {})).toContain("b");
    } finally {
      tx.abort("value read");
    }
    expect(confidentialityOf(result)).toEqual([]);
  });

  it("stamps Bob's clause on a nested setup a commit-gated start writes after its transaction read Bob's document", async () => {
    const bobs = await seedBobsDocument();
    const { cf, wider } = patterns();
    const outer = cf.pattern<{ x: number }>(({ x }) => ({
      inner: wider({ x }),
    }));
    let result: Cell<{ inner: unknown }> | undefined;
    const outcome = await runtime.editWithRetry((tx) => {
      runtime.getCellFromLink(bobs, undefined, tx).get();
      const resultCell = runtime.getCell<{ inner: unknown }>(
        space,
        "commit-gated-result",
        undefined,
        tx,
      );
      result = runtime.run(tx, outer, { x: 1 }, resultCell);
    });
    expect(outcome.error).toBeUndefined();
    expect(deferredStarts.length).toBe(1);
    await deferredStarts[0].committed;

    // The outer setup ran in the asking transaction, and the start set up the
    // nested pattern in a transaction of its own.
    const inner = result!.key("inner").resolveAsCell();
    expect(inner.getAsNormalizedFullLink().id).not.toBe(
      result!.getAsNormalizedFullLink().id,
    );
    expect(confidentialityOf(inner)).toContain(BOB);
  });

  it("stamps Bob's clause on a pattern run after the commit of a transaction that read Bob's document", async () => {
    const bobs = await seedBobsDocument();
    const { wider } = patterns();
    const tx = runtime.edit();
    runtime.getCellFromLink(bobs, undefined, tx).get();
    const receipt = runtime.getCell<unknown>(
      space,
      "after-commit-result",
      undefined,
      tx,
    );
    runtime.runner.accessForTestingOnly.runPatternAfterSuccessfulCommit(
      tx,
      receipt,
      trustExecutable(runtime, wider),
      { x: 1 },
      true,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    expect(deferredStarts.length).toBe(1);
    await deferredStarts[0].committed;

    expect(confidentialityOf(receipt)).toContain(BOB);
  });

  it("stamps Bob's clause on a deferred setup of the pattern a lift returns after reading Bob's document", async () => {
    // The lift reads Bob's document on every run, so the document is public
    // for the first, which sets the result up in the lift's own transaction,
    // and Bob's from the second. The second's setup is deferred, and the
    // result, running since the first, takes the new pattern by swapping to
    // it in transactions of its own, which set up the pattern's `b`.

    const bobs = await seedBobsDocument([]);
    const { cf, plain, wider } = patterns();
    const { lift } = cf as unknown as {
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const choose = lift(({ turn, note }: { turn: number; note: string }) =>
      note !== undefined && turn > 0 ? wider({ x: 1 }) : plain({ x: 1 })
    );
    const root = cf.pattern<{ turn: number; bobs: { note: string } }>(
      ({ turn, bobs }) => ({ child: choose({ turn, note: bobs.note }) }),
    );

    const tx = runtime.edit();
    const rootCell = runtime.getCell<any>(space, "lift-root", undefined, tx);
    const turnCell = runtime.getCell<number>(space, "lift-turn", undefined, tx);
    turnCell.set(0);
    const bobsCell = runtime.getCellFromLink(bobs, undefined, tx);
    const started = runtime.run(
      tx,
      root,
      { turn: turnCell, bobs: bobsCell },
      rootCell,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await runtime.idle();
    const stopReading = started.key("child").sink(() => {});
    try {
      await runtime.idle();
      expect(deferredStarts).toEqual([]);

      await seedBobsDocument();
      const turnTx = runtime.edit();
      turnCell.withTx(turnTx).set(1);
      expect((await turnTx.commit().settled).ok).toBeDefined();
      await runtime.idle();
      expect(deferredStarts.length).toBe(1);
      await deferredStarts[0].committed;

      // The lift's result document redirects to the document the pattern's
      // setup writes its result into.
      const written = deferredStarts[0].resultCell.resolveAsCell();
      expect(written.getAsNormalizedFullLink().id).not.toBe(
        deferredStarts[0].resultCell.getAsNormalizedFullLink().id,
      );
      expect(confidentialityOf(written)).toContain(BOB);
    } finally {
      stopReading();
    }
  });
});
