import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  isStoredArgumentSchemaRefusal,
  STORED_ARGUMENT_SCHEMA_REFUSAL,
} from "../src/index.ts";
import { readStoredLinkChainRaw } from "../src/stored-argument-validation.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { resultSchemaMetaSpelling } from "../src/result-schema-meta.ts";

// A pattern update must not leave durable state the new version's argument
// schema cannot read. `packages/piece/src/schema-compatibility.ts` waives one
// class on exactly that ground: over an OPEN argument object a candidate may
// name a brand-new optional field of any type, because the runner "validates
// the piece's merged durable arguments against the new schema transactionally
// before committing such an update". These cases are what makes that true.
//
// Both production update routes are covered, because they reach setup
// differently and only one of them ever validated:
//
// - HOT-SWAP: the `patternIdentity` watcher on a RUNNING piece calls
//   `applySetupState` with `sameStoredSetup = false`, so the stored argument is
//   re-staged and validated.
// - ROLL-FORWARD MATERIALIZE (`pieces-controller.ts`): the candidate's identity
//   is committed onto the root FIRST, then setup runs. The pointer then already
//   names the candidate, so a pointer-only comparison reports "same pattern"
//   and the re-stage — with its validation — was skipped. The completion marker
//   `patternSetupIdentity` is what tells the two apart: it names the version
//   that actually staged the stored argument. The same shape reaches setup
//   through `pieces-controller.ts`'s cold-start repair, whose root had its
//   pointer moved with no setup at all by `PatternUpdater`'s instantiated mode.
//
// A caller that hands setup a pattern the pointer does not name yet — the
// default-root apply, `cf piece setsrc` — was recognized as a change already
// and needed nothing here.
//
// The cold-link cases are the counterweight and belong in the same
// file: this validation only stays correct while "a slot I cannot read right
// now" keeps being distinguished from "a slot holding a plain value of the
// wrong type". Tightening one of these breaks the other, so a reader changing
// either sees both. `pattern-swap-link-argument.test.ts` covers the same
// deferral on the swap route in production shape.

const signer = await Identity.fromPassphrase("pattern-update-argument-check");
const space = signer.did();

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

/**
 * A version whose argument object is OPEN, so it stores `count` under any type
 * legally. `marker` makes the running version observable.
 *
 * `[key: string]: any` is what produces `additionalProperties: true`.
 * `Record<string, unknown>` does not: `unknown` maps to `{type:"unknown"}`.
 */
const openArgument = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern } from 'commonfabric';",
    "interface Args { [key: string]: any }",
    "export default pattern<Args, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "",
  ].join("\n"));

/** The candidate: same open object, but `count` is now a typed named field. */
const typedCount = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern } from 'commonfabric';",
    "interface Args { count?: number; [key: string]: any }",
    "export default pattern<Args, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "",
  ].join("\n"));

/**
 * A candidate that types a NESTED object: `row.name` is required, so a `row`
 * that materializes without it refuses. The nested-cold cases stand on this —
 * the argument doc's own slot (`row`) resolves fine, and only a hop past it
 * dead-ends.
 */
const typedRow = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern } from 'commonfabric';",
    // Open like the argument object above it: the row fixtures carry slots
    // the candidate never declares (a chained alias, a self-link), the way
    // stored docs of another vintage routinely do.
    "interface Row { name: string; other?: string; [key: string]: any }",
    "interface Args { row?: Row; [key: string]: any }",
    "export default pattern<Args, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "",
  ].join("\n"));

/**
 * A version whose `stamp` is a `Date`, which generates `{ type: "object" }`
 * and is stored as a `FabricEpochNsec`.
 */
const dateStamp = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern } from 'commonfabric';",
    "interface Args { stamp?: Date }",
    "export default pattern<Args, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "",
  ].join("\n"));

/** The candidate: `stamp` is a record that requires a defaulted `zone`. */
const zonedStamp = (marker: string): RuntimeProgram =>
  programOf([
    "import { Default, pattern } from 'commonfabric';",
    "interface Stamp { zone: Default<string, 'UTC'> }",
    "interface Args { stamp?: Stamp }",
    "export default pattern<Args, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "",
  ].join("\n"));

describe("pattern update validates the stored argument", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  /**
   * Set up `vintage` on a fresh root with `argument` stored durably, WITHOUT
   * starting it — the cold root a repair path finds. Not starting is what keeps
   * this on the roll-forward route: `start()` arms the `patternIdentity`
   * watcher, and any later stamp would then be serviced by the hot-swap instead.
   */
  const setupVintage = async (
    vintage: RuntimeProgram,
    argument: unknown,
    cause: string,
  ) => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(vintage, {
      space,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    await rt.setup(tx, pattern, argument, cell);
    await tx.commit();
    await rt.idle();
    return {
      cell,
      identity: rt.patternManager.getArtifactEntryRef(pattern)!.identity,
    };
  };

  /** Stamp `ref` and materialize `candidate`, the production repair shape. */
  const rollForward = async (
    cell: Cell<Record<string, unknown>>,
    candidate: RuntimeProgram,
  ): Promise<{ error?: string; thrown?: unknown; identity: string }> => {
    const pattern = await rt.patternManager.compilePattern(candidate, {
      space,
    });
    const ref = rt.patternManager.getArtifactEntryRef(pattern)!;
    const { error: stampError } = await rt.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw("patternIdentity", {
        identity: ref.identity,
        symbol: ref.symbol,
      }, rawMetaWriteAuthorization);
    });
    expect(stampError?.message).toBeUndefined();
    let error: string | undefined;
    let raised: unknown;
    try {
      // `expectedPatternIdentity` is what makes a rejected setup commit THROW
      // rather than log and continue — the same reason the repair passes it.
      await rt.runSynced(cell.withTx(), pattern, undefined, {
        expectedPatternIdentity: ref,
      });
    } catch (thrown) {
      raised = thrown;
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    // Settle either outcome before returning. A refused setup rejects out of
    // `runSynced` with the dependency loads it started still in flight, and
    // tearing the runtime down under them logs a spurious sync failure against
    // a closed replica — noise that reads like a defect in the case that just
    // passed.
    await rt.idle();
    await rt.storageManager.synced();
    return { error, thrown: raised, identity: ref.identity };
  };

  it("refuses a roll-forward whose stored argument the candidate rejects", async () => {
    // `count: "seven"` was legal under the open object and is not a number.
    const { cell, identity: vintageIdentity } = await setupVintage(
      openArgument("v1"),
      { count: "seven" },
      "roll-forward-wrong-type",
    );

    const { error, thrown, identity: rejectedIdentity } = await rollForward(
      cell,
      typedCount("v2"),
    );

    // Assert the SPECIFIC refusal. A bare `toBeDefined()` would also pass on a
    // compile error, a missing store, or a disposed runtime — green for the
    // wrong reason on the one case this file exists for.
    expect(
      error,
      "the roll-forward materialize accepted a durable argument the candidate " +
        "schema cannot read. `schema-compatibility.ts` waives the open-argument " +
        "evolution class on the promise that this path validates it",
    ).toContain("updated arguments do not match the candidate schema");
    expect(error).toContain("count: value does not match type number");

    // The refusal must be CLASSIFIABLE, not just readable. A boot repair keys
    // its recovery on this: re-running the same identity refuses identically,
    // so `PiecesController` escalates to the roll-forward backstop instead of
    // retrying, and a failure it cannot classify is discarded in favor of the
    // original start error. Assert against the error the runner ACTUALLY threw
    // rather than a hand-written string, so the thrower and the classifier
    // cannot drift apart.
    expect(
      isStoredArgumentSchemaRefusal(thrown),
      "the refusal is no longer classifiable, so a boot repair will discard " +
        "it and surface an unrelated start error instead of escalating",
    ).toBe(true);

    // The bytes are untouched: a refusal must abort the transaction, not
    // half-apply it. Reading them back is what tells "refused" from "deleted".
    const link = getMetaLink(cell, "argument")!;
    expect(
      rt.getCellFromLink(link).getRaw(),
      "the refusal did not leave the stored argument intact",
    ).toEqual({ count: "seven" });

    // What a refusal does NOT undo, asserted so it is a documented consequence
    // rather than a surprise. The identity stamp and the materialize are
    // separate transactions — the repair commits the pointer first, on purpose,
    // so the swap can carry its own precondition — and only the second one
    // aborts here. The durable root is therefore left NAMING the rejected
    // candidate while its setup marker still names the version that staged the
    // state, which is exactly the shape a CFC migration refusal already
    // produces on this path. The next boot re-attempts the repair and refuses
    // again, loudly, until the incompatible argument or pattern is fixed;
    // silently running the candidate over state it cannot read is the outcome
    // this whole gate exists to prevent.
    await cell.sync();
    expect(
      getPatternIdentityRef(cell as Cell<unknown>)?.identity,
      "a refused roll-forward rolled the pointer back. That is a deliberate " +
        "behavior change, not a cleanup: the repair reaches this path BECAUSE " +
        "the previously pinned pattern could not be set up either",
    ).toBe(rejectedIdentity);
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>)?.identity,
      "the refused setup stamped its completion marker, so a later boot would " +
        "read the root as fully staged for a version that never staged it",
    ).toBe(vintageIdentity);
  });

  it("accepts an optional property a handler stored as undefined", async () => {
    // The shape a real deployed pattern writes. `packages/patterns/topics/
    // topic.tsx`'s `addComment` builds `comments.push({ author, ... })` from a
    // variable that is undefined whenever no `agentName` was supplied, so the
    // KEY lands with no value under it, and the codec stores that presence.
    //
    // JavaScript cannot tell `{ author: undefined }` from `{}` on read, so the
    // pattern has not said anything different by writing it — but validating
    // the key as a value asks whether `undefined` is an object, which nothing
    // answers yes to. Measured on the committed topics vintage before this was
    // fixed: `comments: 0: author: value does not match type object`, refusing
    // the update of a document the pattern itself had written. The refusal is
    // permanent (see the roll-forward case above), so this is a piece that
    // never opens again rather than one that logs and recovers.
    const stored = {
      comments: [{ author: undefined, authorName: "Old Agent", body: "old" }],
    };
    const { cell } = await setupVintage(
      openArgument("v1"),
      stored,
      "optional-undefined-property",
    );

    // The premise, checked rather than assumed: if the codec dropped the key on
    // the way to storage there would be nothing here to validate, and this
    // case would pass without ever exercising the rule it exists for.
    const storedLink = getMetaLink(cell, "argument")!;
    const storedRaw = rt.getCellFromLink(storedLink).getRaw() as {
      comments: Record<string, unknown>[];
    };
    expect(
      Object.hasOwn(storedRaw.comments[0], "author"),
      "the stored argument does not carry `author` at all, so this case no " +
        "longer reaches the present-but-undefined rule it was written for",
    ).toBe(true);
    expect(storedRaw.comments[0].author).toBeUndefined();

    const { error, thrown } = await rollForward(
      cell,
      programOf([
        "import { pattern } from 'commonfabric';",
        "interface Author { kind: string; name: string }",
        "interface Comment { author?: Author; authorName?: string; body?: string }",
        "interface Args { comments?: Comment[]; [key: string]: any }",
        "export default pattern<Args, { marker: string }>(() => {",
        '  return { marker: "v2" };',
        "});",
        "",
      ].join("\n")),
    );

    expect(
      error,
      "a property the pattern wrote as undefined was measured against its " +
        "declared type, so the update the pattern's own data provoked is refused",
    ).toBeUndefined();
    expect(isStoredArgumentSchemaRefusal(thrown)).toBe(false);
  });

  it("lets a MARKERLESS root through, and marks it on the way", async () => {
    // The deliberate exemption, pinned so it is a decision rather than an
    // assumption. `storedSetupMarker` reports an absent `patternSetupIdentity`
    // as `"absent"`, and `restageStoredArgument` re-stages only on `"other"`, so
    // an absent marker means no re-stage: absence cannot be told from a pending
    // update, and re-staging every such root would validate — and rewrite
    // defaults over — arguments no update is touching.
    //
    // Nothing else covers this population. Tier 2's vintage replay cannot: its
    // captures run setup through the current runner, which always stamps the
    // marker, so a captured root is never markerless. Hence this case, which
    // strips the marker to reach the state a root written before the marker
    // existed is in.
    const { cell } = await setupVintage(
      openArgument("v1"),
      { count: "seven" },
      "markerless-root",
    );
    const { error: stripError } = await rt.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw(
        "patternSetupIdentity",
        undefined,
        rawMetaWriteAuthorization,
      );
    });
    expect(stripError?.message).toBeUndefined();
    await rt.idle();
    await cell.sync();
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>),
      "the marker was not actually removed, so this case is exercising an " +
        "ordinary marked root and proves nothing about the exemption",
    ).toBeUndefined();

    const { error } = await rollForward(cell, typedCount("v2"));

    expect(
      error,
      "a markerless root was validated. That may well be the better policy, " +
        "but it is a CHANGE: every root written before the marker existed " +
        "would start refusing its first repair-route update",
    ).toBeUndefined();
    // One setup wide: the update that skipped validation stamps the marker, so
    // the next one is checked. This is what bounds the exemption.
    await cell.sync();
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>),
      "the exemption did not close behind itself, so this root would skip " +
        "validation on every future update rather than just this one",
    ).toBeDefined();
  });

  it("does not half-swap a RUNNING piece whose stored argument is fine", async () => {
    // The counterweight to the running-piece refusal above, and its bound:
    // validating on that path must not become STAGING on it.
    //
    // `applySetupState` installs the incoming version's argument schema,
    // internal manifest and result projection — but only the pattern watcher
    // can cancel the live nodes and instantiate the new ones. Staging here
    // would leave the piece's projection reading as V2 while its nodes still
    // drive V1's cells, and would stamp the completion marker forward, erasing
    // the mismatch a later repair needs to see.
    //
    // The two versions differ in WHICH cell backs `tag`, so a staged-but-not-
    // instantiated projection is visible as a value change.
    // The versions differ in WHICH cell backs `tag` AND in their declared
    // result shape, so both halves of a partial swap are observable: a staged
    // projection shows as a value change, and a staged result SCHEMA shows in
    // the root's `schema` meta, which is what later reads resolve through.
    const stored = (
      marker: string,
      key: string,
      extra = false,
    ): RuntimeProgram =>
      programOf([
        "import { Writable, pattern } from 'commonfabric';",
        "interface Args { count?: number; [key: string]: any }",
        extra
          ? "interface Out { tag: Writable<string>; extra: Writable<number>; }"
          : "interface Out { tag: Writable<string>; }",
        "export default pattern<Args, Out>(() => {",
        `  const tag = new Writable<string>(${JSON.stringify(marker)}).for(${
          JSON.stringify(key)
        });`,
        ...(extra
          ? [
            "  const extra = new Writable<number>(0).for('extra');",
            "  return { tag, extra };",
          ]
          : ["  return { tag };"]),
        "});",
        "",
      ].join("\n"));

    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(stored("v1", "tagA"), { space, tx });
    const v2 = await pm.compilePattern(stored("v2", "tagB", true), {
      space,
      tx,
    });
    const v1Ref = pm.getArtifactEntryRef(v1)!;
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "running-half-swap",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { count: "seven" }, cell);
    await tx.commit();
    await running.pull();

    // Move the pointer. The swap refuses the stored argument and is LOGGED, so
    // the piece keeps running V1 under a pointer that reads V2 — the state a
    // repair finds.
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit();
    // Let incoming-cell loading and the refused setup finish before repair.
    await rt.runner.idlePointerMaintenance();
    await rt.idle();
    await cell.pull();
    expect(
      (cell.getAsQueryResult() as { tag: string }).tag,
      "the swap did not refuse, so this case is not testing a running piece " +
        "with a stale setup marker",
    ).toBe("v1");

    // Now repair the argument, so validation on the repair below PASSES and the
    // only question left is whether setup moves the piece.
    const { error: fixError } = await rt.editWithRetry((wtx) => {
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, wtx)
        .asSchema(undefined as never)
        .set({ count: 7 } as never);
    });
    expect(fixError?.message).toBeUndefined();
    await rt.idle();

    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), v2, undefined, {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();
    await cell.pull();

    expect(error).toBeUndefined();
    expect(
      (cell.getAsQueryResult() as { tag: string }).tag,
      "the piece's live value changed without its graph being re-instantiated " +
        "— setup staged the new version's result projection over nodes still " +
        "running the old one",
    ).toBe("v1");
    await cell.sync();
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>)?.identity,
      "the completion marker advanced past the graph that is actually " +
        "running, which erases the mismatch a later repair uses to notice",
    ).toBe(v1Ref.identity);
    // The result SCHEMA is the other half of a partial swap, and the one most
    // easily missed: later reads resolve the root through this meta, so staging
    // the candidate's schema over a graph still running the old version makes
    // those reads describe a shape nothing is producing.
    expect(
      (cell as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("schema"),
      "the candidate's result schema was staged over a piece still running " +
        "the previous version's nodes",
    ).toEqual(resultSchemaMetaSpelling(v1.resultSchema!));
  });

  /**
   * Put a RUNNING piece into the stale-marker state: it runs `vintage`, the
   * pointer names `candidate`, and the swap refused so the graph never moved.
   * The repair below then takes the in-place validation path.
   */
  const runningWithStaleMarker = async (
    cause: string,
    vintageArgument: unknown,
  ) => {
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(openArgument("v1"), { space, tx });
    const v2 = await pm.compilePattern(typedCount("v2"), { space, tx });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, vintageArgument, cell);
    await tx.commit();
    await running.pull();

    // A wrong-typed argument makes the swap refuse, so the piece stays on V1
    // under a pointer reading V2. It is replaced afterwards by the caller's
    // real subject, so the refusal here is only scaffolding.
    const { error: badError } = await rt.editWithRetry((wtx) => {
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, wtx)
        .asSchema(undefined as never)
        .set({ count: "seven" } as never);
    });
    expect(badError?.message).toBeUndefined();
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit();
    // Let incoming-cell loading and the refused setup finish before repair.
    await rt.runner.idlePointerMaintenance();
    await rt.idle();
    await cell.pull();
    expect(
      (cell.getAsQueryResult() as { marker: string }).marker,
      "the swap did not refuse, so the piece is not in the stale-marker state",
    ).toBe("v1");
    return { cell, v2 };
  };

  const repairInPlace = async (
    cell: Cell<Record<string, unknown>>,
    pattern: Awaited<ReturnType<Runtime["patternManager"]["compilePattern"]>>,
  ) => {
    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), pattern, undefined, {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();
    return error;
  };

  it("defers a COLD LINK slot on the in-place validation path", async () => {
    // The cold-link deferral on the running-reuse route. The in-place check is
    // a second validation site, and it only stays correct while it defers what
    // the re-stage defers — otherwise every running piece whose argument slot
    // links into a doc that has not synced starts refusing its own repair.
    const { cell, v2 } = await runningWithStaleMarker(
      "in-place-cold-link",
      { count: 1 },
    );
    const absent = rt.getCell<number>(space, "in-place-cold-link-target");
    const { error: writeError } = await rt.editWithRetry((wtx) => {
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, wtx)
        .asSchema(undefined as never)
        .set({ count: absent } as never);
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();

    expect(
      await repairInPlace(cell, v2),
      "a slot whose link cannot be dereferenced right now was refused on the " +
        "in-place path, which fails the repair of every running piece whose " +
        "argument links into a doc that has not synced",
    ).toBeUndefined();
  });

  it("defers an argument doc that reads NOTHING on the in-place path", async () => {
    // The other half of the same deferral: a nested piece's argument lives in
    // its HOST's document, so when the host is down the whole doc reads cold.
    // Validating bare defaults against the candidate would refuse a piece whose
    // argument is simply not loaded yet.
    const { cell, v2 } = await runningWithStaleMarker(
      "in-place-cold-doc",
      { count: 1 },
    );
    const coldArgument = rt.getCell<Record<string, unknown>>(
      space,
      "in-place-cold-argument-doc",
    );
    const { error: retargetError } = await rt.editWithRetry((wtx) => {
      cell.withTx(wtx).setMetaRaw(
        "argument",
        coldArgument.getAsWriteRedirectLink({ base: cell }),
        rawMetaWriteAuthorization,
      );
    });
    expect(retargetError?.message).toBeUndefined();
    await rt.idle();

    expect(
      await repairInPlace(cell, v2),
      "an argument doc that reads nothing right now was treated as invalid on " +
        "the in-place path, so a nested piece under an unsynced host cannot " +
        "be repaired",
    ).toBeUndefined();
  });

  it("leaves a MARKERLESS running piece's argument unvalidated", async () => {
    // The markerless exemption's licence on the RUNNING-reuse path, which the
    // other markerless case cannot pin: that one uses a stopped root, and the
    // half-swap case repairs the argument before the repair runs. Neither
    // notices if the reuse path starts validating unconditionally.
    //
    // The population this protects is the aged root — pre-marker, and therefore
    // the one likeliest to hold an argument its own schema would reject. Start
    // validating those on every reuse and they stop being repairable at all,
    // which is the failure the exemption exists to avoid.
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(typedCount("v1"), {
      space,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "markerless-running-bad-argument",
      undefined,
      tx,
    );
    const running = rt.run(tx, pattern, undefined, cell);
    await tx.commit();
    await running.pull();

    // A value this pattern's OWN schema rejects, written schema-lessly — how it
    // gets under a declared field without passing its check — and no marker.
    const { error: prepError } = await rt.editWithRetry((wtx) => {
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, wtx)
        .asSchema(undefined as never)
        .set({ count: "seven" } as never);
      cell.withTx(wtx).setMetaRaw(
        "patternSetupIdentity",
        undefined,
        rawMetaWriteAuthorization,
      );
    });
    expect(prepError?.message).toBeUndefined();
    await rt.idle();
    await cell.sync();
    expect(getPatternSetupIdentityRef(cell as Cell<unknown>)).toBeUndefined();

    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), pattern, undefined, {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();

    expect(
      error,
      "a markerless running piece had its stored argument validated, which " +
        "closes the exemption for exactly the aged roots it exists for — they " +
        "would stop being startable rather than start being checked",
    ).toBeUndefined();
  });

  it("does not half-swap a MARKERLESS running piece either", async () => {
    // The schema repair is safe only when the marker POSITIVELY names this
    // pattern. "Not staged by another version" is a weaker fact than that: it
    // is also true when the marker is ABSENT, and a markerless piece can be
    // running something other than what the pointer names — a pre-marker root
    // resumes into the running set without setup, `PatternUpdater`'s
    // instantiated mode moves the pointer with no setup, and a refused swap
    // leaves the graph where it was. Treating absent as "matches" would write
    // the candidate's result schema over a graph producing the old shape, which
    // is the half-swap the reuse gate exists to prevent.
    const tx = rt.edit();
    const pm = rt.patternManager;
    const stored = (marker: string, key: string, extra = false) =>
      programOf([
        "import { Writable, pattern } from 'commonfabric';",
        "interface Args { count?: number; [key: string]: any }",
        extra
          ? "interface Out { tag: Writable<string>; extra: Writable<number>; }"
          : "interface Out { tag: Writable<string>; }",
        "export default pattern<Args, Out>(() => {",
        `  const tag = new Writable<string>(${JSON.stringify(marker)}).for(${
          JSON.stringify(key)
        });`,
        ...(extra
          ? [
            "  const extra = new Writable<number>(0).for('extra');",
            "  return { tag, extra };",
          ]
          : ["  return { tag };"]),
        "});",
        "",
      ].join("\n"));
    const v1 = await pm.compilePattern(stored("v1", "tagA"), { space, tx });
    const v2 = await pm.compilePattern(stored("v2", "tagB", true), {
      space,
      tx,
    });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "markerless-running",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { count: "seven" }, cell);
    await tx.commit();
    await running.pull();

    // Pointer moves; the swap refuses the wrong-typed argument and is logged,
    // so the graph stays on V1.
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit();
    // Let incoming-cell loading and the refused setup finish before repair.
    await rt.runner.idlePointerMaintenance();
    await rt.idle();
    await cell.pull();
    expect((cell.getAsQueryResult() as { tag: string }).tag).toBe("v1");

    // Strip the marker AND repair the argument: now the piece is markerless,
    // running V1, under a pointer naming V2, with nothing left to refuse.
    const { error: prepError } = await rt.editWithRetry((wtx) => {
      cell.withTx(wtx).setMetaRaw(
        "patternSetupIdentity",
        undefined,
        rawMetaWriteAuthorization,
      );
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, wtx)
        .asSchema(undefined as never)
        .set({ count: 7 } as never);
    });
    expect(prepError?.message).toBeUndefined();
    await rt.idle();
    await cell.sync();
    expect(getPatternSetupIdentityRef(cell as Cell<unknown>)).toBeUndefined();

    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), v2, undefined, {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();
    await cell.pull();

    expect(error).toBeUndefined();
    expect(
      (cell.getAsQueryResult() as { tag: string }).tag,
      "the markerless piece's live value moved without its graph running",
    ).toBe("v1");
    await cell.sync();
    expect(
      (cell as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("schema"),
      "the candidate's result schema was written over a MARKERLESS running " +
        "piece — 'not staged by another version' was read as 'staged by this " +
        "one', and an absent marker proves neither",
    ).toEqual(resultSchemaMetaSpelling(v1.resultSchema!));
  });

  it("still repairs a missing result schema on a piece running THIS version", async () => {
    // The counterweight to the half-swap guard, and the line between them.
    //
    // Suppressing the result-schema write on the reuse path is only correct
    // when the running graph might not be this pattern — a STALE setup marker.
    // When the marker names this exact pattern the running graph IS it, so
    // writing its schema is safe, and skipping it drops a real repair: a piece
    // whose `schema` meta is missing reads back schema-less, which costs
    // `getResultCellWithSourceSchema` its type, `durableSourceContract` its
    // "write destination has no durable schema contract" precondition, and
    // `derivePersistedLinkLabel` its same-transaction hatch.
    const { cell } = await setupVintage(
      openArgument("v1"),
      { count: 7 },
      "schema-meta-repair",
    );
    const pattern = await rt.patternManager.compilePattern(openArgument("v1"), {
      space,
    });
    await rt.runSynced(cell.withTx(), pattern, undefined, {});
    await rt.idle();

    const meta = (c: typeof cell) =>
      (c as unknown as { getMetaRaw: (k: string) => unknown }).getMetaRaw(
        "schema",
      );
    expect(meta(cell), "the piece never had a result schema to lose")
      .toBeDefined();

    // Strip it, the state a piece written before the meta existed is in.
    const { error: stripError } = await rt.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw(
        "schema",
        undefined,
        rawMetaWriteAuthorization,
      );
    });
    expect(stripError?.message).toBeUndefined();
    await rt.idle();
    await cell.sync();
    expect(meta(cell)).toBeUndefined();

    // Re-run setup for the SAME version. The marker names this pattern, so the
    // running graph is this pattern, and the repair must land.
    await rt.runSynced(cell.withTx(), pattern, undefined, {});
    await rt.idle();
    await rt.storageManager.synced();
    await cell.sync();

    expect(
      meta(cell),
      "a piece running THIS version no longer has its missing result schema " +
        "repaired — the reuse path suppresses the write for the stale-marker " +
        "case and took the same-version case with it",
    ).toEqual(resultSchemaMetaSpelling(pattern.resultSchema!));

    // The same repair on the OTHER reuse branch. A caller may re-run a running
    // piece WITH an argument (`PiecesController.runWithPattern` does), and that
    // branch returns from a different place — so a fix applied to only one of
    // them leaves half the callers unrepaired.
    const { error: stripAgain } = await rt.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw(
        "schema",
        undefined,
        rawMetaWriteAuthorization,
      );
    });
    expect(stripAgain?.message).toBeUndefined();
    await rt.idle();
    await cell.sync();
    expect(meta(cell)).toBeUndefined();

    await rt.runSynced(cell.withTx(), pattern, { count: 7 }, {});
    await rt.idle();
    await rt.storageManager.synced();
    await cell.sync();
    expect(
      meta(cell),
      "the supplied-argument reuse branch returns without repairing the " +
        "result schema, so a piece re-run with an argument stays untyped",
    ).toEqual(resultSchemaMetaSpelling(pattern.resultSchema!));
  });

  it("does not classify a failure that merely mentions the refusal", () => {
    // The counterweight to the assertion above, and the reason the prefix is
    // matched at the START. The escalation this classifier gates REPLACES a
    // root's pattern, so a transient storage failure that happens to quote a
    // user value must not be mistaken for "the pinned pattern cannot read this
    // doc" — the same forgery concern `isCfcMigrationRejection` documents.
    expect(
      isStoredArgumentSchemaRefusal(
        new Error(`commit failed at /${STORED_ARGUMENT_SCHEMA_REFUSAL}: nope`),
      ),
      "a failure that merely CONTAINS the refusal text was classified as one, " +
        "so user-influenced content can trigger a root replacement",
    ).toBe(false);
    expect(isStoredArgumentSchemaRefusal(undefined)).toBe(false);
    expect(isStoredArgumentSchemaRefusal(STORED_ARGUMENT_SCHEMA_REFUSAL)).toBe(
      false,
    );
  });

  it("rolls a COMPATIBLE stored argument forward (control)", async () => {
    // The control this file is unsound without: if a roll-forward refused every
    // argument, the case above would pass while proving nothing about types.
    const { cell } = await setupVintage(
      openArgument("v1"),
      { count: 7 },
      "roll-forward-right-type",
    );

    const { error } = await rollForward(cell, typedCount("v2"));

    expect(error).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
    expect(rt.getCellFromLink(getMetaLink(cell, "argument")!).getRaw()).toEqual(
      {
        count: 7,
      },
    );
  });

  it("refuses a roll-forward whose stored `FabricPrimitive` lacks a newly required defaulted field", async () => {
    // `schema-compatibility.ts` admits a newly required argument field on its
    // default, and a `FabricPrimitive` is frozen, so the default never reaches
    // one. This check is what refuses that value.

    const { cell } = await setupVintage(
      dateStamp("v1"),
      { stamp: new FabricEpochNsec(0n) },
      "roll-forward-primitive-default",
    );

    const { error, thrown } = await rollForward(cell, zonedStamp("v2"));

    expect(error).toContain(
      "updated arguments do not match the candidate schema",
    );
    expect(error).toContain("stamp: missing required property zone");
    expect(isStoredArgumentSchemaRefusal(thrown)).toBe(true);
    const stored = rt.getCellFromLink(getMetaLink(cell, "argument")!)
      .getRaw() as { stamp: unknown };
    expect(stored.stamp).toBeInstanceOf(FabricEpochNsec);
  });

  it("rolls forward a stored record under the same newly required defaulted field (control)", async () => {
    const { cell } = await setupVintage(
      dateStamp("v1"),
      { stamp: {} },
      "roll-forward-record-default",
    );

    const { error } = await rollForward(cell, zonedStamp("v2"));

    expect(error).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("rolls forward when a stored slot holds a link that reads COLD", async () => {
    // The cold-link deferral on the roll-forward route, and the differential
    // that pins WHERE the line falls: same candidate as the refusal case above,
    // same slot, same schema — the only difference is that `count` holds a
    // LINK rather than a plain value. A link to a doc that is absent (or
    // simply not loaded this session, the ordinary client cold state) must not
    // read as "invalid", or every not-yet-synced nested argument becomes a
    // failed update; the vintage's own instantiation wrote exactly this link.
    // Refuse the plain value, defer the unreadable link.
    const absent = rt.getCell<number>(space, "roll-forward-cold-target");
    const { cell } = await setupVintage(
      openArgument("v1"),
      { count: absent },
      "roll-forward-cold-link",
    );

    const { error } = await rollForward(cell, typedCount("v2"));

    expect(
      error,
      "an argument slot whose link cannot be dereferenced right now was " +
        "treated as invalid, which would fail every update over a doc that " +
        "has not synced",
    ).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("rolls forward when the unreadable link sits BEHIND a readable hop", async () => {
    // The 2026-08-21 fleet incident, in miniature and to its full depth. A
    // profile's `name` cell stores a LINK to the doc holding its seed value
    // — a chain, not a slot: the row doc's `name` holds a link to a cell doc
    // whose whole content is another link, and only THAT target is missing
    // (cold-start sync delivers the cell doc but not the seed doc). The home
    // pattern's first identity move in months re-validated every home's
    // `profiles` argument over that half-replicated graph: `profiles: 0:
    // name: value does not match type string`, permanently, fleet-wide. The
    // one-hop case above never covers this: the argument doc's OWN slot
    // resolves fine (`row` materializes as an object), and the dead end is
    // hops further down, where an overlay that only reads the argument doc's
    // raw cannot see it. The deferral has to follow the stored link graph as
    // deep as the materialization it repairs. The row's `loop` slot links
    // back to the row doc itself, pinning that a repeated address along one
    // descent terminates instead of recursing forever.
    const absent = rt.getCell<string>(space, "nested-cold-target");
    const mid = rt.getCell<string>(space, "nested-cold-mid");
    const fine = rt.getCell<string>(space, "nested-cold-fine");
    const fineHop = rt.getCell<string>(space, "nested-cold-fine-hop");
    const inner = rt.getCell<Record<string, unknown>>(
      space,
      "nested-cold-inner",
    );
    const wrap = rt.getCell<Record<string, unknown>>(
      space,
      "nested-cold-wrap",
    );
    const row = rt.getCell<Record<string, unknown>>(space, "nested-cold-row");
    const { error: writeError } = await rt.editWithRetry((tx) => {
      mid.withTx(tx).asSchema(undefined as never).set(absent as never);
      fine.withTx(tx).asSchema(undefined as never).set("fine" as never);
      fineHop.withTx(tx).asSchema(undefined as never).set(fine as never);
      inner.withTx(tx).asSchema(undefined as never).set(
        { inner: "annotation" } as never,
      );
      wrap.withTx(tx).asSchema(undefined as never).set(
        { wrap: inner } as never,
      );
      row.withTx(tx).asSchema(undefined as never).set(
        {
          name: mid,
          // A chain and a mid-path link that RESOLVE, beside the one that
          // does not: the walk mirrors these to their values and leaves
          // them untouched while `name` alone defers.
          other: fineHop,
          // The note's path crosses the link stored at `wrap` mid-doc.
          note: wrap.key("wrap").key("inner"),
          loop: row,
        } as never,
      );
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();
    const { cell } = await setupVintage(
      openArgument("v1"),
      { row },
      "nested-cold-link",
    );

    const { error } = await rollForward(cell, typedRow("v2"));

    expect(
      error,
      "a slot whose stored value routes through an unreadable link chain " +
        "past the argument doc was treated as invalid — the shape that " +
        "bricked every home space on 2026-08-21",
    ).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("defers a link whose path crosses another link mid-doc", async () => {
    // A link may address a path inside its target, and the target doc may
    // hold ANOTHER link partway along that path. A raw read of the full path
    // would descend into the mid-doc link sigil's own JSON and report a
    // false absence, so the walk steps segments itself and follows the link
    // it meets — here to a doc the replica cannot serve, which is the
    // unreadable case: defer, and the update proceeds.
    const absent = rt.getCell<Record<string, unknown>>(
      space,
      "mid-path-cold-target",
    );
    const wrap = rt.getCell<Record<string, unknown>>(space, "mid-path-wrap");
    const row = rt.getCell<Record<string, unknown>>(space, "mid-path-row");
    const { error: writeError } = await rt.editWithRetry((tx) => {
      wrap.withTx(tx).asSchema(undefined as never).set(
        { wrap: absent } as never,
      );
      row.withTx(tx).asSchema(undefined as never).set(
        { name: wrap.key("wrap").key("inner"), other: "fine" } as never,
      );
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();
    const { cell } = await setupVintage(
      openArgument("v1"),
      { row },
      "mid-path-cold-link",
    );

    const { error } = await rollForward(cell, typedRow("v2"));

    expect(
      error,
      "a linked path crossing a mid-doc link into an absent doc was judged " +
        "as a plain absence instead of deferred as unreadable",
    ).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("fails loudly on a stored link CYCLE rather than deferring it", async () => {
    // Two docs each holding only a link to the other: every doc on the
    // chain is present and readable, so nothing is unreadable — the chain
    // just never produces a value. The staging materialization refuses to
    // resolve such a chain (link resolution throws on the cycle), so the
    // update fails loudly before any deferral question arises. What this
    // pins is the boundary: a cycle must never ride the unreadable-link
    // deferral through to a committed update. The walk's own repeat-address
    // guard — the backstop that keeps it terminating if a cyclic graph ever
    // reaches it — is exercised directly below.
    const cycleA = rt.getCell<unknown>(space, "cycle-a");
    const cycleB = rt.getCell<unknown>(space, "cycle-b");
    const row = rt.getCell<Record<string, unknown>>(space, "cycle-row");
    const { error: writeError } = await rt.editWithRetry((tx) => {
      cycleA.withTx(tx).asSchema(undefined as never).set(cycleB as never);
      cycleB.withTx(tx).asSchema(undefined as never).set(cycleA as never);
      row.withTx(tx).asSchema(undefined as never).set(
        { name: cycleA, other: "fine" } as never,
      );
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();
    const { cell } = await setupVintage(
      openArgument("v1"),
      { row },
      "cycle-link",
    );

    const { error } = await rollForward(cell, typedRow("v2"));

    expect(
      error,
      "a stored link cycle slipped through a pattern update silently",
    ).toContain("cycle");
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
  });

  it("terminates the raw walk on a cyclic stored graph", async () => {
    // Direct exercise of readStoredLinkChainRaw's repeat-address guard: the
    // staging materialization happens to throw on root-link cycles before
    // the walk runs today, but the walk must terminate on its own — it
    // follows raw bytes, and an infinite loop here would hang setup on
    // whatever cyclic shape some other resolution vintage tolerates. A
    // cycle resolves to no readable tree, like every other dead end.
    const cycleA = rt.getCell<unknown>(space, "walk-cycle-a");
    const cycleB = rt.getCell<unknown>(space, "walk-cycle-b");
    const prim = rt.getCell<Record<string, unknown>>(space, "walk-primitive");
    const metaOnly = rt.getCell<unknown>(space, "walk-meta-only");
    const { error: writeError } = await rt.editWithRetry((tx) => {
      cycleA.withTx(tx).asSchema(undefined as never).set(cycleB as never);
      cycleB.withTx(tx).asSchema(undefined as never).set(cycleA as never);
      prim.withTx(tx).asSchema(undefined as never).set({ p: true } as never);
      // A doc record a meta-only write leaves behind: present, no value —
      // the stamped-but-unmaterialized state real vintages hold.
      metaOnly.withTx(tx).setMetaRaw(
        "slug",
        "walk-meta-only",
        rawMetaWriteAuthorization,
      );
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();

    const tx = rt.edit();
    try {
      const reading = readStoredLinkChainRaw(
        tx,
        cycleA.getAsNormalizedFullLink(),
        new Set(),
      );
      expect(reading.value).toBeUndefined();
      expect(reading.cyclic).toBe(true);
      const midPathCycle = readStoredLinkChainRaw(
        tx,
        cycleA.key("beyond").getAsNormalizedFullLink(),
        new Set(),
      );
      expect(midPathCycle.value).toBeUndefined();
      expect(midPathCycle.cyclic).toBe(true);
      // The other no-tree dead ends, exercised at the same seam: a doc the
      // store has never held, and a path that reads through a primitive.
      const absent = rt.getCell<unknown>(space, "walk-absent-target");
      expect(
        readStoredLinkChainRaw(tx, absent.getAsNormalizedFullLink(), new Set())
          .cyclic,
      ).toBeUndefined();
      expect(
        readStoredLinkChainRaw(
          tx,
          absent.getAsNormalizedFullLink(),
          new Set(),
        ).value,
      ).toBeUndefined();
      expect(
        readStoredLinkChainRaw(
          tx,
          absent.key("beyond").getAsNormalizedFullLink(),
          new Set(),
        ).value,
      ).toBeUndefined();
      expect(
        readStoredLinkChainRaw(
          tx,
          prim.key("p").key("deeper").getAsNormalizedFullLink(),
          new Set(),
        ).value,
      ).toBeUndefined();
      expect(
        readStoredLinkChainRaw(
          tx,
          metaOnly.getAsNormalizedFullLink(),
          new Set(),
        ).value,
      ).toBeUndefined();
    } finally {
      await tx.commit();
    }

    // Anything other than an absence surfaces instead of reading as a dead
    // end — the same line readOrThrow draws. A committed transaction is the
    // reachable member of that class.
    expect(() =>
      readStoredLinkChainRaw(tx, cycleA.getAsNormalizedFullLink(), new Set())
    ).toThrow();
  });

  it("defers a PRESENT doc's absent value behind the hop", async () => {
    // Behind a link, an absence defers whatever produced it. This exact
    // shape argues why: the pattern-vintage stores hold pieces whose
    // `profiles` argument links a path the target doc does not hold YET —
    // the slot materializes lazily, on the first profile created — and a
    // validator that judged "present doc, absent path" as invalid refused
    // every update over them. Absence at rest is indistinguishable from
    // absence-so-far, so the slot's check belongs to instantiation-time
    // reads, which see the write when it comes.
    const present = rt.getCell<Record<string, unknown>>(
      space,
      "nested-absent-slot-target",
    );
    const row = rt.getCell<Record<string, unknown>>(
      space,
      "nested-absent-slot-row",
    );
    const { error: writeError } = await rt.editWithRetry((tx) => {
      present.withTx(tx).asSchema(undefined as never).set(
        { unrelated: true } as never,
      );
      row.withTx(tx).asSchema(undefined as never).set(
        {
          // Two segments, so the walk reads THROUGH the primitive stored at
          // `unrelated` — the same judged absence as a missing slot.
          name: present.key("unrelated").key("deeper"),
          other: "fine",
        } as never,
      );
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();
    const { cell } = await setupVintage(
      openArgument("v1"),
      { row },
      "nested-absent-slot-link",
    );

    const { error } = await rollForward(cell, typedRow("v2"));

    expect(
      error,
      "a slot whose link lands on a path its target does not hold yet was " +
        "treated as invalid — the lazily-materialized-slot shape the " +
        "pattern-vintage stores hold",
    ).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("still refuses a READABLE wrong-typed value behind the same hop", async () => {
    // The differential that pins where the deferral ends: identical nesting,
    // identical candidate, but the value behind the hop is present and simply
    // wrong. Deferral is for what this context cannot read, never for what it
    // read and found invalid — widen it to any nested `undefined`-adjacent
    // shape and the gate stops gating.
    const row = rt.getCell<Record<string, unknown>>(
      space,
      "nested-wrong-type-row",
    );
    const { error: writeError } = await rt.editWithRetry((tx) => {
      row.withTx(tx).asSchema(undefined as never).set(
        { name: 7, other: "fine" } as never,
      );
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();
    const { cell } = await setupVintage(
      openArgument("v1"),
      { row },
      "nested-wrong-type-link",
    );

    const { error, thrown } = await rollForward(cell, typedRow("v2"));

    expect(
      error,
      "a readable nested value of the wrong type slipped past validation — " +
        "the unreadable-link deferral is leaking onto values that were read " +
        "and judged",
    ).toContain("updated arguments do not match the candidate schema");
    expect(error).toContain("name: value does not match type string");
    expect(isStoredArgumentSchemaRefusal(thrown)).toBe(true);
  });

  it("leaves a same-version setup alone over an argument its OWN schema rejects", async () => {
    // The blast-radius guard, and the reason this check keys on the setup
    // marker rather than on strictness everywhere.
    //
    // The vintage here is the TYPED pattern, and the stored argument violates
    // that pattern's own schema — a schema-less write, which is how a value
    // gets under a declared field without passing its check. Re-running setup
    // for the SAME version must leave it alone. Widen the condition to
    // "validate on every setup" and every piece in this state stops booting,
    // failing at each start rather than at the update that introduced the
    // mismatch.
    //
    // Note the vintage must be the typed pattern, not the open one: an open
    // object accepts `{count: "seven"}`, so re-staging it would validate
    // cleanly and this case would pass no matter what the condition said.
    const { cell } = await setupVintage(
      typedCount("v1"),
      undefined,
      "same-version-own-schema-mismatch",
    );
    const { error: writeError } = await rt.editWithRetry((tx) => {
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, tx)
        .asSchema(undefined as never)
        .set({ count: "seven" } as never);
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();

    const pattern = await rt.patternManager.compilePattern(typedCount("v1"), {
      space,
    });
    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), pattern, undefined, {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();

    expect(
      error,
      "re-running setup for the SAME version refused an argument already " +
        "stored under it, which turns a pre-existing mismatch into a piece " +
        "that will not boot",
    ).toBeUndefined();
    expect(rt.getCellFromLink(getMetaLink(cell, "argument")!).getRaw()).toEqual(
      {
        count: "seven",
      },
    );
  });

  it("refuses a roll-forward onto a RUNNING piece whose swap already failed", async () => {
    // The reuse fast path, which is a second way to reach setup with the
    // pointer already naming the candidate — and the state a refused hot-swap
    // leaves behind, so the two interact.
    //
    // Sequence: the piece runs V1; the pointer moves to V2; the armed watcher
    // swaps, its setup REFUSES the stored argument, and it is logged rather
    // than thrown — so the piece keeps running V1 while the durable pointer now
    // reads V2 and `patternSetupIdentity` still reads V1. A repair then calls
    // `runSynced` with V2, and `maybeReuseRunningSetup` sees a running piece, a
    // matching pointer, and no supplied argument: it returns before
    // `applySetupState` ever runs. Without the setup-completion identity in
    // that gate, the repair reports success over an argument nothing validated.
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(openArgument("v1"), { space, tx });
    const v2 = await pm.compilePattern(typedCount("v2"), { space, tx });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "running-reuse-stale-marker",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { count: "seven" }, cell);
    await tx.commit();
    await running.pull();

    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit();
    await rt.idle();
    await cell.pull();
    // Precondition, asserted rather than assumed: the swap refused, so the
    // piece is still V1 under a pointer that reads V2. If this ever changes,
    // the case below is exercising a different situation than it describes.
    expect(
      (cell.getAsQueryResult() as { marker: string }).marker,
      "the swap did not refuse, so this case no longer sets up the " +
        "running-piece-with-stale-marker state it exists to test",
    ).toBe("v1");

    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), v2, undefined, {
        expectedPatternIdentity: v2Ref,
      });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();

    expect(
      error,
      "a repair over a RUNNING piece reported success without validating the " +
        "stored argument: `maybeReuseRunningSetup` returned before " +
        "`applySetupState`, so the re-stage never ran",
    ).toContain("updated arguments do not match the candidate schema");
  });

  it("refuses a HOT-SWAP whose stored argument the candidate rejects", async () => {
    // The other route, on a RUNNING piece: the `patternIdentity` watcher
    // services the stamp. This one already validated; it is here so the two
    // routes cannot drift apart silently.
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(openArgument("v1"), { space, tx });
    const v2 = await pm.compilePattern(typedCount("v2"), { space, tx });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "hot-swap-wrong-type",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { count: "seven" }, cell);
    await tx.commit();
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");

    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit();
    await rt.idle();
    await cell.pull();

    // A failed swap setup is logged, not thrown — `runSynced` is not in this
    // path — so the running version is the observable: the piece stays on V1
    // rather than running V2 over state V2 cannot read.
    expect(
      (cell.getAsQueryResult() as { marker: string }).marker,
      "the hot-swap accepted a durable argument the candidate schema rejects",
    ).toBe("v1");
  });
});
