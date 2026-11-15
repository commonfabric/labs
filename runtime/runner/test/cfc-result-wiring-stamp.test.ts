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
import { isCellLink, parseLink } from "../src/link-utils.ts";
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
   * The patterns set up below: `plain` and `wider` differ in their result, so
   * one set up over the other rewrites the wiring; `named` carries a name,
   * which a setup of the same pattern keeps from the stored result;
   * `forwarding` returns a nested `named` piece as its whole result, so its
   * result document stores a reference. `mixed`, `remixed`, `sameMixed` and
   * `namedMixed` hold data beside their references; `sameMixed` is another
   * pattern with the result `mixed` has. `dataOnly` holds data and no
   * reference, and `sameDataOnly` is another pattern with its result.
   * `nestedMixed` holds data beside a reference below its root, and
   * `sameNestedMixed` is another pattern with its result.
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
    const named = cf.pattern<{ x: number }>(({ x }) => ({
      [NAME]: title(x),
      a: double(x),
    }));
    return {
      outer: cf.pattern<{ x: number }>(({ x }) => ({ child: inner({ x }) })),
      plain: cf.pattern<{ x: number }>(({ x }) => ({ a: double(x) })),
      wider: cf.pattern<{ x: number }>(({ x }) => ({
        a: double(x),
        b: triple(x),
      })),
      named,
      forwarding: cf.pattern<{ x: number }>(({ x }) => named({ x })),
      mixed: cf.pattern<{ x: number }>(({ x }) => ({
        a: double(x),
        note: "fixed",
      })),
      remixed: cf.pattern<{ x: number }>(({ x }) => ({
        a: double(x),
        note: "changed",
      })),
      sameMixed: cf.pattern<{ x: number }>(({ x }) => {
        triple(x);
        return { a: double(x), note: "fixed" };
      }),
      namedMixed: cf.pattern<{ x: number }>(({ x }) => ({
        [NAME]: title(x),
        a: double(x),
        note: "fixed",
      })),
      nestedMixed: cf.pattern<{ x: number }>(({ x }) => ({
        inner: { a: double(x) },
        note: "fixed",
      })),
      sameNestedMixed: cf.pattern<{ x: number }>(({ x }) => {
        triple(x);
        return { inner: { a: double(x) }, note: "fixed" };
      }),
      dataOnly: cf.pattern<{ x: number }>(() => ({ note: "fixed" })),
      sameDataOnly: cf.pattern<{ x: number }>(({ x }) => {
        triple(x);
        return { note: "fixed" };
      }),
    };
  };

  /**
   * Has the storage manager record holds only for the documents whose ids
   * `kept` names, as it is by the time the cells holding every other document
   * have been collected. A release pass then drops the documents a stopped
   * piece leaves that no action reads, whenever the test runs, and keeps the
   * ones the test holds a cell for. `kept` may grow while the case runs.
   */
  const holdOnly = (kept: ReadonlySet<string>): void => {
    const recorded = storageManager.holdDocument.bind(storageManager);
    storageManager.holdDocument = (address, identity) =>
      kept.has(address.id) ? recorded(address, identity) : {};
  };

  /** The id of the result document `cause` names. */
  const resultIdOf = (cause: string): string =>
    runtime.getCell(space, cause).getAsNormalizedFullLink().id;

  /**
   * How many attempts the latest {@link setUp} took. Only a case that forces
   * the release before a setup checks it: in any other, whether a release pass
   * drops the stopped piece's documents before its next setup is a matter of
   * timing, so that setup may take one attempt or two.
   */
  let setUpAttempts = 0;

  /**
   * Sets `pattern` up on the result document `cause`, in a transaction that
   * first reads Bob's document when `bobs` is given, and returns the result
   * cell once the transaction commits. The piece is stopped again, so the
   * next call sets it up afresh.
   *
   * The transaction is `editWithRetry()`'s. A stop asks for a release pass,
   * which can drop the stopped piece's argument and `computed:` documents, and
   * a later setup of the same piece reads them as absent. Its commit is then
   * refused, and only an attempt that can run again once they have loaded
   * converges ("Reading a released document again" in
   * `docs/features/document-release.md`). How many attempts it took is left
   * in {@link setUpAttempts}.
   */
  const setUp = async (
    cause: string,
    pattern: ReturnType<typeof patterns>[keyof ReturnType<typeof patterns>],
    bobs?: IMemorySpaceAddress,
  ): Promise<Cell<unknown>> => {
    let result: Cell<unknown> | undefined;
    setUpAttempts = 0;
    const { error } = await runtime.editWithRetry((tx) => {
      setUpAttempts += 1;
      if (bobs !== undefined) {
        runtime.getCellFromLink(bobs, undefined, tx).get();
      }
      const resultCell = runtime.getCell(space, cause, undefined, tx);
      result = runtime.run(tx, pattern, { x: 1 }, resultCell);
    });
    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    await runtime.idle();
    runtime.runner.stop(result!);
    return result!;
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

  /**
   * Adds to `cell`'s stored label map a derived entry naming `atom` at `path`,
   * of the observation class `observes`, `value` unless given, as a write
   * there by an earlier attempt would leave, or of none, as a write before
   * entries named their class did.
   */
  const plantDerived = async (
    cell: Cell<unknown>,
    path: readonly string[],
    atom: string,
    observes: "value" | "shape" | "none" = "value",
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
    seedStoredEnvelope(tx, { ...document, path: ["cfc"] }, {
      ...cfc,
      labelMap: {
        ...cfc.labelMap,
        entries: [
          ...cfc.labelMap.entries,
          {
            path: [...path],
            label: { confidentiality: [atom] },
            origin: "derived",
            ...(observes === "none" ? {} : { observes }),
          },
        ],
      },
    } as FabricValue);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
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

    it("stamps it on the value of an unchanged result that holds data beside its references", async () => {
      // The setup restates the data the result holds, so the result's value
      // stamp is re-minted from the attempt's join, which carries what the
      // transaction read before choosing the pattern.

      const { mixed } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("mixed-reads-bob", mixed);
      expect(derivedOf(result)).not.toContain(BOB);

      await setUp("mixed-reads-bob", mixed, bobs);

      expect(derivedOf(result)).toContain(BOB);
      expect(membershipOf(result)).not.toContain(BOB);
    });

    it("stamps nothing of it on an unchanged result that holds data and no reference", async () => {
      // Only a root holding data beside references is restated: whether a
      // root of data alone is too is a question on specs#98, so its entries
      // stay as stored.

      const { dataOnly, sameDataOnly } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("data-only-reads-bob", dataOnly);
      expect(derivedOf(result)).toEqual([]);

      await setUp("data-only-reads-bob", sameDataOnly, bobs);

      expect(derivedOf(result)).toEqual([]);
      expect(existenceOf(result)).toEqual([]);
    });

    it("records no existence of an unchanged result that holds data beside its references", async () => {
      // The root existed before the setup, which only restates it, so no
      // existence entry records a creation from the attempt's join.

      const { mixed } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("mixed-exists", mixed);
      expect(existenceOf(result)).toEqual([]);

      await setUp("mixed-exists", mixed, bobs);

      expect(derivedOf(result)).toContain(BOB);
      expect(existenceOf(result)).toEqual([]);
    });

    it("replaces a derived entry below an unchanged result's root with the root's", async () => {
      // A write of the root would drop what an earlier write left below it,
      // so a reader there takes the re-derived root entry instead.

      const { mixed } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("mixed-below", mixed);
      await plantDerived(result, ["note"], CAROL);

      await setUp("mixed-below", mixed, bobs);

      expect(
        entriesOf(result)
          .filter((entry) => entry.origin === "derived")
          .map((entry) => [entry.path, entry.label.confidentiality]),
      ).toEqual([[[], [BOB]]]);
      const tx = runtime.edit();
      try {
        result.withTx(tx).key("note" as never).get();
        expect(deriveFlowJoin(tx).confidentiality).toEqual([BOB]);
      } finally {
        tx.abort("probe read");
      }
    });

    it("keeps an existence entry below an unchanged result's root, as a write of the root does", async () => {
      // A write of the root clears the value entries below it and keeps the
      // existence entries there, which record that a path was written.

      const { mixed } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("mixed-below-existence", mixed);
      await plantDerived(result, ["note"], CAROL, "shape");
      await plantDerived(result, ["note"], "note-secret");

      await setUp("mixed-below-existence", mixed, bobs);

      expect(
        entriesOf(result)
          .filter((entry) =>
            entry.origin === "derived" && entry.path.length === 1
          )
          .map((entry) => [
            entry.path,
            entry.observes,
            [...(entry.label.confidentiality ?? [])].sort(),
          ]),
      ).toEqual([[["note"], "shape", [CAROL]]]);
    });

    it("mints no existence entry from its join on an unchanged result whose root holds an entry naming no class", async () => {
      // The restatement clears that entry with the value entries, and the
      // existence history it carried moves to an existence entry alone: a
      // restatement is not a creation, so the join it read reaches none.

      const { mixed, sameMixed } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("legacy-root", mixed);
      await plantDerived(result, [], "legacy-secret", "none");

      await setUp("legacy-root", sameMixed, bobs);

      expect(existenceOf(result)).not.toContain(BOB);
      expect(existenceOf(result)).toContain("legacy-secret");
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
      // transaction of its own that carries the reads that asked for it, so
      // its re-mint keeps the clause those reads carried.

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
      // made after the one that asked for it and carrying its reads.

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
      // transaction of its own, which carries the asking one's reads.

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

    it("comes off where a run deferred out of a transaction that read nothing labeled finds the wiring unchanged", async () => {
      // The deferred setup carries the asking transaction's standing with
      // its reads, so it restates the wiring.

      const { plain } = patterns();
      const result = await setUp("deferred-public", plain);
      await plantStamp(result, BOB);

      const tx = runtime.edit();
      const deferred = runtime.run(
        tx,
        patterns().plain,
        { x: 1 },
        runtime.getCell(space, "deferred-public", undefined, tx),
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      await deferred.pull();
      await runtime.idle();
      runtime.runner.stop(result);

      expect(membershipOf(result)).not.toContain(BOB);
      expect(existenceOf(result)).toEqual([CAROL]);
    });

    it("comes off where a running piece is swapped to the same wiring by a transaction that read nothing labeled", async () => {
      const { plain } = patterns();
      const first = runtime.edit();
      const running = runtime.run(
        first,
        plain,
        { x: 1 },
        runtime.getCell(space, "swapped-public", undefined, first),
      );
      first.prepareCfc();
      expect((await first.commit().settled).ok).toBeDefined();
      await runtime.idle();
      await plantStamp(running, BOB);

      const tx = runtime.edit();
      runtime.run(
        tx,
        patterns().plain,
        { x: 1 },
        runtime.getCell(space, "swapped-public", undefined, tx),
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.idle();
      runtime.runner.stop(running);

      expect(membershipOf(running)).not.toContain(BOB);
      expect(existenceOf(running)).toEqual([CAROL]);
    });

    describe("a run its asking transaction aborts", () => {
      // The run still goes ahead in a transaction of its own, carrying the
      // aborted transaction's reads, but not its standing: a transaction that
      // never committed changes no stored label.

      it("stays where the deferred setup finds the wiring unchanged", async () => {
        const { plain } = patterns();
        const result = await setUp("aborted", plain);
        await plantStamp(result, BOB);

        const tx = runtime.edit();
        runtime.run(
          tx,
          patterns().plain,
          { x: 1 },
          runtime.getCell(space, "aborted", undefined, tx),
        );
        tx.abort("caller aborted");
        await runtime.idle();
        runtime.runner.stop(result);

        expect(membershipOf(result)).toContain(BOB);
        expect(existenceOf(result)).toEqual([CAROL]);
      });

      it("stays where a running piece swaps to the same wiring", async () => {
        const { plain } = patterns();
        const first = runtime.edit();
        const running = runtime.run(
          first,
          plain,
          { x: 1 },
          runtime.getCell(space, "aborted-running", undefined, first),
        );
        first.prepareCfc();
        expect((await first.commit().settled).ok).toBeDefined();
        await runtime.idle();
        await plantStamp(running, BOB);

        const tx = runtime.edit();
        runtime.run(
          tx,
          patterns().plain,
          { x: 1 },
          runtime.getCell(space, "aborted-running", undefined, tx),
        );
        tx.abort("caller aborted");
        await runtime.idle();
        runtime.runner.stop(running);

        expect(membershipOf(running)).toContain(BOB);
        expect(existenceOf(running)).toEqual([CAROL]);
      });
    });

    it("stays where a pattern started after the commit of a transaction no caller asked it in finds the wiring unchanged", async () => {
      // The start carries the reads of the transaction it was deferred from,
      // and that transaction's standing with them: one no caller handed the
      // runner to set the pattern up in is not an asking one, so neither is
      // the start, though it read nothing labeled.

      const { plain } = patterns();
      const result = await setUp("after-commit-public", plain);
      await plantStamp(result, BOB);

      const tx = runtime.edit();
      runtime.runner.accessForTestingOnly.runPatternAfterSuccessfulCommit(
        tx,
        runtime.getCell(space, "after-commit-public", undefined, tx),
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

    it("takes nothing a deferred start read itself onto a nested wiring it restates", async () => {
      // A pattern the runtime has not named yet is set up later, in a
      // transaction of its own that carries the asking transaction's reads,
      // here none. Instantiating the pattern there sets up a nested piece
      // whose result names Bob, and reads that result, before setting up the
      // nested piece that keeps its wiring. What the start read on the way
      // chose nothing about that wiring.

      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const { lift } = cf as unknown as {
        lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
      };
      const double = lift((x: number) => x * 2);
      const triple = lift((x: number) => x * 3);
      const first = cf.pattern<{ x: number }>(({ x }) => ({ b: triple(x) }));
      const second = cf.pattern<{ x: number }>(({ x }) => ({ a: double(x) }));
      const siblings = (version: number) =>
        cf.pattern<{ x: number }>(({ x }) => ({
          aFirst: first({ x }),
          zSecond: second({ x }),
          version,
        }));
      const run = async (version: number): Promise<Cell<unknown>> => {
        const tx = runtime.edit();
        const result = runtime.run(
          tx,
          siblings(version),
          { x: 1 },
          runtime.getCell(space, "deferred-siblings", undefined, tx),
        );
        tx.prepareCfc();
        expect((await tx.commit().settled).ok).toBeDefined();
        await runtime.idle();
        runtime.runner.stop(result);
        return result;
      };
      const child = (result: Cell<unknown>, key: string) =>
        (result as Cell<Record<string, unknown>>).key(key).resolveAsCell();

      const result = await run(1);
      const firstChild = child(result, "aFirst");
      const secondChild = child(result, "zSecond");
      await plantStamp(firstChild, BOB, BOB);
      expect(membershipOf(secondChild)).not.toContain(BOB);

      await run(2);

      expect((result as Cell<{ version: number }>).key("version").get())
        .toBe(2);
      expect(child(result, "zSecond").getAsNormalizedFullLink().id).toBe(
        secondChild.getAsNormalizedFullLink().id,
      );
      // The first nested piece's existence entry still names Bob, so the
      // start's read of it had a clause to consume.
      expect(existenceOf(firstChild)).toEqual([BOB]);
      expect(membershipOf(secondChild)).not.toContain(BOB);
    });

    describe("a source update that leaves a nested wiring unchanged", () => {
      // A source update stages its setup for resume, and the running piece
      // then instantiates the updated pattern in a transaction of its own,
      // where the nested piece is set up again. That transaction carries the
      // update's reads and its standing, so the nested setup restates the
      // wiring it finds unchanged.

      /**
       * A piece whose `inner` is a nested piece from a module of its own,
       * the same in every version, and which differs between versions by
       * `version` alone. With `named`, the nested piece names itself, so a
       * setup of the same nested pattern carries its stored name over.
       */
      const nesting = (version: number, named: boolean) => ({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
            import { pattern, Writable } from "commonfabric";
            import { inner } from "./inner.tsx";
            export default pattern<{ input: Writable<number> }>(
              ({ input }) => ({ inner: inner({ input }), version: ${version} }),
            );
          `,
        }, {
          name: "/inner.tsx",
          contents: `
            import { computed, ${
            named ? "NAME, " : ""
          }pattern, Writable } from "commonfabric";
            export const inner = pattern<{ input: Writable<number> }>(
              ({ input }) => ({
                ${
            named ? "[NAME]: computed(() => `Inner ${input.get()}`)," : ""
          }
                v: computed(() => input.get() * 2),
              }),
            );
          `,
        }],
      });

      /**
       * Sets a piece of `nesting(1, named)` running, plants a stamp naming
       * Bob on its nested piece's membership, updates it to
       * `nesting(2, named)` with a setup for resume in a transaction that
       * reads nothing labeled, and returns the nested piece's membership.
       */
      const update = async (named: boolean): Promise<unknown[]> => {
        const v1 = await runtime.patternManager.compilePattern(
          nesting(1, named),
          { space },
        );
        const v2 = await runtime.patternManager.compilePattern(
          nesting(2, named),
          { space },
        );
        const input = runtime.getCell<number>(space, `update-input-${named}`);
        const piece = runtime.getCell<{ inner: unknown; version: number }>(
          space,
          `update-piece-${named}`,
        );
        const seed = runtime.edit();
        input.withTx(seed).set(1);
        await runtime.setup(seed, v1, { input }, piece);
        expect((await seed.commit().settled).error).toBeUndefined();
        expect(await runtime.start(piece)).toBe(true);
        const stopReading = piece.sink(() => {});
        try {
          await runtime.idle();
          await runtime.runner.idlePieceInstantiationSettlements();
          const inner = piece.key("inner").resolveAsCell();
          await plantStamp(inner, BOB);
          expect(membershipOf(inner)).toContain(BOB);

          const tx = runtime.edit();
          await runtime.setup(tx, v2, undefined, piece.withTx(tx), {
            prepareForResume: true,
          });
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.idle();
          await runtime.runner.idlePieceInstantiationSettlements();
          await runtime.idle();

          expect(piece.key("version").get()).toBe(2);
          expect(
            piece.key("inner").resolveAsCell().getAsNormalizedFullLink().id,
          ).toBe(inner.getAsNormalizedFullLink().id);
          if (named) {
            expect(
              (inner.getRaw() as Record<string, unknown> | undefined)?.[NAME],
            ).toBeDefined();
          }
          return membershipOf(inner);
        } finally {
          stopReading();
        }
      };

      it("takes the stamp off where the nested piece has no name", async () => {
        expect(await update(false)).not.toContain(BOB);
      });

      it("keeps the stamp where the nested piece carries its stored name over", async () => {
        // The stored name is a reference the stored document chose, so a
        // restatement keeps the stored membership, as a setup in the asking
        // transaction does.

        expect(await update(true)).toContain(BOB);
      });
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
      // The second setup runs after a release pass has dropped the stopped
      // piece's argument and `computed:` documents, which a release does
      // once the cells holding them are collected. Recording holds only for
      // the result document, which the test holds, stands in for that
      // collection, so the pass awaited below drops them whenever the test
      // runs. The second setup writes them as well, so its first commit is
      // refused and a second attempt reads them; the first setup, which
      // creates them, takes one.

      holdOnly(new Set([resultIdOf("name-carried-rewritten")]));
      const { named } = patterns();
      const bobs = await seedBobsDocument();
      const result = await setUp("name-carried-rewritten", named);
      expect(setUpAttempts).toBe(1);
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
      await runtime.releaseUnreadDocuments();

      await setUp("name-carried-rewritten", named);
      expect(setUpAttempts).toBe(2);

      await result.sync();
      const read = runtime.edit();
      const stored = storedFields(read, {
        space: link.space,
        scope: link.scope,
        id: link.id,
        path: [],
      }).value as Record<string, unknown>;
      read.abort("stored value read");
      expect(parseLink(stored[NAME], link)?.id).toBe(bobs.id);
      expect(isCellLink(stored.a)).toBe(true);
      expect(parseLink(stored.a, link)?.id).not.toBe(bobs.id);
      expect(membershipOf(result)).toContain(BOB);
      expect(existenceOf(result)).toEqual([CAROL]);
    });
  });

  describe("a stored result that is a reference", () => {
    it("stays a reference alone when the same pattern is set up again", async () => {
      // The reference holds no name of its own; the name of what it reaches
      // is no slot of this document to carry over.

      const { forwarding } = patterns();
      const result = await setUp("forwarding", forwarding);

      await setUp("forwarding", forwarding);

      const tx = runtime.edit();
      try {
        const stored = tx.readValueOrThrow({
          ...result.getAsNormalizedFullLink(),
          path: [],
        });
        expect(isCellLink(stored)).toBe(true);
        expect(Object.keys(stored as object)).toEqual(["/"]);
      } finally {
        tx.abort("stored result read");
      }
    });

    it("is written again without a name stored beside its sigil", async () => {
      // A `NAME` beside the sigil makes the stored result no reference, so
      // resolving through the piece's result fails until a setup writes the
      // reference alone.

      const { forwarding } = patterns();
      const result = await setUp("forwarding-named", forwarding);
      const link = result.getAsNormalizedFullLink();
      const read = (): FabricValue => {
        const tx = runtime.edit();
        try {
          return tx.readValueOrThrow({ ...link, path: [] });
        } finally {
          tx.abort("stored result read");
        }
      };
      const reference = read();
      const tx = runtime.edit();
      tx.writeValueOrThrow({ ...link, path: [] }, {
        [NAME]: {
          "/": {
            "link@1": { id: "of:fid1:named", path: [], space, scope: "space" },
          },
        },
        ...(reference as Record<string, FabricValue>),
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      expect(isCellLink(read())).toBe(false);

      await setUp("forwarding-named", forwarding);

      expect(read()).toEqual(reference);
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
      /**
       * Whether the route's setup runs in the asking transaction, committed
       * once, so that the case loads what the setup reads first, as a caller
       * staging a setup over a stopped piece must
       * (`Runner.syncStoredPieceCells()`).
       */
      loadsFirst: boolean;
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
        loadsFirst: true,
        run: (tx, cell, same) => runtime.run(tx, same, { x: 1 }, cell),
      },
      {
        name: "a run deferred until its pattern is named",
        running: false,
        loadsFirst: false,
        run: (tx, cell, _same, fresh) =>
          runtime.run(tx, fresh(), { x: 1 }, cell),
      },
      {
        name: "a start after the asking transaction commits",
        running: false,
        loadsFirst: false,
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
        name: "a run given no transaction",
        running: false,
        loadsFirst: false,
        run: (_tx, cell, same) => runtime.run(undefined, same, { x: 1 }, cell),
      },
      {
        name: "a swap of the running piece",
        running: true,
        loadsFirst: false,
        run: (tx, cell, _same, fresh) =>
          runtime.run(tx, fresh(), { x: 1 }, cell),
      },
    ];

    for (const nested of [false, true]) {
      for (const route of routes) {
        it(`keeps it through ${route.name}${nested ? ", on a nested child" : ""}`, async () => {
          // A release pass awaited before the asking transaction drops what
          // the stopped piece left that no action reads, whenever the test
          // runs; the documents the test holds a cell for stay.

          const kept = new Set<string>();
          holdOnly(kept);
          const same = patterns();
          const pattern = nested ? same.outer : same.plain;
          // A pattern built afresh, after the first setup, is one this
          // runtime has not named.
          const freshPattern = () =>
            nested ? patterns().outer : patterns().plain;
          const bobs = await seedBobsDocument();
          const cause = `kept-${nested ? "child" : "top"}-${route.name}`;
          kept.add(resultIdOf(cause));

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
          kept.add(target.getAsNormalizedFullLink().id);
          if (!route.running) runtime.runner.stop(result);
          await plantStamp(target, BOB);
          await runtime.releaseUnreadDocuments();
          if (route.loadsFirst) {
            await runtime.runner.syncStoredPieceCells(result, pattern);
          }

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

  describe("a value stamp an earlier attempt left on a result that holds data", () => {
    /**
     * Adds to `cell`'s stored label map a value stamp at the root naming
     * `atom`, as an earlier attempt's whole join would leave on a result root
     * that holds data beside its references.
     */
    const plantValueStamp = async (
      cell: Cell<unknown>,
      atom: string,
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
      seedStoredEnvelope(tx, { ...document, path: ["cfc"] }, {
        ...cfc,
        labelMap: {
          ...cfc.labelMap,
          entries: [
            ...cfc.labelMap.entries,
            {
              path: [],
              label: { confidentiality: [atom] },
              origin: "derived",
              observes: "value",
            },
          ],
        },
      } as FabricValue);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      expect(derivedOf(cell)).toContain(atom);
    };

    it("comes off at a setup that rewrites the result", async () => {
      // The setup compares the result it builds with the stored one to decide
      // whether to write, and that comparison takes nothing of what it read.

      const { mixed, remixed } = patterns();
      const result = await setUp("remixed", mixed);
      await plantValueStamp(result, BOB);

      await setUp("remixed", remixed);

      expect(derivedOf(result)).not.toContain(BOB);
    });

    it("comes off at a setup of another pattern that finds the result unchanged", async () => {
      // The setup restates the data the result holds, in a transaction that
      // read nothing labeled, so the value entry is re-derived empty.

      const { mixed, sameMixed } = patterns();
      const result = await setUp("remint-unchanged", mixed);
      await plantValueStamp(result, BOB);

      await setUp("remint-unchanged", sameMixed);

      expect(derivedOf(result)).toEqual([]);
    });

    it("comes off a result whose only reference sits below its root, at a setup of another pattern that finds it unchanged", async () => {
      // A reference anywhere in the root's value makes it a root holding
      // data beside references (`holdsReference` in `cfc/prepare.ts`), not
      // only one at the top level.

      const { nestedMixed, sameNestedMixed } = patterns();
      const result = await setUp("remint-nested", nestedMixed);
      const link = result.getAsNormalizedFullLink();
      const read = runtime.edit();
      const stored = storedFields(read, {
        space: link.space,
        scope: link.scope,
        id: link.id,
        path: [],
      }).value as { inner: Record<string, unknown>; note: unknown };
      read.abort("stored value read");
      expect(isCellLink(stored.inner.a)).toBe(true);
      expect(stored.note).toBe("fixed");
      await plantValueStamp(result, BOB);

      await setUp("remint-nested", sameNestedMixed);

      expect(derivedOf(result)).toEqual([]);
    });

    it("stays on a result that holds data and no reference, at a setup of another pattern that finds it unchanged", async () => {
      // Whether a root of data alone is restated is a question on specs#98,
      // so its value entry stays as stored. Another pattern's setup reads no
      // stored name, so only that keeps the stamp.

      const { dataOnly, sameDataOnly } = patterns();
      const result = await setUp("remint-data-only", dataOnly);
      await plantValueStamp(result, BOB);

      await setUp("remint-data-only", sameDataOnly);

      expect(derivedOf(result)).toEqual([BOB]);
    });

    it("stays where a setup of the same pattern finds the result unchanged", async () => {
      // A setup of the pattern the result was set up with reads the name it
      // would carry over, though none is stored, and that read takes the
      // stamp at the root above it, so the attempt's join, which the value
      // entry is re-derived from, carries the clause again.

      const { mixed } = patterns();
      const result = await setUp("remint-same", mixed);
      await plantValueStamp(result, BOB);

      await setUp("remint-same", mixed);

      expect(derivedOf(result)).toContain(BOB);
    });

    it("stays where a run of another pattern given no transaction finds the result unchanged", async () => {
      // Only a setup in the transaction it was asked in restates an unchanged
      // result (`#isAsking` in `runner.ts`). A run given no transaction holds
      // none of the reads that chose its pattern, so a re-mint there could
      // drop a clause they carried. Another pattern's setup reads no stored
      // name, so its join is empty and only the gate keeps the stamp.

      const { mixed, sameMixed } = patterns();
      const result = await setUp("unasked-unchanged", mixed);
      await plantValueStamp(result, BOB);

      const again = runtime.run(
        undefined,
        sameMixed,
        { x: 1 },
        runtime.getCell(space, "unasked-unchanged"),
      );
      await again.pull();
      await runtime.idle();
      runtime.runner.stop(again);

      expect(derivedOf(result)).toContain(BOB);
    });

    describe("a setup the runtime starts on its own", () => {
      // A repair or a continuation hands setup a transaction holding none of
      // the reads that chose the pattern (`runtimeStarted`), so a setup there
      // that finds the result unchanged leaves its value entry as stored.
      // Each case sets up another pattern with the same result, which reads
      // no stored name, so only that gate keeps the stamp.

      it("leaves the stamp through `setup()` given a transaction", async () => {
        const { mixed, sameMixed } = patterns();
        const result = await setUp("started-setup", mixed);
        await plantValueStamp(result, BOB);

        const { error } = await runtime.editWithRetry((tx) => {
          void runtime.setup(
            tx,
            sameMixed,
            { x: 1 },
            runtime.getCell(space, "started-setup", undefined, tx),
            { prepareForResume: true, runtimeStarted: true },
          );
        });
        expect(error).toBeUndefined();
        await runtime.idle();
        runtime.runner.stop(result);

        expect(derivedOf(result)).toContain(BOB);
      });

      it("leaves the stamp through `runSynced()`", async () => {
        const { mixed, sameMixed } = patterns();
        const result = await setUp("started-synced", mixed);
        await plantValueStamp(result, BOB);

        const again = await runtime.runSynced(
          runtime.getCell(space, "started-synced"),
          sameMixed,
          { x: 1 },
          { runtimeStarted: true },
        );
        await runtime.idle();
        runtime.runner.stop(again);

        expect(derivedOf(result)).toContain(BOB);
      });

      it("leaves the stamp through `run()` given a transaction", async () => {
        const { mixed, sameMixed } = patterns();
        const result = await setUp("started-run", mixed);
        await plantValueStamp(result, BOB);

        const tx = runtime.edit();
        const again = runtime.run(
          tx,
          sameMixed,
          { x: 1 },
          runtime.getCell(space, "started-run", undefined, tx),
          { runtimeStarted: true },
        );
        tx.prepareCfc();
        expect((await tx.commit().settled).ok).toBeDefined();
        await runtime.idle();
        runtime.runner.stop(again);

        expect(derivedOf(result)).toContain(BOB);
      });
    });

    it("stays where the setup carries over the stored name, whose read takes the stamp", async () => {
      // The setup reads the name it carries over from the stored result, and
      // that read consumes the stamp at the root above it, so the attempt's
      // join, which the stamp is re-minted from, carries the clause again.

      const { namedMixed } = patterns();
      const result = await setUp("named-mixed", namedMixed);
      await plantValueStamp(result, BOB);

      await setUp("named-mixed", namedMixed);

      expect(derivedOf(result)).toContain(BOB);
    });
  });
});
