import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { RuntimeProgram } from "@commonfabric/runner";
import { assertPatternSchemasBackwardCompatible } from "../src/schema-compatibility.ts";
import {
  materializeOver,
  openFileBackedRuntime,
  readVintageArgument,
  vintageArgumentLink,
  vintageRoot,
  type VintageRuntime,
} from "./state-continuity-harness.ts";

/**
 * Tier 2: replay a captured prior state under a NEW pattern version.
 *
 * Shape of each case: capture a real space written by the OLD pattern,
 * snapshot it, then open a fresh runtime over that snapshot and materialize
 * the NEW pattern onto the same root through the production repair call.
 *
 * Where the line with Tier 1 falls — measured, and pinned by the last case
 * here so neither tier is dropped on a wrong assumption about the other:
 *
 * - Additive REQUIRED output with no default: accepted by both tiers because
 *   the new pattern generates that result during setup. Tier 1 accepts the
 *   output contract, and the runner's role-aware CFC merge accepts the write
 *   that materializes it over the legacy root. Replaying it here pins the whole
 *   capture → snapshot → reopen → materialize pipeline.
 * - Moving where a field is STORED under an identical contract: this tier
 *   only. The two result schemas are byte-identical, so no contract check can
 *   see it, and nothing throws — the data is simply gone. What a pattern
 *   writes is not determined by its schema.
 * - Typing a key on an OPEN argument object: shared with the runner, and for a
 *   sharper reason than the one above. Tier 1 does not fail to see it — it
 *   WAIVES it, on the ground that the runner validates merged durable arguments
 *   in the setup transaction. That guard is real and reached on both update
 *   routes (`runtime/runner/test/pattern-update-argument-validation.test.ts`);
 *   what this tier adds is driving it from a vintage a real prior version
 *   wrote, so the waiver is checked against a captured argument rather than an
 *   in-process one.
 *
 * Nothing else on the obvious list earns a case here. Dropping a result field,
 * narrowing one to a disjoint type, and moving a field between nesting levels
 * are all contract changes Tier 1 rejects outright ("existing result field was
 * removed", "type … is not accepted by the candidate schema" — a nesting move
 * reports as a removal). Adding cases for them would grow the slowest tier
 * without covering anything the fastest one misses.
 */

const signer = await Identity.fromPassphrase("state continuity vintage");

/**
 * The vintage carries a CFC-labeled field, which is what makes its root doc
 * store a CFC schema envelope. That envelope is the thing a later version's
 * schema has to MERGE with. The merge remains strict for input and unclassified
 * document evolution, but an output-role write may introduce required fields
 * because the candidate pattern generates their values in the same setup.
 * Real system roots (home, profile) are CFC-relevant, so this models them
 * rather than working around them.
 *
 * A CONFIDENTIALITY label is deliberate: it makes the doc CFC-relevant without
 * imposing a write requirement. An ownership label (`ownerPrincipal`) would
 * also work, but its writes must carry matching `represents-principal`
 * integrity, so every case here would fail on the authorization check before
 * ever reaching the schema merge — green or red for the wrong reason.
 */
const CFC_PRELUDE = [
  "import { Confidential, Default, Writable, pattern } from 'commonfabric';",
  "const OWNER_ATOM = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'StateContinuityVintage',",
  "  subject: 'did:example:state-continuity',",
  "} as const;",
  "type VintageLabel = readonly [typeof OWNER_ATOM];",
];

/** The vintage: no `favorites` field at all, so a doc it writes has no value. */
const OLD_WITHOUT_FAVORITES: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('items');",
      "  return { owner, items };",
      "});",
      "",
    ].join("\n"),
  }],
};

/**
 * `favorites` is additive, required, and has no schema default. The candidate
 * pattern generates its backing Writable during setup, so this is compatible
 * output evolution.
 */
const NEW_GENERATED_REQUIRED: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "  favorites: Writable<string[]>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('items');",
      "  const favorites = new Writable<string[]>([]).for('favorites');",
      "  return { owner, items, favorites };",
      "});",
      "",
    ].join("\n"),
  }],
};

/** The fix: identical, except `favorites` rides `Default<[]>`. */
const NEW_DEFAULTED: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "  favorites: Writable<string[] | Default<[]>>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('items');",
      "  const favorites = new Writable<string[]>([]).for('favorites');",
      "  return { owner, items, favorites };",
      "});",
      "",
    ].join("\n"),
  }],
};

/**
 * Same declared contract, different STORAGE. `items` is backed by
 * `.for('itemList')` instead of `.for('items')`, so the result schema is
 * byte-identical to the vintage's while the data the vintage wrote is no
 * longer where this version looks. Nothing in a contract comparison can see
 * this; only a document can.
 */
const RENAMED_STORAGE_KEY: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('itemList');",
      "  return { owner, items };",
      "});",
      "",
    ].join("\n"),
  }],
};

/**
 * The argument-side vintage: an OPEN argument object, which is what lets the
 * old version store `count` as a string legally.
 *
 * No CFC label here, unlike the result-side fixtures above, and that is the
 * point rather than an oversight: the CFC envelope exists to give the RESULT
 * schema something to merge against. An argument travels the runner's setup
 * validation instead, so a label would add a second mechanism to a case that
 * is about the first one.
 *
 * `[key: string]: any` is load-bearing. `Record<string, unknown>` does NOT
 * produce an open object — `unknown` maps to `{type:"unknown"}`, so
 * `additionalProperties` comes out non-boolean and Tier 1's evolution
 * allowance (which requires a boolean) never applies.
 */
const OLD_OPEN_ARGUMENT: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { Writable, pattern } from 'commonfabric';",
      "interface Args { [key: string]: any }",
      "interface Output { items: Writable<string[]>; }",
      "export default pattern<Args, Output>(() => {",
      "  const items = new Writable<string[]>([]).for('items');",
      "  return { items };",
      "});",
      "",
    ].join("\n"),
  }],
};

/**
 * Same open object, but `count` is now a NAMED optional number — the shape
 * Tier 1 waves through on the documented promise that the runner will validate
 * merged durable arguments against it.
 */
const NEW_TYPES_THE_ARGUMENT_KEY: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { Writable, pattern } from 'commonfabric';",
      "interface Args { count?: number; [key: string]: any }",
      "interface Output { items: Writable<string[]>; }",
      "export default pattern<Args, Output>(() => {",
      "  const items = new Writable<string[]>([]).for('items');",
      "  return { items };",
      "});",
      "",
    ].join("\n"),
  }],
};

interface Captured {
  snapshot: string;
  dir: string;
}

describe("pattern update over captured prior state", () => {
  let dirs: string[] = [];
  let open: VintageRuntime[] = [];

  const tempDir = async (prefix: string) => {
    const dir = await Deno.makeTempDir({ prefix });
    dirs.push(dir);
    return dir;
  };

  const openRuntime = async (dir: string, fromSnapshot?: string) => {
    const vintage = await openFileBackedRuntime(signer, dir, fromSnapshot);
    open.push(vintage);
    return vintage;
  };

  beforeEach(() => {
    dirs = [];
    open = [];
  });

  afterEach(async () => {
    // Tear everything down first, THEN surface what went wrong. A vintage owns
    // a memory server — SQLite engines, a read pool, a refresh timer — and
    // `dispose()` failing means those outlived the case. Swallowing that would
    // hide the very leak `dispose()` exists to close, and leave the next case
    // to fail on a symptom instead. Every vintage still gets its turn: one
    // broken teardown must not strand the rest.
    const teardown: unknown[] = [];
    for (const vintage of open) {
      try {
        await vintage.dispose();
      } catch (error) {
        teardown.push(error);
      }
    }
    // Temp-dir removal stays best-effort: it is the OS's business, not the
    // runtime's, and a failure here says nothing about the code under test.
    for (const dir of dirs) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    if (teardown.length > 0) {
      throw new AggregateError(teardown, "vintage teardown failed");
    }
  });

  /**
   * Write a space with `program`, populate it, and snapshot it.
   *
   * `argument`, when given, is stored in the root's durable ARGUMENT document
   * — the other half of what a pattern update has to preserve.
   */
  async function capture(
    program: RuntimeProgram,
    items: string[],
    argument?: Record<string, unknown>,
  ): Promise<Captured> {
    const dir = await tempDir("continuity-capture-");
    const vintage = await openRuntime(dir);
    // Materialize through the SAME call the replay uses. Not tidiness: a
    // pattern's owned cells (`.for('items')`) are addressed off the pattern
    // instance, so a capture that allocated them by a different route would
    // hand the replay a root whose keys resolve to docs it never wrote — the
    // fixture would look empty and every continuity assertion would fail for a
    // reason that has nothing to do with the pattern being tested.
    const materialized = await materializeOver(vintage, program);
    expect(
      materialized.error,
      "capture could not materialize the vintage pattern onto an empty space",
    ).toBeUndefined();

    // Populate: this is the state the new version has to keep reachable.
    // Address the root through the schema of the pattern that was actually
    // materialized, so the write cannot land on a shape nobody ran.
    const root = vintageRoot<Record<string, unknown>>(
      vintage,
      materialized.resultSchema,
    );
    // `editWithRetry`, not a bare `edit()`, and the result is CHECKED: this
    // write races the tail of the materialize above on the same documents, and
    // `commit()` REPORTS a conflict in its result rather than throwing. An
    // unread result buys a snapshot that silently lacks the very state the tier
    // exists to replay — every downstream case then fails on an empty read,
    // several layers away from the cause.
    const { error: writeError } = await vintage.runtime.editWithRetry((tx) => {
      (root.withTx(tx).key("items") as { set: (v: string[]) => void }).set(
        items,
      );
    });
    expect(
      writeError?.message,
      "capture could not write the vintage's prior state",
    ).toBeUndefined();

    if (argument !== undefined) {
      const link = await vintageArgumentLink(
        vintage,
        materialized.resultSchema,
      );
      // Written schema-LESS, which is how the vintage's own open argument
      // object accepts it. Writing it under the new candidate's schema would
      // beg the question the case asks.
      const { error: argError } = await vintage.runtime.editWithRetry((tx) => {
        vintage.runtime.getCellFromLink(link, undefined, tx)
          .asSchema(undefined as never)
          .set(argument as never);
      });
      expect(
        argError?.message,
        "capture could not write the vintage's durable argument",
      ).toBeUndefined();
    }
    await vintage.runtime.idle();

    const snapshot = `${dir}/vintage.sqlite`;
    await vintage.snapshot(snapshot);
    return { snapshot, dir };
  }

  /**
   * Open a fresh runtime over `captured`, materialize `program` on it, and
   * hand back the runtime as well — for reads that go beyond the root value.
   */
  async function replayOn(captured: Captured, program: RuntimeProgram) {
    const dir = await tempDir("continuity-replay-");
    const vintage = await openRuntime(dir, captured.snapshot);
    return { vintage, outcome: await materializeOver(vintage, program) };
  }

  /** Open a fresh runtime over `captured` and materialize `program` on it. */
  async function replay(captured: Captured, program: RuntimeProgram) {
    return (await replayOn(captured, program)).outcome;
  }

  it("captures a real space and reads its state back from the snapshot", async () => {
    // The mechanism itself: a snapshot must be a faithful, reopenable space.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    expect(Deno.statSync(captured.snapshot).size).toBeGreaterThan(0);

    const result = await replay(captured, OLD_WITHOUT_FAVORITES);
    expect(result.error).toBeUndefined();
    expect(
      result.value?.items,
      "the snapshot did not round-trip: the SAME pattern replayed over the " +
        "captured space cannot see the state that space was captured holding, " +
        "so capture, snapshot or restore is broken — not any pattern change",
    ).toEqual(["alpha", "beta"]);
  });

  it("keeps prior state reachable when the new field carries a default", async () => {
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    const result = await replay(captured, NEW_DEFAULTED);

    expect(result.error).toBeUndefined();
    // The point of the tier: the data the OLD version wrote survives.
    expect(
      result.value?.items,
      "adding a DEFAULTED field lost the prior version's data — a regression " +
        "in update continuity, not in this test's fixture (the round-trip " +
        "case proves the same snapshot reads back under the old pattern)",
    ).toEqual(["alpha", "beta"]);
    expect(
      result.value?.favorites,
      "the new field did not materialize from its Default<[]>",
    ).toEqual([]);
  });

  it("materializes an additive REQUIRED output over a vintage doc", async () => {
    // `favorites` did not exist in the captured program or document. The new
    // program returns a Writable for it during setup, so the result role makes
    // this compatible even though the result schema has no default.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    const result = await replay(captured, NEW_GENERATED_REQUIRED);

    expect(result.error).toBeUndefined();
    expect(result.value?.items).toEqual(["alpha", "beta"]);
    expect(
      result.value?.favorites,
      "the new pattern did not generate its newly required result",
    ).toEqual([]);
  });

  it("strands prior state when the storage key moves under an IDENTICAL schema", async () => {
    // The class that is Tier 2's alone, and the reason this tier exists.
    //
    // `RENAMED_STORAGE_KEY` differs from the vintage only in which cell backs
    // `items` — `.for('items')` became `.for('itemList')`. The declared
    // contract is untouched: the two result schemas are BYTE-IDENTICAL
    // (asserted below). Tier 1 compares contracts, so there is nothing there
    // for it to see, and no amount of strengthening the schema check would
    // change that: what a pattern WRITES is not determined by its schema.
    //
    // Nothing throws, either. The materialize succeeds and the piece runs —
    // it just quietly reads a cell nobody ever wrote, and the user's data is
    // gone. Silence is what makes this class worth a gate.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);

    // The control belongs INSIDE this case, not in the round-trip case above.
    // `items === []` is also what a fixture that was never restored reads back,
    // so on its own the assertion below cannot tell "the rename stranded the
    // data" from "there was no data" — measured: no-op the restore and this
    // case stays green while every other case here goes red. Replaying the
    // VINTAGE over the SAME snapshot first is what makes the emptiness a
    // property of the rename.
    const control = await replay(captured, OLD_WITHOUT_FAVORITES);
    expect(control.error).toBeUndefined();
    expect(
      control.value?.items,
      "CONTROL failed, so the case below proves nothing: the vintage itself " +
        "cannot read the captured state, which means the fixture is broken " +
        "rather than the rename stranding anything",
    ).toEqual(["alpha", "beta"]);

    const result = await replay(captured, RENAMED_STORAGE_KEY);
    expect(result.error).toBeUndefined();
    expect(
      result.value?.items,
      "moving a field's `.for()` key no longer strands the prior version's " +
        "data. If the runtime gained key migration this test should be " +
        "REWRITTEN, not deleted — Tier 2 exists for this class and Tier 1 " +
        "structurally cannot see it",
    ).toEqual([]); // …not ["alpha", "beta"].
  });

  it("refuses an update whose stored ARGUMENT the new schema cannot read", async () => {
    // The second class Tier 2 covers, and the one where Tier 1 does not merely
    // fail to see the problem — it DEFERS it by name.
    //
    // `schema-compatibility.ts` has a deliberate evolution allowance: over an
    // OPEN argument object, a candidate may name a brand-new optional field of
    // any type and the contract check accepts it unconditionally. What makes
    // that sound is the runner validating the piece's merged durable arguments
    // against the new schema in the setup transaction. This case is the end of
    // that sentence: it drives a real captured argument through the production
    // repair call and requires the refusal.
    //
    // The guard is `Runner.#validateArgument` → `validateSchemaValue`, reached
    // from `applySetupState`'s re-stage branch. Reaching it on THIS path needed
    // the setup-completion marker: the repair stamps the candidate's
    // `patternIdentity` before running setup (`pieces-controller.ts`, and this
    // harness mirrors it), so the pointer already names the candidate and a
    // pointer-only comparison reported "same pattern" and skipped the re-stage.
    // `patternSetupIdentity` still named the version that staged the argument,
    // which is what tells an update from a same-version replay
    // (`storedSetupMarker` in `runner.ts`).
    //
    // What the refusal must NOT be is wholesale strictness. A slot whose stored
    // value is a link that cannot be dereferenced right now stays deferred
    // (CT-1917 — a nested piece's argument lives in its HOST's doc, and a host
    // that has not synced must not fail the update). Only a PLAIN value of the
    // wrong type is refused. Both halves are guarded together in
    // `runtime/runner/test/pattern-update-argument-validation.test.ts`; this
    // case is the same guard reached from a real captured vintage.
    const captured = await capture(OLD_OPEN_ARGUMENT, [], { count: "seven" });

    // Tier 1 waves the pair through — the premise of the case, so it is
    // asserted IN the case rather than taken on trust from another one.
    const tier1 = await replayOn(captured, OLD_OPEN_ARGUMENT);
    const previous = await tier1.vintage.runtime.patternManager.compilePattern(
      OLD_OPEN_ARGUMENT,
      { space: tier1.vintage.space as never },
    );
    const candidate = await tier1.vintage.runtime.patternManager.compilePattern(
      NEW_TYPES_THE_ARGUMENT_KEY,
      { space: tier1.vintage.space as never },
    );
    expect(
      (previous.argumentSchema as { additionalProperties?: unknown })
        ?.additionalProperties,
      "the vintage's argument object is not OPEN, so Tier 1's evolution " +
        "allowance never applies and this case is testing nothing",
    ).toBe(true);
    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();

    // CONTROL, in this case for the reason the storage-move case has one: an
    // argument that reads back empty is also what a fixture that never stored
    // one looks like.
    expect(tier1.outcome.error).toBeUndefined();
    const controlLink = await vintageArgumentLink(
      tier1.vintage,
      tier1.outcome.resultSchema,
    );
    expect(
      await readVintageArgument(tier1.vintage, controlLink, undefined),
      "CONTROL failed, so the case below proves nothing: the vintage itself " +
        "cannot read the durable argument it captured",
    ).toEqual({ count: "seven" });

    // Now the candidate: the update is refused rather than landing over state
    // it cannot read.
    const replayed = await replayOn(captured, NEW_TYPES_THE_ARGUMENT_KEY);
    expect(
      replayed.outcome.error,
      "the update LANDED over a durable argument the new schema cannot read. " +
        "Tier 1 waives this class on the promise that the runner validates " +
        "merged durable arguments in the setup transaction, so either that " +
        "guard stopped being reachable on the repair path or Tier 1 must stop " +
        "waiving the class",
    ).toBeDefined();
    // Assert the SPECIFIC refusal. A bare `toBeDefined()` would also be
    // satisfied by a compile error, a broken fixture, or a disposed runtime —
    // green for the wrong reason on the one thing this case exists to prove.
    expect(replayed.outcome.error).toContain(
      "updated arguments do not match the candidate schema",
    );
    expect(replayed.outcome.error).toContain(
      "count: value does not match type number",
    );

    // A refusal must leave the state alone. The validation write and the schema
    // retarget ride the setup transaction, so a rejection aborts both; if the
    // bytes were gone, the update would have destroyed data on its way to
    // refusing, which is a worse outcome than the one this case guards.
    const link = await vintageArgumentLink(
      replayed.vintage,
      replayed.outcome.resultSchema,
    );
    expect(
      await readVintageArgument(replayed.vintage, link, undefined),
      "the refused update did not leave the captured argument intact",
    ).toEqual({ count: "seven" });
  });

  it("records which classes Tier 1 already covers", async () => {
    // Tier 2 is not a superset of Tier 1 and this pins where the line falls,
    // so neither tier gets removed on a wrong assumption about the other.
    //
    // `assertPatternSchemasBackwardCompatible` is what `cf piece setsrc` runs
    // and what Tier 1 checks every pattern against its recorded baselines.
    const dir = await tempDir("continuity-tier1-");
    const vintage = await openRuntime(dir);
    const compile = (program: RuntimeProgram) =>
      vintage.runtime.patternManager.compilePattern(program, {
        space: vintage.space as never,
      });
    const previous = await compile(OLD_WITHOUT_FAVORITES);

    // Newly required results are compatible: the candidate generates them.
    const generatedRequired = await compile(NEW_GENERATED_REQUIRED);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        previous,
        generatedRequired,
      )
    ).not.toThrow();

    // The storage-key move is invisible to it: identical schemas, no issue.
    const renamed = await compile(RENAMED_STORAGE_KEY);
    expect(renamed.resultSchema).toEqual(previous.resultSchema);
    expect(() => assertPatternSchemasBackwardCompatible(previous, renamed)).not
      .toThrow();
  });
});
