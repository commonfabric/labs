import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  createBuilder,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell as BuilderCell } from "../../../runner/src/builder/types.ts";
import {
  type FabricPlainObject,
  hashStringOf,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import {
  assertPlanRunsFixer,
  collectLinkPaths,
  documentChanges,
  evaluateFixer,
  repairPieces,
} from "../../src/ops/bulk-repair.ts";
import { decodePlan, encodePlan } from "../../src/ops/bulk-plan.ts";
import type { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { surveyPieces } from "../../src/ops/bulk-survey.ts";

const signer = await Identity.fromPassphrase("bulk repair");

/** A sigil link the way a raw stored document spells one. */
function sigil(id: string): Record<string, unknown> {
  return { "/": { "link@1": { id, path: [] } } };
}

/** A member program whose stored input carries a `seed`. */
function memberProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }>(({ seed }) => ({",
        "  [NAME]: 'Member',",
        "  seed,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

/** A holder whose stored input carries the member collection and a title. */
function holderProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ title?: string; members?: unknown[] }>(",
        "  ({ title, members }) => ({",
        "    [NAME]: 'Holder',",
        "    title,",
        "    members,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/** Uppercase the seed; the smallest fixer with something to do. */
function upperSeed(
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...document,
    ...(typeof document.seed === "string"
      ? { seed: document.seed.toUpperCase() }
      : {}),
  };
}

describe("bulk-repair", () => {
  describe("documentChanges()", () => {
    it("returns one row per changed leaf, with the exact values", () => {
      const changes = documentChanges(
        { a: 1, nested: { keep: true, flip: "x" } },
        { a: 2, nested: { keep: true, flip: "y" } },
      );
      expect(changes).toEqual([
        { path: "/a", kind: "changed", before: 1, after: 2 },
        { path: "/nested/flip", kind: "changed", before: "x", after: "y" },
      ]);
    });

    it("reports a replaced container as one change, not its every leaf", () => {
      const changes = documentChanges({ list: [1, 2, 3] }, { list: "gone" });
      expect(changes).toEqual([
        { path: "/list", kind: "changed", before: [1, 2, 3], after: "gone" },
      ]);
    });

    it("returns no rows for equal documents", () => {
      expect(documentChanges({ a: [1] }, { a: [1] })).toEqual([]);
    });

    it("reports presence as its own fact, apart from a changed value", () => {
      expect(documentChanges({ a: 1 }, { a: 1, b: 2 })).toEqual([
        { path: "/b", kind: "added", after: 2 },
      ]);
      expect(documentChanges({ a: 1, b: 2 }, { a: 1 })).toEqual([
        { path: "/b", kind: "removed", before: 2 },
      ]);
      expect(documentChanges({ a: undefined }, { a: 3 })).toEqual([
        { path: "/a", kind: "changed", before: undefined, after: 3 },
      ]);
    });

    it("diffs sparse arrays by position, holes and length included", () => {
      expect(documentChanges({ a: new Array(1) }, { a: [] })).toEqual([
        { path: "/a/0", kind: "removed", before: undefined },
      ]);
      expect(documentChanges({ a: [, 1] }, { a: [2, 1] })).toEqual([
        { path: "/a/0", kind: "changed", before: undefined, after: 2 },
      ]);
      expect(documentChanges({ a: [1] }, { a: [1, , 3] })).toEqual([
        { path: "/a/1", kind: "added", after: undefined },
        { path: "/a/2", kind: "added", after: 3 },
      ]);
    });

    it("keeps the root and a top-level empty-string key distinct", () => {
      expect(documentChanges("x", "y")).toEqual([
        { path: "", kind: "changed", before: "x", after: "y" },
      ]);
      expect(documentChanges({ "": 1 }, { "": 2 })).toEqual([
        { path: "/", kind: "changed", before: 1, after: 2 },
      ]);
    });

    it("treats a Fabric special value as one atomic leaf", () => {
      const before = { bytes: new FabricBytes(new Uint8Array([1])) };
      const after = { bytes: new FabricBytes(new Uint8Array([2])) };
      expect(documentChanges(before, before)).toEqual([]);
      const changes = documentChanges(before, after);
      expect(changes.length).toBe(1);
      expect(changes[0].path).toBe("/bytes");
      expect(changes[0].kind).toBe("changed");
    });
  });

  describe("collectLinkPaths()", () => {
    it("finds every sigil link by path, and descends no further into one", () => {
      const doc = {
        title: "t",
        members: [sigil("of:fid1:a"), sigil("of:fid1:b")],
        wrap: { inner: sigil("of:fid1:c") },
      };
      expect(collectLinkPaths(doc)).toEqual([
        ["members", "0"],
        ["members", "1"],
        ["wrap", "inner"],
      ]);
    });
  });

  describe("evaluateFixer()", () => {
    const linkedDoc = {
      title: "t",
      members: [sigil("of:fid1:a")],
    };

    it("classifies an unchanged answer as conforming", () => {
      expect(evaluateFixer({ seed: "A" }, (d) => ({ ...d }))).toEqual({
        kind: "conforms",
      });
    });

    it("returns the changed document with its exact changes", () => {
      const outcome = evaluateFixer({ seed: "a", keep: 1 }, upperSeed);
      expect(outcome).toEqual({
        kind: "change",
        document: { seed: "A", keep: 1 },
        changes: [
          { path: "/seed", kind: "changed", before: "a", after: "A" },
        ],
      });
    });

    it("refuses a fixer that throws, naming the message", () => {
      const outcome = evaluateFixer({ seed: "a" }, () => {
        throw new Error("cannot read this shape");
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("cannot read this shape");
    });

    it("refuses an answer that is not a document", () => {
      const outcome = evaluateFixer(
        { seed: "a" },
        () => [] as unknown as Record<string, unknown>,
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("not a document");
    });

    it("refuses an answer the store cannot hold, wherever the defect sits", () => {
      const fn = evaluateFixer({ seed: "a" }, (d) => ({
        ...d,
        wrap: { deep: () => {} },
      }));
      expect(fn.kind).toBe("refused");
      if (fn.kind !== "refused") throw new Error("expected a refusal");
      expect(fn.problem).toContain("cannot hold");
      const ctor = evaluateFixer({ seed: "a" }, (d) => ({
        ...d,
        constructor: { x: 1 },
      }));
      expect(ctor.kind).toBe("refused");
      if (ctor.kind !== "refused") throw new Error("expected a refusal");
      expect(ctor.problem).toContain("cannot hold");
    });

    it("turns a classification failure into a refusal, not an escape", () => {
      // Valid at every layer admission inspects, but too deep for the
      // comparison machinery: the failure must become this row's refusal
      // rather than an exception that aborts the whole evaluation.
      let deep: Record<string, unknown> = { end: true };
      for (let index = 0; index < 200000; index += 1) deep = { next: deep };
      const outcome = evaluateFixer({ seed: "a" }, (d) => ({ ...d, deep }));
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("Classifying the fixer's answer");
    });

    it("refuses a fixer whose two runs answer differently", () => {
      let calls = 0;
      const outcome = evaluateFixer({ seed: "a" }, (d) => {
        calls += 1;
        return { ...d, stamp: calls };
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("pure function");
    });

    it("refuses an incomplete document, naming the fields the write would lose", () => {
      const outcome = evaluateFixer(
        { seed: "a", keep: 1, also: 2 },
        (d) => ({ seed: d.seed }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("/keep, /also");
    });

    it("refuses a nested field the answer lost, wherever the container survived", () => {
      const outcome = evaluateFixer(
        { meta: { author: "a", stamp: "s" }, seed: "x" },
        (d) => ({
          ...d,
          meta: { author: (d.meta as Record<string, unknown>).author },
        }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("meta/stamp");
    });

    it("refuses a field returned as an explicit undefined, which the write drops", () => {
      const outcome = evaluateFixer(
        { seed: "a", keep: 1 },
        (d) => ({ ...d, keep: undefined }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("keep");
    });

    it("treats a container replaced outright as a change, not a fragment", () => {
      const outcome = evaluateFixer(
        { wrap: { a: 1, b: 2 }, seed: "x" },
        (d) => ({ ...d, wrap: 7 }),
      );
      expect(outcome.kind).toBe("change");
      if (outcome.kind !== "change") throw new Error("expected a change");
      expect(outcome.changes).toEqual([
        { path: "/wrap", kind: "changed", before: { a: 1, b: 2 }, after: 7 },
      ]);
    });

    it("lets an array shrink, and still guards an element's own fields", () => {
      const dedup = evaluateFixer(
        { tags: ["a", "a", "b"] },
        (d) => ({ ...d, tags: [...new Set(d.tags as string[])] }),
      );
      expect(dedup.kind).toBe("change");
      const outcome = evaluateFixer(
        { rows: [{ id: 1, note: "n" }] },
        (d) => ({ ...d, rows: [{ id: 1 }] }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("rows/0/note");
      // The guard holds through a shrink too: a surviving element keeps
      // its fields even when the array behind it got shorter.
      const shrunk = evaluateFixer(
        { rows: [{ id: 1, note: "keep" }, { id: 2 }] },
        (d) => ({ ...d, rows: [{ id: 1 }] }),
      );
      expect(shrunk.kind).toBe("refused");
      if (shrunk.kind !== "refused") throw new Error("expected a refusal");
      expect(shrunk.problem).toContain("rows/0/note");
    });

    it("addresses a key containing the separator unambiguously", () => {
      const doc = { "a/b": sigil("of:fid1:slash"), seed: "x" };
      const kept = evaluateFixer(doc, (d) => ({ ...d, seed: "y" }));
      expect(kept.kind).toBe("change");
      const dropped = evaluateFixer(doc, (d) => ({
        seed: d.seed,
        "a/b": "gone",
      }));
      expect(dropped.kind).toBe("refused");
      if (dropped.kind !== "refused") throw new Error("expected a refusal");
      expect(dropped.problem).toContain("a~1b");
    });

    it("refuses a fixer that rewrites a link as a value", () => {
      const outcome = evaluateFixer(linkedDoc, (d) => ({
        ...d,
        members: ["of:fid1:a"],
      }));
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("members/0");
    });

    it("refuses a fixer that drops a link", () => {
      const outcome = evaluateFixer(linkedDoc, (d) => ({
        ...d,
        members: [],
      }));
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("members/0");
    });

    it("accepts a change beside an untouched link", () => {
      const outcome = evaluateFixer(linkedDoc, (d) => ({
        ...d,
        title: "renamed",
      }));
      expect(outcome.kind).toBe("change");
      if (outcome.kind !== "change") throw new Error("expected a change");
      expect(outcome.changes).toEqual([
        { path: "/title", kind: "changed", before: "t", after: "renamed" },
      ]);
    });

    it("refuses a fixer that replaces the container a nested link lives in", () => {
      const outcome = evaluateFixer(
        { wrap: { inner: sigil("of:fid1:c") } },
        (d) => ({ ...d, wrap: "gone" }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("wrap/inner");
    });

    it("refuses to alter a document that is itself a link", () => {
      const outcome = evaluateFixer(
        sigil("of:fid1:whole"),
        (d) => ({ ...d, extra: 1 }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("<root>");
    });

    it("carries a Fabric special value through an identity fixer untouched", () => {
      // The failure this guards: a structural clone reads a bytes value as
      // an empty shell, so an identity fixer would "return" a corrupted
      // document with an empty diff and the write would destroy the value.
      const document = { bytes: new FabricBytes(new Uint8Array([1, 2])) };
      expect(evaluateFixer(document, (d) => ({ ...d }))).toEqual({
        kind: "conforms",
      });
      const changed = evaluateFixer(document, (d) => ({
        ...d,
        bytes: new FabricBytes(new Uint8Array([9])),
      }));
      expect(changed.kind).toBe("change");
    });

    it("refuses a fixer that throws only on the probe's second run", () => {
      let calls = 0;
      const outcome = evaluateFixer({ seed: "a" }, (d) => {
        calls += 1;
        if (calls === 2) throw new Error("the second call dies");
        return { ...d };
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("the second call dies");
    });

    it("catches a fixer that reuses and mutates one answer object", () => {
      // The probe's first answer is detached before the second call, so a
      // fixer returning one closure-owned object from every call — its
      // second call mutating its first answer into agreement — compares
      // its two states, not the one object with itself.
      const shared = { n: 0 };
      const outcome = evaluateFixer({ n: 0 }, () => {
        shared.n += 2;
        return shared;
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("pure function");
    });

    it("is safe against a fixer that mutates its argument", () => {
      const document = { seed: "a" };
      const outcome = evaluateFixer(document, (d) => {
        (d as Record<string, unknown>).seed = "MUTATED";
        return d as Record<string, unknown>;
      });
      expect(outcome.kind).toBe("change");
      expect(document.seed).toBe("a");
    });
  });

  describe("repairPieces()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `bulk-repair-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    async function member(seed: string): Promise<PieceController> {
      return await pieces.create(memberProgram(), { input: { seed } });
    }

    async function seedHolder(
      members: PieceController[],
    ): Promise<PieceController> {
      const holder = await pieces.create(holderProgram(), { input: {} });
      await holder.input.set(members.map((m) => m.getCell()), ["members"]);
      await pieces.runtime.idle();
      return holder;
    }

    function collectionOf(holder: PieceController) {
      return {
        kind: "collection" as const,
        holder: holder.id,
        path: ["members"],
      };
    }

    async function rawInput(
      piece: PieceController,
    ): Promise<FabricPlainObject> {
      const cell = await piece.input.getCell();
      await cell.pull();
      const raw = cell.getRawUntyped({ lastNode: "value" });
      if (!isFabricPlainObject(raw)) {
        throw new Error("the member's stored input is not a plain object");
      }
      return raw;
    }

    it("reports the exact per-piece diff on a dry run, and writes nothing", async () => {
      const a = await member("alpha");
      const b = await member("BRAVO");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      // Both hashes computed independently from the stored documents, so
      // a wrong hash cannot certify itself.
      const hashA = hashStringOf(await rawInput(a));
      const hashB = hashStringOf(await rawInput(b));
      expect(report.rows).toEqual([
        {
          piece: a.id,
          phase: "members",
          verdict: "would-change",
          documentHash: hashA,
          changes: [
            {
              path: "/seed",
              kind: "changed",
              before: "alpha",
              after: "ALPHA",
            },
          ],
        },
        {
          piece: b.id,
          phase: "members",
          verdict: "conforms",
          documentHash: hashB,
        },
      ]);
      expect(report.applied).toBe(0);
      expect(report.complete).toBe(true);
      expect((await rawInput(a)).seed).toBe("alpha");

      // The run's record is a plan artifact: each evaluated row carries its
      // document-hash precondition and the named repair, and the codec
      // round-trips it.
      expect(report.plan.rows.map((row) => row.op)).toEqual([
        { kind: "repair", fixer: "upper-seed.ts", fixerIdentity: "impl-v1" },
        { kind: "repair", fixer: "upper-seed.ts", fixerIdentity: "impl-v1" },
      ]);
      // Computed independently from the stored document, so a wrong hash
      // cannot certify itself.
      expect(report.plan.rows[0].expect.documentHash)
        .toBe(hashStringOf(await rawInput(a)));
      expect(decodePlan(encodePlan(report.plan))).toEqual(report.plan);
    });

    it("preflights every row, and a moved one keeps the run from starting", async () => {
      const a = await member("ALPHA");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      // Something other than the plan changes the SECOND piece's document:
      // preflight must find it before the first piece is written, so the
      // run does not start and every row reports its classification.
      await b.input.set("altered", ["seed"]);
      await pieces.runtime.idle();

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: dry.plan,
        apply: true,
      });
      expect(report.rows.map((row) => row.verdict)).toEqual([
        "conforms",
        "moved",
      ]);
      expect(report.rows[1].problem).toContain(
        "something other than this plan",
      );
      expect(report.applied).toBe(0);
      expect((await rawInput(a)).seed).toBe("ALPHA");
    });

    it("reclassifies a no-write decision from a fresh read before reporting it", async () => {
      const b = await member("bravo");
      const a = await member("ALPHA");
      // The piece conforms when the transaction reads it, so nothing is
      // written and nothing is conflict-checked; a concurrent writer then
      // changes it before the verification re-read. The row must come back
      // as the work it now is — never as a conformity that would make the
      // report read complete.
      let editDone = false;
      let mutated = false;
      const wrapController = (controller: PieceController) =>
        new Proxy(controller, {
          get(c, prop, receiver) {
            if (prop !== "input") {
              const value = Reflect.get(c, prop, receiver);
              return typeof value === "function" ? value.bind(c) : value;
            }
            const input = c.input;
            return new Proxy(input, {
              get(i, p, r) {
                if (p === "edit") {
                  return async (
                    ...args: Parameters<typeof input.edit>
                  ) => {
                    const result = await input.edit(...args);
                    editDone = true;
                    return result;
                  };
                }
                if (p === "getCell") {
                  return async () => {
                    if (editDone && !mutated) {
                      mutated = true;
                      await a.input.set("shifted", ["seed"]);
                      await pieces.runtime.idle();
                    }
                    return input.getCell();
                  };
                }
                const value = Reflect.get(i, p, r);
                return typeof value === "function" ? value.bind(i) : value;
              },
            });
          },
        });
      const racing = new Proxy(pieces, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return async (id: string, run?: boolean) =>
              wrapController(await target.get(id, run));
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const report = await repairPieces(racing as never, {
        selector: { kind: "list", pieces: [a.id, b.id] },
        fixer: upperSeed,
        apply: true,
      });
      // The raced row stops the run: plan order is a correctness
      // constraint, so the later row must not land while this one is
      // outstanding.
      expect(report.rows.map((row) => row.verdict)).toEqual([
        "would-change",
        "unattempted",
      ]);
      expect(report.applied).toBe(0);
      expect(report.complete).toBe(false);
      expect((await rawInput(b)).seed).toBe("bravo");
    });

    it("leaves when the row reporter throws, rather than reporting the piece twice", async () => {
      // The reporter is handed a row that has already settled. If its own
      // failure were classified like an unreachable piece or a refused
      // write, the same piece would appear twice in one report under two
      // verdicts, the second contradicting what the caller was just told.
      const a = await member("alpha");
      const b = await member("bravo");
      const seen: string[] = [];
      let failure: unknown;
      const report = await repairPieces(pieces, {
        selector: { kind: "list", pieces: [a.id, b.id] },
        fixer: upperSeed,
        apply: true,
        onRow: (row) => {
          seen.push(row.piece);
          throw new Error("the reporter gave up");
        },
      }).catch((error: unknown) => {
        failure = error;
        return undefined;
      });

      // One row reached the caller, and the run left rather than carrying on.
      expect(seen).toEqual([a.id]);
      expect((failure as Error | undefined)?.message).toBe(
        "the reporter gave up",
      );
      expect(report).toBeUndefined();
    });

    it("reports what the store returned after the write, not the fixer's answer", async () => {
      const a = await member("alpha");
      // The write path is free to normalize what it stores — schema-default
      // hydration is the measured case — so an applied row's changes must
      // be read back from the store. The verification read is intercepted
      // to answer with a field the fixer never produced, standing in for
      // exactly that normalization.
      let editDone = false;
      const wrapController = (controller: PieceController) =>
        new Proxy(controller, {
          get(c, prop, receiver) {
            if (prop !== "input") {
              const value = Reflect.get(c, prop, receiver);
              return typeof value === "function" ? value.bind(c) : value;
            }
            const input = c.input;
            return new Proxy(input, {
              get(i, p, r) {
                if (p === "edit") {
                  return async (
                    ...args: Parameters<typeof input.edit>
                  ) => {
                    const result = await input.edit(...args);
                    editDone = true;
                    return result;
                  };
                }
                if (p === "getCell") {
                  return async () => {
                    const cell = await input.getCell();
                    if (!editDone) return cell;
                    return new Proxy(cell, {
                      get(target, cellProp, cellReceiver) {
                        if (cellProp === "getRaw") {
                          return (
                            ...raw: Parameters<typeof cell.getRaw>
                          ) => ({
                            ...(cell.getRaw(...raw) as Record<
                              string,
                              unknown
                            >),
                            hydrated: "by-the-store",
                          });
                        }
                        const value = Reflect.get(
                          target,
                          cellProp,
                          cellReceiver,
                        );
                        return typeof value === "function"
                          ? value.bind(target)
                          : value;
                      },
                    });
                  };
                }
                const value = Reflect.get(i, p, r);
                return typeof value === "function" ? value.bind(i) : value;
              },
            });
          },
        });
      const hydrating = new Proxy(pieces, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return async (id: string, run?: boolean) =>
              wrapController(await target.get(id, run));
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const report = await repairPieces(hydrating as never, {
        selector: { kind: "list", pieces: [a.id] },
        fixer: upperSeed,
        apply: true,
      });
      expect(report.rows[0].verdict).toBe("repaired");
      expect(report.rows[0].changes).toEqual([
        { path: "/seed", kind: "changed", before: "alpha", after: "ALPHA" },
        { path: "/hydrated", kind: "added", after: "by-the-store" },
      ]);
    });

    it("refuses an empty fixer name before reading anything", async () => {
      await expect(
        repairPieces(pieces, {
          selector: { kind: "list", pieces: ["fid1:never-read"] },
          fixer: upperSeed,
          fixerName: "",
        }),
      ).rejects.toThrow("must be nonempty");
    });

    it("reports a preflight read failure and starts nothing", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      // The connection to the second piece drops after the survey read it:
      // its preflight read fails, so the run must not start, and the first
      // piece keeps its classification rather than being written.
      let bGets = 0;
      const flaky = new Proxy(pieces, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return (id: string, run?: boolean) => {
              if (id === b.id && ++bGets >= 2) {
                // A bare string, deliberately: failures are not all Errors,
                // and the report must carry this one's text too.
                return Promise.reject("the connection dropped");
              }
              return target.get(id, run);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const report = await repairPieces(flaky as never, {
        selector: { kind: "list", pieces: [a.id, b.id] },
        fixer: upperSeed,
        apply: true,
      });
      expect(report.rows.map((row) => row.verdict)).toEqual([
        "would-change",
        "failed",
      ]);
      expect(report.rows[1].problem).toContain("the run did not start");
      expect(report.applied).toBe(0);
      expect((await rawInput(a)).seed).toBe("alpha");
    });

    it("classifies a non-document beside the rest when the run cannot start", async () => {
      const scalarProgram: RuntimeProgram = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<string>((text) => ({",
            "  [NAME]: 'Scalar',",
            "  text,",
            "}));",
            "",
          ].join("\n"),
        }],
      };
      const scalar = await pieces.create(scalarProgram, {
        input: "not a document" as never,
      });
      const a = await member("alpha");

      const report = await repairPieces(pieces, {
        selector: { kind: "list", pieces: [scalar.id, a.id] },
        fixer: upperSeed,
        apply: true,
      });
      expect(report.rows.map((row) => row.verdict)).toEqual([
        "refused",
        "would-change",
      ]);
      expect(report.rows[0].problem).toContain("not a document");
      expect(report.applied).toBe(0);
    });

    it("stops on a move that lands between preflight and the row's transaction", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      // Preflight sees both rows clean; a concurrent writer then moves the
      // second piece before its transaction. The wrapper performs that
      // write when the serial pass fetches the piece — after preflight, so
      // this is exactly the window the transactional recheck exists for.
      let gets = 0;
      const racing = new Proxy(pieces, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return async (id: string, run?: boolean) => {
              // The survey fetches the piece once and preflight once; the
              // serial pass's fetch is the third, and the concurrent write
              // lands there — after preflight passed this row clean.
              if (id === b.id && ++gets === 3) {
                await b.input.set("shifted", ["seed"]);
                await target.runtime.idle();
              }
              return target.get(id, run);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const report = await repairPieces(racing as never, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: dry.plan,
        apply: true,
      });
      expect(report.rows.map((row) => row.verdict)).toEqual([
        "repaired",
        "moved",
      ]);
      expect(report.applied).toBe(1);
      expect((await rawInput(b)).seed).toBe("shifted");
    });

    it("resumes a completed plan: every landed row conforms, whatever it hashes to", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      const first = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: dry.plan,
        apply: true,
      });
      expect(first.rows.map((row) => row.verdict)).toEqual([
        "repaired",
        "repaired",
      ]);

      const again = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: dry.plan,
        apply: true,
      });
      expect(again.rows.map((row) => row.verdict)).toEqual([
        "conforms",
        "conforms",
      ]);
      expect(again.applied).toBe(0);
      expect(again.complete).toBe(true);
    });

    it("executes the supplied plan's rows exactly, in the plan's order", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      const reversed = {
        header: dry.plan.header,
        rows: [...dry.plan.rows].reverse(),
      };
      // The proof of serial order is what the store holds mid-run, not the
      // report's ordering: when the second-planned piece is fetched for
      // its own write, the first-planned one has already landed.
      let aSerialGets = 0;
      let bSeedAtASerialFetch: unknown;
      const observing = new Proxy(pieces, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return async (id: string, run?: boolean) => {
              if (id === a.id && ++aSerialGets === 3) {
                const cell = await (await target.get(b.id, false)).input
                  .getCell();
                await cell.pull();
                bSeedAtASerialFetch =
                  (cell.getRaw({ lastNode: "value" }) as { seed?: unknown })
                    .seed;
              }
              return target.get(id, run);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const report = await repairPieces(observing as never, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: reversed,
        apply: true,
      });
      expect(report.rows.map((row) => row.piece)).toEqual([b.id, a.id]);
      expect(bSeedAtASerialFetch).toBe("BRAVO");

      const truncated = {
        header: dry.plan.header,
        rows: dry.plan.rows.slice(1),
      };
      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          fixerIdentity: "impl-v1",
          plan: truncated,
          apply: true,
        }),
      ).rejects.toThrow("the selection holds pieces the plan does not name");
    });

    it("catches an unholdable answer at preflight, before anything lands", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        // Valid for the first piece, unholdable for the second: without
        // the admission check in preflight, the first repair would land
        // before the second row failed at its write.
        fixer: (d) =>
          d.seed === "bravo"
            ? { ...d, wrap: { deep: () => {} } } as never
            : { ...d, seed: (d.seed as string).toUpperCase() },
        apply: true,
      });

      expect(report.rows.map((row) => row.verdict)).toEqual([
        "would-change",
        "refused",
      ]);
      expect(report.rows[1].problem).toContain("cannot hold");
      expect(report.applied).toBe(0);
      expect((await rawInput(a)).seed).toBe("alpha");
    });

    it("refuses an incomplete supplied plan instead of laundering it", async () => {
      const a = await member("alpha");
      const holder = await seedHolder([a]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          fixerIdentity: "impl-v1",
          plan: {
            header: {
              ...dry.plan.header,
              problems: [{ piece: "fid1:x", problem: "unreadable" }],
            },
            rows: dry.plan.rows,
          },
          apply: true,
        }),
      ).rejects.toThrow("incomplete plan");
      expect((await rawInput(a)).seed).toBe("alpha");
    });

    it("holds an in-memory plan to the codec's invariants", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      // A repair row stripped of its document hash: the codec would refuse
      // this at decode, and the executor must refuse it the same way
      // rather than writing unconditionally.
      const hashless = {
        header: dry.plan.header,
        rows: dry.plan.rows.map((row) => ({
          ...row,
          expect: { ...row.expect, documentHash: undefined },
        })),
      };
      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          fixerIdentity: "impl-v1",
          plan: hashless as never,
          apply: true,
        }),
      ).rejects.toThrow("row 1");
      expect((await rawInput(a)).seed).toBe("alpha");

      // A duplicated row would execute its piece twice.
      const doubled = {
        header: dry.plan.header,
        rows: [dry.plan.rows[0], ...dry.plan.rows],
      };
      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          fixerIdentity: "impl-v1",
          plan: doubled,
          apply: true,
        }),
      ).rejects.toThrow("more than once");

      // A plan without the run's fixerName cannot be held against the
      // fixer actually run.
      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          plan: dry.plan,
          apply: true,
        }),
      ).rejects.toThrow("needs the run's fixerName");
    });

    it("emits an artifact a stopped run can be resumed from", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      // Move the second piece so the plan-driven apply blocks at preflight.
      const original = (await rawInput(b)).seed;
      await b.input.set("shifted", ["seed"]);
      await pieces.runtime.idle();
      const blocked = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: dry.plan,
        apply: true,
      });
      expect(blocked.applied).toBe(0);
      // Every artifact row still carries its precondition and operation —
      // the blocked run's plan is suppliable straight back.
      expect(
        blocked.plan.rows.every((row) =>
          row.op?.kind === "repair" &&
          row.expect.documentHash !== undefined
        ),
      ).toBe(true);

      // The operator puts the moved piece back; the blocked artifact then
      // completes the run it recorded.
      await b.input.set(original, ["seed"]);
      await pieces.runtime.idle();
      const resumed = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: blocked.plan,
        apply: true,
      });
      expect(resumed.rows.map((row) => row.verdict)).toEqual([
        "repaired",
        "repaired",
      ]);
      expect(resumed.complete).toBe(true);
    });

    it("refuses to gate against a zero-row plan", () => {
      // The gate holds rows to a fixer; a plan with none would pass every
      // check vacuously, which is exactly the bypass this refusal closes.
      expect(() =>
        assertPlanRunsFixer(
          {
            header: {
              kind: "piece-plan",
              v: 1,
              space: "did:key:test",
              takenAt: "2026-08-25T00:00:00.000Z",
              selector: "collection",
              enumerated: { collection: 0, registry: 0, registeredOutside: 0 },
            },
            rows: [],
          },
          "upper-seed.ts",
          "impl-v1",
        )
      ).toThrow("pins no fixer");
    });

    it("pins the fixer implementation, not its name", async () => {
      const a = await member("alpha");
      const holder = await seedHolder([a]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });
      expect(dry.plan.rows[0].op).toEqual({
        kind: "repair",
        fixer: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });
      expect(decodePlan(encodePlan(dry.plan))).toEqual(dry.plan);

      // The same name over a different implementation is exactly what the
      // pin exists to refuse.
      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          fixerIdentity: "impl-v2",
          plan: dry.plan,
          apply: true,
        }),
      ).rejects.toThrow("different fixer implementation");
      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          plan: dry.plan,
          apply: true,
        }),
      ).rejects.toThrow("travel together");
      expect((await rawInput(a)).seed).toBe("alpha");

      const applied = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
        plan: dry.plan,
        apply: true,
      });
      expect(applied.rows[0].verdict).toBe("repaired");
    });

    it("refuses a plan that disagrees with the run", async () => {
      const a = await member("alpha");
      const holder = await seedHolder([a]);
      const dry = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        fixerName: "upper-seed.ts",
        fixerIdentity: "impl-v1",
      });

      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          fixerIdentity: "impl-v1",
          plan: {
            header: { ...dry.plan.header, space: "did:key:somewhere-else" },
            rows: dry.plan.rows,
          },
          apply: true,
        }),
      ).rejects.toThrow("names space");

      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "other-fixer.ts",
          fixerIdentity: "impl-v1",
          plan: dry.plan,
          apply: true,
        }),
      ).rejects.toThrow("different fixer");

      const opless = {
        header: dry.plan.header,
        rows: dry.plan.rows.map((row) => ({
          piece: row.piece,
          ...(row.phase === undefined ? {} : { phase: row.phase }),
          expect: row.expect,
        })),
      };
      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          fixerName: "upper-seed.ts",
          fixerIdentity: "impl-v1",
          plan: opless,
          apply: true,
        }),
      ).rejects.toThrow("no repair operation");
    });

    it("returns a failed row, state-checked, when the write path refuses", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        // The answer breaks the piece's own input schema, so the write path
        // refuses it — an operational failure the report must carry rather
        // than escape with.
        selector: collectionOf(holder),
        fixer: (d) => ({ ...d, seed: 7 }),
        apply: true,
      });

      expect(report.rows.map((row) => row.verdict)).toEqual([
        "failed",
        "unattempted",
      ]);
      expect(report.rows[0].problem).toContain("schema");
      expect(report.rows[0].problem).toContain("still needs the repair");
      expect(report.applied).toBe(0);
      expect((await rawInput(a)).seed).toBe("alpha");
      // Exactly one artifact row per piece, whatever went wrong: the
      // emitted plan still satisfies the codec.
      expect(() => decodePlan(encodePlan(report.plan))).not.toThrow();
      expect(report.plan.rows.length).toBe(2);
    });

    it("does not repair the holder's own row on a collection selector", async () => {
      const a = await member("ALPHA");
      const holder = await seedHolder([a]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        // A fixer the holder's document would fail loudly: it returns only
        // the members' own field, so touching the holder would refuse the
        // run as an incomplete document.
        fixer: (d) => ({ seed: d.seed }),
      });

      expect(report.rows.map((row) => row.piece)).toEqual([a.id]);
    });

    it("applies serially, verifies by re-asking the fixer, and a re-run writes nothing", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const applied = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        apply: true,
      });
      expect(applied.rows.map((row) => row.verdict)).toEqual([
        "repaired",
        "repaired",
      ]);
      expect(applied.applied).toBe(2);
      expect(applied.complete).toBe(true);
      expect((await rawInput(a)).seed).toBe("ALPHA");
      expect((await rawInput(b)).seed).toBe("BRAVO");

      const again = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        apply: true,
      });
      expect(again.rows.map((row) => row.verdict)).toEqual([
        "conforms",
        "conforms",
      ]);
      expect(again.applied).toBe(0);
    });

    it("carries links through a repair that does not mention them", async () => {
      const a = await member("alpha");
      const holder = await seedHolder([a]);
      await holder.input.set("untitled", ["title"]);
      await pieces.runtime.idle();
      const before = await rawInput(holder);

      const report = await repairPieces(pieces, {
        selector: { kind: "list", pieces: [holder.id] },
        fixer: (d) => ({ ...d, title: "repaired" }),
        apply: true,
      });
      expect(report.rows[0].verdict).toBe("repaired");

      const after = await rawInput(holder);
      expect(after.title).toBe("repaired");
      expect(after.members).toEqual(before.members);
      // The strongest proof the link survived: the collection still
      // resolves its member through it.
      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });
      expect(survey.complete).toBe(true);
      expect(survey.plan.rows.map((row) => row.piece)).toContain(a.id);
    });

    it("keeps the run from starting on a preflight refusal, every row classified", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const c = await member("charlie");
      const holder = await seedHolder([a, b, c]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: (d) => {
          if (d.seed === "bravo") throw new Error("this one is beyond me");
          return { ...d, seed: (d.seed as string).toUpperCase() };
        },
        apply: true,
      });

      // Preflight classifies all three before anything is written, finds
      // the refusal, and the run does not start: nothing applied, and the
      // rows around the refusal keep their classifications rather than
      // reading as unattempted.
      expect(report.rows.map((row) => row.verdict)).toEqual([
        "would-change",
        "refused",
        "would-change",
      ]);
      expect(report.rows[1].problem).toContain("this one is beyond me");
      expect(report.applied).toBe(0);
      expect(report.complete).toBe(false);
      expect((await rawInput(a)).seed).toBe("alpha");
      expect((await rawInput(c)).seed).toBe("charlie");
    });

    it("refuses a piece whose stored input is not a document", async () => {
      // A pattern may type its whole input as a scalar, and such a piece
      // stores one — a state a document repair must refuse, not reshape.
      const scalarProgram: RuntimeProgram = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<string>((text) => ({",
            "  [NAME]: 'Scalar',",
            "  text,",
            "}));",
            "",
          ].join("\n"),
        }],
      };
      const a = await pieces.create(scalarProgram, {
        input: "just a string" as never,
      });

      const report = await repairPieces(pieces, {
        selector: { kind: "list", pieces: [a.id] },
        fixer: upperSeed,
      });

      expect(report.rows).toEqual([
        {
          piece: a.id,
          phase: "list",
          verdict: "refused",
          problem: "The stored input is not a document.",
        },
      ]);
      expect(report.complete).toBe(false);
    });

    it("fails a pure but non-idempotent fixer at verification, and stops", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        // Pure — one document always answers one way — but its own answer
        // never satisfies it, so the post-write verification cannot pass.
        fixer: (d) => ({ ...d, seed: `${d.seed}X` }),
        apply: true,
      });

      expect(report.rows.map((row) => row.verdict)).toEqual([
        "failed",
        "unattempted",
      ]);
      expect(report.rows[0].problem).toContain("does not satisfy the fixer");
      expect(report.applied).toBe(1);
      expect(report.complete).toBe(false);
      expect((await rawInput(b)).seed).toBe("bravo");
    });

    it("says the state is unknown when the failed piece cannot be re-read", async () => {
      const a = await member("alpha");
      const holder = await seedHolder([a]);
      // The connection drops between the failed write and the state check:
      // once the fixer has run (so selection and the row's own read are
      // done), every further load of the piece fails. The wrapper delegates
      // everything else, bound so the controller's private state still
      // works.
      let armed = false;
      const flaky = new Proxy(pieces, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return (id: string, run?: boolean) => {
              if (armed && id === a.id) {
                return Promise.reject(new Error("the connection dropped"));
              }
              return target.get(id, run);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const report = await repairPieces(flaky as never, {
        selector: collectionOf(holder),
        fixer: (d) => {
          armed = true;
          // The answer breaks the schema, so the write path refuses it and
          // the state check is what runs next.
          return { ...d, seed: 7 };
        },
        apply: true,
      });

      expect(report.rows.map((row) => row.verdict)).toEqual(["failed"]);
      expect(report.rows[0].problem).toContain("state is unknown");
    });

    it("reports every refusal on a dry run instead of stopping", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: () => {
          throw new Error("refuses everything");
        },
      });

      expect(report.rows.map((row) => row.verdict)).toEqual([
        "refused",
        "refused",
      ]);
      expect(report.complete).toBe(false);
      expect(report.applied).toBe(0);
    });

    it("refuses to repair over an incomplete selection, naming the orphan", async () => {
      const { commonfabric } = createBuilder();
      const { handler, pattern } = commonfabric;
      const addPiece = handler<
        { piece: BuilderCell<unknown> },
        { pieceRegistry: BuilderCell<BuilderCell<unknown>[]> }
      >(
        true,
        {
          type: "object",
          properties: { pieceRegistry: { type: "array", asCell: ["cell"] } },
        },
        ({ piece }, { pieceRegistry }) => {
          pieceRegistry.push(piece);
        },
      );
      const defaultPattern = pattern<{ pieceRegistry: BuilderCell<unknown>[] }>(
        ({ pieceRegistry }) => ({
          pieceRegistry,
          addPiece: addPiece({ pieceRegistry }),
        }),
      );
      const home = await pieces.runPersistent(
        defaultPattern,
        { pieceRegistry: [] },
        "bulk-repair-default-pattern",
      );
      await pieces.linkDefaultPattern(home);
      await pieces.runtime.idle();
      await pieces.synced();

      const inBoard = await member("alpha");
      const orphan = await member("omega");
      await pieces.add([orphan.getCell()]);
      const holder = await seedHolder([inBoard]);

      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          apply: true,
        }),
      ).rejects.toThrow("registered outside the selection");
      expect((await rawInput(inBoard)).seed).toBe("alpha");
    });
  });
});
