/**
 * The membership a pattern setup stamps on a piece's result wiring (spec
 * §8.9.1.3): the references the build places at the slots of the result
 * document. Where the build and the piece's identity alone decided them, the
 * membership carries the trigger reads, and none of what else the setup read;
 * every setup that restates the wiring re-mints it, whether or not it writes
 * the value. The existence entry keeps the join of the attempt that created
 * the document.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { FabricValue } from "@commonfabric/data-model";

import { NAME } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-result-wiring");
const space = signer.did();

/** The confidentiality of another principal's data. */
const BOB = "bob-secret";

/** The confidentiality a planted existence entry carries. */
const CAROL = "carol-secret";

describe("cfc-result-wiring-stamp", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The stamps below reach storage at "persist".
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Seeds a document of Bob's, whose every read carries {@link BOB}. */
  const seedBobsDocument = async (): Promise<IMemorySpaceAddress> => {
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
          entries: [{ path: [], label: { confidentiality: [BOB] } }],
        },
      },
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    return address;
  };

  /**
   * The patterns set up below: `plain` and `wider` differ in their result, so
   * one set up over the other rewrites the wiring; `named` carries a name,
   * which a setup of the same pattern keeps from the stored result.
   */
  const patterns = () => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const { lift } = cf as unknown as {
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const double = lift((x: number) => x * 2);
    const triple = lift((x: number) => x * 3);
    const title = lift((x: number) => `Page ${x}`);
    const inner = cf.pattern<{ x: number }>(({ x }) => ({ a: double(x) }));
    return {
      outer: cf.pattern<{ x: number }>(({ x }) => ({ child: inner({ x }) })),
      plain: cf.pattern<{ x: number }>(({ x }) => ({ a: double(x) })),
      wider: cf.pattern<{ x: number }>(({ x }) => ({
        a: double(x),
        b: triple(x),
      })),
      named: cf.pattern<{ x: number }>(({ x }) => ({
        [NAME]: title(x),
        a: double(x),
      })),
      mixed: cf.pattern<{ x: number }>(({ x }) => ({
        a: double(x),
        note: "fixed",
      })),
    };
  };

  /**
   * Sets `pattern` up on the result document `cause`, in a transaction that
   * first reads Bob's document when `bobs` is given, and returns the result
   * cell once the transaction commits. The piece is stopped again, so the
   * next call sets it up afresh.
   */
  const setUp = async (
    cause: string,
    pattern: ReturnType<typeof patterns>[keyof ReturnType<typeof patterns>],
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
    runtime.runner.stop(result);
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

  /**
   * The confidentiality of the root's membership entries: its `enumerate`
   * stamp and its `*`-child templates.
   */
  const membershipOf = (cell: Cell<unknown>): unknown[] =>
    entriesOf(cell)
      .filter((entry) =>
        entry.origin === "structure" &&
        ((entry.path.length === 0 && entry.observes === "enumerate") ||
          (entry.path.length === 1 && entry.path[0] === "*"))
      )
      .flatMap((entry) => entry.label.confidentiality ?? []);

  /** The confidentiality of the derived entries anywhere on `cell`. */
  const derivedOf = (cell: Cell<unknown>): unknown[] =>
    entriesOf(cell)
      .filter((entry) => entry.origin === "derived")
      .flatMap((entry) => entry.label.confidentiality ?? []);

  /** The confidentiality of the root's existence entry. */
  const existenceOf = (cell: Cell<unknown>): unknown[] =>
    entriesOf(cell)
      .filter((entry) =>
        (entry.origin === "structure" || entry.origin === "derived") &&
        entry.path.length === 0 && entry.observes === "shape"
      )
      .flatMap((entry) => entry.label.confidentiality ?? []);

  /**
   * Adds to `cell`'s stored label map a membership stamp naming `atom` and an
   * existence entry naming `existence`, as a stamp left by an earlier attempt
   * would.
   */
  const plantStamp = async (
    cell: Cell<unknown>,
    atom: string,
    existence = CAROL,
  ): Promise<void> => {
    const tx = runtime.edit();
    const link = cell.getAsNormalizedFullLink();
    const document: IMemorySpaceAddress = {
      space: link.space,
      scope: link.scope,
      id: link.id,
      path: [],
    };
    writeSeedEnvelopeDoc(tx, space);
    const cfc = (storedFields(tx, document).cfc ?? {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: [] },
    }) as { labelMap: { entries: FabricValue[] } };
    const stamp = { confidentiality: [atom] };
    seedStoredEnvelope(tx, { ...document, path: ["cfc"] }, {
      ...cfc,
      labelMap: {
        ...cfc.labelMap,
        entries: [
          ...cfc.labelMap.entries.filter((entry) =>
            !((entry as LabelMapEntry).path.length === 0 &&
              (entry as LabelMapEntry).observes === "shape")
          ),
          {
            path: [],
            label: stamp,
            origin: "structure",
            observes: "enumerate",
          },
          {
            path: [],
            label: { confidentiality: [existence] },
            origin: "structure",
            observes: "shape",
          },
          ...(["followRef", "shape", "value"] as const).map((observes) => ({
            path: ["*"],
            label: stamp,
            origin: "structure",
            observes,
          })),
        ],
      },
    } as FabricValue);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    expect(membershipOf(cell)).toContain(atom);
    expect(existenceOf(cell)).toEqual([existence]);
  };

  describe("a setup that reads another principal's data", () => {
    it("stamps it on the membership where the transaction read it before choosing the pattern", async () => {
      // What a transaction read before a setup began decided which pattern
      // it set up, and so which references the wiring places.

      const { plain, wider } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("chosen-by-bob", plain);
      expect(membershipOf(result)).not.toContain(BOB);

      const tx = runtime.edit();
      const { note } = runtime.getCellFromLink(bobs, undefined, tx).get() as {
        note: string;
      };
      runtime.run(
        tx,
        note === "wider" ? wider : plain,
        { x: 1 },
        runtime.getCell(space, "chosen-by-bob", undefined, tx),
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.idle();

      expect(membershipOf(result)).toContain(BOB);
    });

    it("leaves it off the membership where the setup's own check of the stored argument read it", async () => {
      // A setup validates the argument it finds stored before anything else
      // it does, through whatever links that argument holds; what that reads
      // decided nothing about which pattern is set up.

      const { plain } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("validated", plain);

      const tx = runtime.edit();
      await runtime.runSynced(
        runtime.getCell(space, "validated", undefined, tx),
        plain,
        { x: 1 },
        {
          validateCurrentArgument: () => {
            runtime.getCellFromLink(bobs, undefined, tx).get();
          },
        },
      );
      // The validation read Bob's data in the setup's transaction.
      expect(deriveFlowJoin(tx).confidentiality).toContain(BOB);
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.idle();
      runtime.runner.stop(result);

      expect(membershipOf(result)).not.toContain(BOB);
    });

    it("stamps it on the membership of a wiring that carries its stored name", async () => {
      const { named } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("named-reads-bob", named);
      expect(membershipOf(result)).not.toContain(BOB);

      await setUp("named-reads-bob", named, bobs);

      expect(membershipOf(result)).toContain(BOB);
    });

    it("stamps nothing of it on an unchanged result that holds data beside its references", async () => {
      const { mixed } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("mixed-reads-bob", mixed);
      expect(derivedOf(result)).not.toContain(BOB);

      await setUp("mixed-reads-bob", mixed, bobs);

      expect(derivedOf(result)).not.toContain(BOB);
      expect(membershipOf(result)).not.toContain(BOB);
    });
  });

  describe("a stamp an earlier attempt left on the membership", () => {
    it("comes off at a setup that rewrites the wiring, though that setup reads Bob's clause on the existence entry", async () => {
      // The setup reads the result document it rewrites, and so consumes
      // the existence entry there, which names Bob as well.

      const { plain, wider } = patterns();
      const result = await setUp("rewritten", plain);
      await plantStamp(result, BOB, BOB);

      await setUp("rewritten", wider);

      expect(membershipOf(result)).not.toContain(BOB);
      expect(existenceOf(result)).toEqual([BOB]);
    });

    it("stays where a run deferred out of the transaction that read the data finds the wiring unchanged", async () => {
      // A pattern the runtime has not named yet is set up later, in a
      // transaction of its own that holds none of the reads that asked for
      // it. The clause those reads carried stays.

      const { plain } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("deferred", plain);
      await plantStamp(result, BOB);

      const tx = runtime.edit();
      runtime.getCellFromLink(bobs, undefined, tx).get();
      const deferred = runtime.run(
        tx,
        patterns().plain,
        { x: 1 },
        runtime.getCell(space, "deferred", undefined, tx),
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      await deferred.pull();
      await runtime.idle();
      runtime.runner.stop(result);

      expect(membershipOf(result)).toContain(BOB);
      expect(existenceOf(result)).toEqual([CAROL]);
    });

    it("stays where a running piece is swapped to the same wiring by a transaction that read the data", async () => {
      // The swap of a running piece sets up in a transaction of its own,
      // made after the one that asked for it.

      const { plain } = patterns();
      const bobs = await seedBobsDocument();
      const first = runtime.edit();
      const running = runtime.run(
        first,
        plain,
        { x: 1 },
        runtime.getCell(space, "swapped", undefined, first),
      );
      first.prepareCfc();
      expect((await first.commit().settled).ok).toBeDefined();
      await runtime.idle();
      await plantStamp(running, BOB);

      const tx = runtime.edit();
      runtime.getCellFromLink(bobs, undefined, tx).get();
      runtime.run(
        tx,
        patterns().plain,
        { x: 1 },
        runtime.getCell(space, "swapped", undefined, tx),
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.idle();
      runtime.runner.stop(running);

      expect(membershipOf(running)).toContain(BOB);
      expect(existenceOf(running)).toEqual([CAROL]);
    });

    it("stays where a pattern started after the asking transaction commits finds the wiring unchanged", async () => {
      // A start that waits for the asking transaction to commit sets up in a
      // transaction of its own, which holds none of the asking one's reads.

      const { plain } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("after-commit", plain);
      await plantStamp(result, BOB);

      const tx = runtime.edit();
      runtime.getCellFromLink(bobs, undefined, tx).get();
      runtime.runner.accessForTestingOnly.runPatternAfterSuccessfulCommit(
        tx,
        runtime.getCell(space, "after-commit", undefined, tx),
        plain,
        { x: 1 },
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.idle();
      runtime.runner.stop(result);

      expect(membershipOf(result)).toContain(BOB);
      expect(existenceOf(result)).toEqual([CAROL]);
    });

    it("comes off at a setup that finds the wiring unchanged", async () => {
      const { plain } = patterns();
      const result = await setUp("restated", plain);
      await plantStamp(result, BOB);

      await setUp("restated", plain);

      expect(membershipOf(result)).not.toContain(BOB);
      expect(existenceOf(result)).toEqual([CAROL]);
    });

    it("stays where the setup carries over the stored name it guards", async () => {
      // The stored name is a reference the stored document chose, so the
      // stamp on which reference sits there stays with it.

      const { named } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("name-carried", named);
      const tx = runtime.edit();
      const link = result.getAsNormalizedFullLink();
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, {
        space: link.space,
        scope: link.scope,
        id: link.id,
        path: ["value", NAME],
      }, {
        "/": {
          "link@1": { id: bobs.id, path: [], space, scope: "space" },
        },
      } as FabricValue);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      await plantStamp(result, BOB);

      await setUp("name-carried", named);

      expect(membershipOf(result)).toContain(BOB);
      expect(existenceOf(result)).toEqual([CAROL]);
    });

    it("stays where the setup carries over the stored name it guards, and rewrites another slot", async () => {
      const { named } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("name-carried-rewritten", named);
      const tx = runtime.edit();
      const link = result.getAsNormalizedFullLink();
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, {
        space: link.space,
        scope: link.scope,
        id: link.id,
        path: ["value", NAME],
      }, {
        "/": {
          "link@1": { id: bobs.id, path: [], space, scope: "space" },
        },
      } as FabricValue);
      // A slot the setup writes again, so that it writes the root.
      seedStoredEnvelope(tx, {
        space: link.space,
        scope: link.scope,
        id: link.id,
        path: ["value", "a"],
      }, {
        "/": {
          "link@1": { id: bobs.id, path: [], space, scope: "space" },
        },
      } as FabricValue);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      await plantStamp(result, BOB);

      await setUp("name-carried-rewritten", named);

      expect(membershipOf(result)).toContain(BOB);
      expect(existenceOf(result)).toEqual([CAROL]);
    });
  });

  describe("a stamp a setup that writes nothing would keep", () => {
    // Each way the runner sets a stamped document up again, in a transaction
    // that read Bob's data first, with a wiring that does not change: a setup
    // that writes nothing leaves Bob's clause on the membership, so a re-mint
    // must keep it too. A nested child is set up by its parent's setup, and
    // takes the standing of whatever transaction that runs in.

    const routes: {
      name: string;
      running: boolean;
      run: (
        tx: ReturnType<Runtime["edit"]>,
        cell: Cell<unknown>,
        same: Parameters<Runtime["run"]>[1],
        fresh: () => Parameters<Runtime["run"]>[1],
      ) => Cell<unknown> | undefined;
    }[] = [
      {
        name: "a run in the transaction that read the data",
        running: false,
        run: (tx, cell, same) => runtime.run(tx, same, { x: 1 }, cell),
      },
      {
        name: "a run deferred until its pattern is named",
        running: false,
        run: (tx, cell, _same, fresh) =>
          runtime.run(tx, fresh(), { x: 1 }, cell),
      },
      {
        name: "a start after the asking transaction commits",
        running: false,
        run: (tx, cell, same) => {
          runtime.runner.accessForTestingOnly.runPatternAfterSuccessfulCommit(
            tx,
            cell,
            same as Parameters<
              typeof runtime.runner.accessForTestingOnly.runPatternAfterSuccessfulCommit
            >[2],
            { x: 1 },
          );
          return undefined;
        },
      },
      {
        name: "a swap of the running piece",
        running: true,
        run: (tx, cell, _same, fresh) =>
          runtime.run(tx, fresh(), { x: 1 }, cell),
      },
    ];

    for (const nested of [false, true]) {
      for (const route of routes) {
        it(`keeps it through ${route.name}${nested ? ", on a nested child" : ""}`, async () => {
          const same = patterns();
          const pattern = nested ? same.outer : same.plain;
          // A pattern built afresh, after the first setup, is one this
          // runtime has not named.
          const freshPattern = () =>
            nested ? patterns().outer : patterns().plain;
          const bobs = await seedBobsDocument();
          const cause = `kept-${nested ? "child" : "top"}-${route.name}`;

          const first = runtime.edit();
          const result = runtime.run(
            first,
            pattern,
            { x: 1 },
            runtime.getCell(space, cause, undefined, first),
          );
          first.prepareCfc();
          expect((await first.commit().settled).ok).toBeDefined();
          await runtime.idle();
          // Reading the result would name the families its graph runs, and a
          // run deferred until its pattern is named would then not defer.
          const target = nested ? result.key("child").resolveAsCell() : result;
          if (!route.running) runtime.runner.stop(result);
          await plantStamp(target, BOB);

          const tx = runtime.edit();
          runtime.getCellFromLink(bobs, undefined, tx).get();
          const again = route.run(
            tx,
            runtime.getCell(space, cause, undefined, tx),
            pattern,
            freshPattern,
          );
          tx.prepareCfc();
          expect((await tx.commit().settled).ok).toBeDefined();
          // A deferred setup lands after the asking transaction commits.
          await again?.pull();
          await runtime.idle();
          runtime.runner.stop(result);

          expect(membershipOf(target)).toContain(BOB);
          expect(existenceOf(target)).toEqual([CAROL]);
        });
      }
    }
  });
});
