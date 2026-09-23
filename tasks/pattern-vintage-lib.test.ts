import { expect } from "@std/expect";
import { exists } from "@std/fs";
import { describe, it } from "@std/testing/bdd";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import {
  schemaRelaxedForComparison,
  strandedKeys,
} from "../packages/piece/test/state-continuity-harness.ts";
import {
  companionFileName,
  companionSpace,
  vintageCompanionDir,
} from "../packages/piece/test/vintage-layout.ts";
import {
  armVerdictGuard,
  AUTO,
  AUTO_GENERATIONS_KEPT,
  autoGenerationsToPrune,
  collectVintages,
  describeCaptureOutcome,
  describeError,
  describePinOutcome,
  hoistSupersessionReason,
  isClean,
  isDerivedHoistSymbol,
  isStoredArgumentRefusal,
  judgeWholeTree,
  KNOWN_FLAGS,
  newestAutoGeneration,
  parseVintagePath,
  patternKeyFromMain,
  PINNED,
  promotedPath,
  promoteVintage,
  relativeToRepo,
  removeVintages,
  replayFilterTakes,
  replayScope,
  reportCaptureRefusedOnRed,
  reportCapturesSuperseded,
  reportDropsApplied,
  reportEmptyReplay,
  reportEveryGenerationCurrent,
  reportFailures,
  reportNothingMatched,
  reportNothingReplayed,
  reportNothingToPin,
  reportNoVerdict,
  reportOnlyWithCapture,
  reportPinNeedsOneTestKey,
  reportReplaySummary,
  reportUncovered,
  reportUnknownFlags,
  reportUnmappedUrls,
  reportUpdateNeedsATestKey,
  requiredPatternKeys,
  stampFor,
  uncoveredRequiredPatterns,
  unknownFlags,
  unmappedPatternUrls,
  vintageDir,
  vintageFileName,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import {
  acceptedDropKey,
  type AcceptedStateDrop,
} from "./pattern-vintage-accepted-drops.ts";
import { STORED_ARGUMENT_SCHEMA_REFUSAL } from "@commonfabric/runner";

const ID_A = "bafyaaaa";
const ID_B = "bafybbbb";

/**
 * Just the keys. Most comparison cases below are about WHICH keys are findings;
 * how each one GRADES is its own describe block at the end of that section.
 */
const findingKeys = (
  before: Record<string, unknown>,
  after: unknown,
): string[] => strandedKeys(before, after).map((finding) => finding.key);

describe("vintage paths", () => {
  it("round-trips a path it built itself", () => {
    const stamp = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    const path = `${vintageDir("system/home.test.tsx", PINNED)}/${
      vintageFileName(stamp, ID_A)
    }`;
    const parsed = parseVintagePath(path);

    expect(parsed).toEqual({
      testKey: "system/home.test.tsx",
      tier: PINNED,
      stamp,
      identity: ID_A,
      path,
    });
  });

  it("keeps the stamp whole even though it contains dashes", () => {
    // Splitting on the FIRST dash would cut "2026-07-29..." in half and hand
    // back a truncated stamp with a date fragment as the identity — sorting
    // and provenance both silently wrong, and nothing would throw. (The next
    // case covers the opposite error, which is the one that actually shipped.)
    const stamp = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    expect(stamp).toContain("-");
    const parsed = parseVintagePath(
      `${vintageDir("system/home.test.tsx", PINNED)}/${
        vintageFileName(stamp, ID_A)
      }`,
    );

    expect(parsed?.stamp).toBe(stamp);
    expect(parsed?.identity).toBe(ID_A);
  });

  it("keeps an identity that itself contains dashes whole", () => {
    // Not hypothetical: identities are base64url, and home.tsx's real one is
    // `xaLUAd13811rdYUEzKt7vaXYy-P8PAkhRcvqRshiNW4`. An earlier parse cut at
    // the LAST dash, so the gate failed to recognize a fixture it had just
    // written and reported the pattern as uncovered with the file sitting
    // right there. Both fields contain dashes; only the stamp's fixed shape
    // separates them.
    const stamp = stampFor(new Date("2026-07-29T16:40:22.484Z"));
    const dashed = "xaLUAd13811rdYUEzKt7vaXYy-P8PAkhRcvqRshiNW4";
    const parsed = parseVintagePath(
      `${vintageDir("system/home.test.tsx", PINNED)}/${
        vintageFileName(stamp, dashed)
      }`,
    );

    expect(parsed?.stamp).toBe(stamp);
    expect(parsed?.identity).toBe(dashed);
  });

  it("substitutes the colons an ISO stamp carries", () => {
    // Legal on POSIX, illegal on Windows. Sortability is the only property
    // retention needs, and substitution preserves it.
    const stamp = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    expect(stamp).not.toContain(":");
    expect(stamp).toBe("2026-07-29T16-33-28.000Z");
  });

  it("sorts lexically in capture order", () => {
    // Stage 4 retention drops the oldest AUTO captures by name alone, so the
    // stamp has to sort chronologically as a string.
    const early = stampFor(new Date("2026-07-29T09:00:00.000Z"));
    const late = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("keeps a pattern key with directories intact", () => {
    const path = `${
      vintageDir("battleship/multiplayer/lobby.test.tsx", AUTO)
    }/${vintageFileName("2026-01-01T00-00-00.000Z", ID_A)}`;
    const parsed = parseVintagePath(path);

    expect(parsed?.testKey).toBe("battleship/multiplayer/lobby.test.tsx");
    expect(parsed?.tier).toBe(AUTO);
  });

  it("declines anything that is not a fixture", () => {
    // Returning undefined rather than throwing is what lets the enumerator
    // walk a directory holding a README without the gate dying on it.
    for (
      const path of [
        `${VINTAGES_DIR}/system/home.test.tsx/pinned/README.md`,
        `${VINTAGES_DIR}/system/home.test.tsx/pinned/no-identity.sqlite`,
        `${VINTAGES_DIR}/loose.sqlite`,
        "packages/patterns/system/home.tsx",
        `${VINTAGES_DIR}/system/home.test.tsx/pinned/-${ID_A}.sqlite`,
      ]
    ) {
      expect(parseVintagePath(path), `should decline: ${path}`).toBeUndefined();
    }
  });

  it("declines a companion store — it is part of a fixture, not one", () => {
    // A multi-space fixture keeps its other spaces beside the primary file, and
    // each is a raw `.sqlite` under a `.sqlite.spaces/` directory. Enumerating
    // one as a vintage in its own right would replay another space's store
    // against a pattern key it never belonged to.
    const fixture = `${vintageDir("system/home.test.tsx", PINNED)}/${
      vintageFileName("2026-01-01T00-00-00.000Z", ID_A)
    }`;
    const companions = vintageCompanionDir(fixture);

    expect(parseVintagePath(fixture)).toBeDefined();
    expect(
      parseVintagePath(
        `${companions}/${encodeURIComponent("did:key:zChild")}.sqlite`,
      ),
    ).toBeUndefined();
    // Not merely because a DID does not parse as `<stamp>-<identity>`: a
    // companion whose name DOES look like one is still declined.
    expect(
      parseVintagePath(
        `${companions}/${vintageFileName("2026-01-01T00-00-00.000Z", ID_B)}`,
      ),
    ).toBeUndefined();
  });

  it("names a companion by its space, and declines one it could not have written", () => {
    // Round-trip first: a DID is full of `:` and survives the encoding intact.
    const did = "did:key:z6MkheCA7HT1DG4B4SvCi8eKiRt9r14iYzQowFLgwC8k7UR8";
    expect(companionSpace(companionFileName(did))).toBe(did);

    // And the guard. A bare `decodeURIComponent` THROWS on a malformed escape,
    // so one stray file in a companion directory would take down every fixture
    // in the run rather than its own — the failure mode this gate exists to not
    // have. `spaceFromStoreFilename` guards the store layout the same way.
    expect(() => decodeURIComponent("%zz")).toThrow();
    expect(companionSpace("%zz.sqlite")).toBeUndefined();
    expect(companionSpace("README.md")).toBeUndefined();
  });
});

describe("coverage", () => {
  it("reports a required pattern with no vintage", () => {
    // Coverage is what the replay actually REPLAYED, not what the fixture tree
    // looks like: a fixture is named after the test that made it and covers
    // several patterns, so a directory name is no longer the evidence.
    const uncovered = uncoveredRequiredPatterns(
      ["system/home.tsx", "system/default-app.tsx"],
      new Set(["system/home.tsx"]),
    );

    expect(uncovered).toEqual(["system/default-app.tsx"]);
  });

  it("does not require a vintage for a pattern nobody auto-updates", () => {
    // A vintage that EXISTS is always replayed; this list only governs what is
    // REQUIRED. Requiring everything under system/ would wedge the gate on the
    // files there that are not patterns at all.
    expect(uncoveredRequiredPatterns(
      ["system/home.tsx"],
      new Set(["system/home.tsx"]),
    )).toEqual([]);
  });

  it("derives the required set from the runtime's own URL constants", () => {
    // Hand-listing them would let the gate drift from what actually
    // auto-updates — silently covering nothing the day a third root is added.
    expect(requiredPatternKeys([
      "/api/patterns/system/home.tsx",
      "/api/patterns/system/default-app.tsx",
    ])).toEqual(["system/default-app.tsx", "system/home.tsx"]);
  });

  it("ignores a URL that is not a pattern route", () => {
    expect(requiredPatternKeys(["/api/meta", ""])).toEqual([]);
  });

  it("derives keys from the `system:` refs the runtime actually holds", () => {
    expect(requiredPatternKeys([
      "system:system/home.tsx",
      "system:system/default-app.tsx",
    ])).toEqual(["system/default-app.tsx", "system/home.tsx"]);
    // A source naming no route is not silently dropped from the required set:
    // it stays unmapped, and the caller refuses to run on it.
    expect(unmappedPatternUrls(["system:system/home.tsx"])).toEqual([]);
    expect(unmappedPatternUrls(["system:", "cf:published"]))
      .toEqual(["system:", "cf:published"]);
  });

  it("names a URL the derivation could not map, rather than dropping it", () => {
    // The dangerous shape: reroute the patterns endpoint and every required
    // key derives to nothing, leaving a gate that insists on nothing while
    // still exiting 0. The caller refuses to run on this, so the drift is
    // loud rather than a silently empty requirement.
    expect(unmappedPatternUrls([
      "/api/patterns/system/home.tsx",
      "/api/pattern/system/default-app.tsx",
    ])).toEqual(["/api/pattern/system/default-app.tsx"]);
    expect(unmappedPatternUrls(["/api/patterns/system/home.tsx"])).toEqual([]);
  });

  it("ignores covered keys nothing required", () => {
    // Coverage is asked per REQUIRED key, so a fixture covering extra patterns
    // neither helps nor hurts. (Deduplication is not tested here and cannot be:
    // the argument is a Set, so `new Set([x, x])` collapses before the call —
    // an earlier version of this case asserted exactly that and could not fail.
    // What builds the set is `replayVintage`, covered by
    // "credits coverage only for a PINNED fixture" in
    // `pattern-vintage-run.test.ts`.)
    expect(uncoveredRequiredPatterns(
      ["system/home.tsx"],
      new Set(["system/home.tsx", "topics/main.tsx", "lunch-poll/main.tsx"]),
    )).toEqual([]);
    // ...and a near-miss is still uncovered: matching is by exact key.
    expect(uncoveredRequiredPatterns(
      ["system/home.tsx"],
      new Set(["system/home.test.tsx"]),
    )).toEqual(["system/home.tsx"]);
  });
});

describe("collectVintages", () => {
  it("finds fixtures at any depth and ignores non-fixtures", async () => {
    const root = await Deno.makeTempDir({ prefix: "vintage-collect-" });
    try {
      const dir = `${root}/system/home.test.tsx/pinned`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/2026-07-29T16-33-28.000Z-${ID_A}.sqlite`,
        "",
      );
      await Deno.writeTextFile(`${dir}/README.md`, "not a fixture");

      const found = await collectVintages(root);
      expect(found.map((v) => ({
        testKey: v.testKey,
        tier: v.tier,
        identity: v.identity,
      }))).toEqual([
        { testKey: "system/home.test.tsx", tier: PINNED, identity: ID_A },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  });

  it("returns empty rather than throwing when the tree does not exist", async () => {
    // "No fixtures yet" must report as uncovered patterns — the actionable
    // message — not as an ENOENT from the gate.
    expect(await collectVintages("/nonexistent/vintages/root")).toEqual([]);
  });
});

describe("reporting", () => {
  const failure = {
    testKey: "system/home.test.tsx",
    path: `${VINTAGES_DIR}/system/home.test.tsx/pinned/x.sqlite`,
    detail: "materializing today's source over this vintage was REFUSED",
  };

  it("names every uncovered pattern and the command that fixes it", () => {
    // The report is the gate's entire interface to whoever trips it. A gate
    // that fails with an unclear message costs more than one that fails late.
    const report = reportUncovered([
      "system/home.tsx",
      "system/default-app.tsx",
    ]);

    expect(report).toContain("system/home.tsx");
    expect(report).toContain("system/default-app.tsx");
    expect(report).toContain("deno task pattern-vintage --update <test path>");
    // Says WHY it matters, not just what is missing — the reader is usually
    // someone who has never heard of this gate.
    expect(report).toContain("bricks that piece");
  });

  it("names the pattern, the fixture, and the rejection for each failure", () => {
    const report = reportFailures([failure]);

    // The fixture is named after the TEST that produced it, so that is what a
    // failure line points at — the manifest says which patterns it covers.
    expect(report).toContain("system/home.test.tsx");
    expect(report).toContain(failure.path);
    expect(report).toContain("REFUSED");
    // The stakes, because a red gate on a test fixture reads as ignorable and
    // this one is not.
    expect(report).toContain("deployed piece is holding RIGHT NOW");
  });

  it("reports every failure, not just the first", () => {
    const report = reportFailures([
      failure,
      { ...failure, testKey: "system/default-app.tsx" },
    ]);

    expect(report).toContain("2 vintage(s)");
    expect(report).toContain("system/default-app.tsx");
  });

  it("passes only when there is nothing to report", () => {
    // Stated once and tested, rather than an `if` at the bottom of main that a
    // later edit can quietly invert. A gate that exits 0 on failure is worse
    // than no gate at all.
    const counts = { replayed: 2, candidates: 5, targets: 5 };
    expect(isClean([], [], counts)).toBe(true);
    expect(isClean([failure], [], counts)).toBe(false);
    expect(isClean([], ["system/home.tsx"], counts)).toBe(false);
    expect(isClean([failure], ["system/home.tsx"], counts)).toBe(false);
  });

  it("states what a PASS actually covered, targets included", () => {
    // The success line is the whole of what a green run tells its reader, and
    // `targets` is the number that keeps it honest: 12 recorded instantiations
    // of which only 5 could be applied is very different coverage from 12 of 12.
    const summary = reportReplaySummary({
      replayed: 2,
      candidates: 12,
      targets: 5,
      changed: 3,
      updated: 3,
      servedRoute: 0,
    });

    expect(summary).toBe(
      "Replayed 2 vintage(s): 12 recorded instantiation(s), all mappable to " +
        "a file; 5 upgrade target(s), 3 changed since capture, 3 updated " +
        "cleanly with no state stranded.",
    );
  });

  it("says when targets went unexamined as SERVED ROUTES", () => {
    // A served route is a target the run deliberately did not identity-compare
    // — the same file compiles to a different identity served than from the
    // repo, so comparing would report it changed forever. The count existed to
    // stop a mostly-served-route fixture reading as thorough coverage, and
    // nothing displayed it, so it stopped one from nothing at all.
    expect(reportReplaySummary({
      replayed: 1,
      candidates: 12,
      targets: 5,
      changed: 3,
      updated: 3,
      servedRoute: 2,
    })).toContain(
      "2 target(s) were served routes and not identity-compared.",
    );
  });

  it("names each derived target held back once, with the rule that held it", () => {
    // A target can be raised by several vintages, and the count is of targets
    // rather than of times one came up — otherwise "held 6 back" describes two
    // targets and reads as four more than are there.
    const report = reportCapturesSuperseded([
      "topics/topics.tsx#rows",
      "system/home.tsx#nav",
      "topics/topics.tsx#rows",
    ]);

    expect(report).toContain("Held 2 derived sub-pattern target(s) back");
    // Sorted, so a run's output does not reorder with the replay order.
    expect(report.split("\n").slice(1)).toEqual([
      "  system/home.tsx#nav",
      "  topics/topics.tsx#rows",
    ]);
    // The grounds travel with the count. A held-back target read without them
    // looks like state the gate lost rather than state it re-supplies.
    expect(report).toContain(
      "a hoist is derivation the updated source re-runs",
    );
    expect(report).toContain("root contracts still gate");
  });

  it("names the exemption list beside the paths it forgave", () => {
    // The reader's next move is to retire the entry once the removal it was
    // granted for is done, so the report says where that entry lives.
    const report = reportDropsApplied(
      new Set(["topics/topics.tsx journal", "system/home.tsx nav"]),
    );

    expect(report).toContain("Held 2 path(s) back from their vintage");
    expect(report).toContain("tasks/pattern-vintage-accepted-drops.ts");
    expect(report.split("\n").slice(1)).toEqual([
      "  system/home.tsx nav",
      "  topics/topics.tsx journal",
    ]);
  });

  it("refuses --update with no test named, and says what to name", () => {
    // There is deliberately no default set. The only moment one would help is
    // when a fixture is MISSING — precisely when nothing on disk can say which
    // test covers the pattern, since a test need not be named after what it
    // drives. The hand-kept list that used to stand in for that answer was a
    // seam: the required PATTERNS derive from the runtime's URL constants, so
    // adding one no listed test instantiated left the gate red while --update
    // reported everything fine and exited 0.
    const message = reportUpdateNeedsATestKey();

    expect(message).toContain("--update <test path>");
    // A concrete example, because "test path" alone is the thing people get
    // wrong — a pattern path names no test and captures nothing.
    expect(message).toContain("topics/topics.test.tsx");
    expect(message).toContain("not a pattern");
    // And the fact that removes the recurring confusion: nothing lists what
    // CI replays, so committing a fixture is the whole of adding one.
    expect(message).toContain("no list anywhere");
  });

  it("gives each uncovered pattern the ONE remedy that fits its situation", () => {
    // Four situations, four different pieces of advice, and each must exclude
    // the others' — a merge is the defect this split keeps producing, and it
    // is invisible unless the assertions say what each case must LACK as well
    // as contain.
    //
    // Every branch is chosen from an argument, never inferred from output this
    // function does not control. That is the property under test: hand it the
    // same pattern in four different situations and the advice must change.
    const from = (testKey: string, pinned = true) => ({ testKey, pinned });
    const HOME = "system/home.tsx";
    const TEST = "system/home.test.tsx";
    const recorded = new Map([[HOME, from(TEST)]]);
    const recordedAuto = new Map([[HOME, from(TEST, false)]]);

    // 1. Recorded by a fixture that FAILED. Capturing another would change
    //    nothing; the printed failure carries the remedy.
    const broken = reportUncovered([HOME], recorded, new Set([TEST]));
    expect(broken).toContain("(recorded by system/home.test.tsx)");
    expect(broken).toContain("FAILED this run");
    expect(broken).not.toContain("--pin");
    expect(broken).not.toContain("<test path>");

    // 2. Recorded by an AUTO generation that replayed cleanly. This is the
    //    branch that could not fire at all until something wrote an auto
    //    capture, and the one whose absent producer cost a defect a round.
    const promotable = reportUncovered([HOME], recordedAuto, new Set());
    expect(promotable).toContain("deno task pattern-vintage --pin " + TEST);
    expect(promotable).not.toContain("FAILED this run");
    expect(promotable).not.toContain("<test path>");

    // 3. Recorded by a PINNED fixture that did not fail — no known route
    //    reaches it, so it must NOT invent an instruction.
    const unexplained = reportUncovered([HOME], recorded, new Set());
    expect(unexplained).toContain("no known route");
    expect(unexplained).not.toContain("--pin");
    expect(unexplained).not.toContain("--update");

    // 4. Named by nothing at all. The test cannot be derived, so the
    //    placeholder stands rather than a concrete key.
    const unnamed = reportUncovered(["system/newcomer.tsx"], new Map());
    expect(unnamed).not.toContain("recorded by");
    expect(unnamed).toContain("--update <test path>");
    expect(unnamed).not.toContain("--pin");
    expect(unnamed).not.toContain("FAILED this run");

    // The tier now CHANGES the advice, where it used to be a tie-break only.
    // Asserting the two differ is what would catch the branch being collapsed
    // back: every other assertion here passes with `pinned` ignored entirely.
    expect(promotable).not.toBe(unexplained);

    // All four at once, each keeping its own remedy rather than collapsing
    // into whichever branch happens to be evaluated first.
    const mixed = reportUncovered(
      [HOME, "topics/main.tsx", "system/newcomer.tsx"],
      new Map([
        [HOME, from(TEST)],
        ["topics/main.tsx", from("topics/topics.test.tsx", false)],
      ]),
      new Set([TEST]),
    );
    expect(mixed).toContain("FAILED this run");
    expect(mixed).toContain(
      "deno task pattern-vintage --pin topics/topics.test.tsx",
    );
    expect(mixed).toContain("--update <test path>");
  });

  it("names each promotable test key ONCE, however many patterns it records", () => {
    // A fixture routinely records several patterns — that is the whole reason
    // fixtures are keyed by TEST — so a per-pattern loop prints the identical
    // `--pin` line once per pattern. Harmless-looking, and it is how a reader
    // concludes there are three things to do when there is one.
    const auto = (testKey: string) => ({ testKey, pinned: false });
    const message = reportUncovered(
      ["topics/main.tsx", "topics/topic.tsx", "topics/list.tsx"],
      new Map([
        ["topics/main.tsx", auto("topics/topics.test.tsx")],
        ["topics/topic.tsx", auto("topics/topics.test.tsx")],
        ["topics/list.tsx", auto("topics/topics.test.tsx")],
      ]),
    );

    const pins = message.split("\n").filter((line) => line.includes("--pin"));
    expect(pins).toEqual([
      "  deno task pattern-vintage --pin topics/topics.test.tsx",
    ]);
    // All three patterns are still LISTED — deduping the command must not
    // dedupe the inventory, or two of the three go unmentioned.
    expect(message).toContain("topics/topic.tsx");
    expect(message).toContain("topics/list.tsx");
  });

  it("FAILS a run that replayed nothing, however clean it looks", () => {
    // The catastrophic shape: no failures, nothing uncovered, and no evidence
    // whatsoever. A run that replays nothing proves nothing, so it cannot be
    // the same answer as a run that replayed everything and found it readable.
    expect(isClean([], [], { replayed: 0, candidates: 0, targets: 0 })).toBe(
      false,
    );
    // The same shape one level in: fixtures replayed, but between them they
    // recorded no instantiation, so no update target was examined. "Replayed 2
    // vintage(s)" would read as success while proving nothing.
    expect(isClean([], [], { replayed: 2, candidates: 0, targets: 0 })).toBe(
      false,
    );
    // And one further in still: instantiations were recorded, but not one of
    // them is something today's source can be applied to — every candidate a
    // test pattern or a keyless session pointer. Nothing was updated and nothing
    // could have been, so this is not a pass either.
    expect(isClean([], [], { replayed: 2, candidates: 7, targets: 0 })).toBe(
      false,
    );
    expect(reportNothingReplayed()).toContain("covered NOTHING");
    // WITH the argument. Bare `--update` exits 1 without capturing, so a
    // recovery instruction that omits it sends a fresh checkout nowhere.
    expect(reportNothingReplayed()).toContain(
      "deno task pattern-vintage --update <test path>",
    );
  });

  it("names the URLs that stopped deriving a required pattern", () => {
    const report = reportUnmappedUrls(["/api/pattern/system/home.tsx"]);

    expect(report).toContain("/api/pattern/system/home.tsx");
    expect(report).toContain("requiredPatternKeys");
  });

  it("fails the run when the process ends without a verdict", () => {
    // The wiring, not just the message. This guard is the one piece of the
    // gate whose failure mode is SILENCE — before it, a `home.tsx` that did
    // not compile exited 0 with no output at all — so the listeners being
    // attached to the right events, in the right order, is the assertion.
    const target = new EventTarget();
    const exits: number[] = [];
    const logs: string[] = [];
    armVerdictGuard(target, (code) => exits.push(code), (m) => logs.push(m));

    const rejection = Object.assign(new Event("unhandledrejection"), {
      reason: new Error("database disk image is malformed"),
    });
    target.dispatchEvent(rejection);
    target.dispatchEvent(new Event("beforeunload"));

    expect(exits).toEqual([1]);
    // The rejection has to survive to the message: "something went wrong
    // somewhere" would send the reader looking in the wrong place.
    expect(logs[0]).toContain("database disk image is malformed");
  });

  it("still fails when no rejection was ever observed", () => {
    // A promise that simply never settles leaves nothing to report, and that
    // must still be a red rather than a pass for lack of evidence.
    const target = new EventTarget();
    const exits: number[] = [];
    armVerdictGuard(target, (code) => exits.push(code), () => {});

    target.dispatchEvent(new Event("beforeunload"));

    expect(exits).toEqual([1]);
  });

  it("explains an end with no verdict, and carries the rejection", () => {
    // Measured twice — a pattern that does not compile, and a truncated
    // fixture — both leave the replay's promise pending forever while the real
    // error surfaces as a rejection nobody awaits. The reader needs the
    // rejection, or the message is "something went wrong somewhere".
    const report = reportNoVerdict(
      new Error("database disk image is malformed"),
    );

    expect(report).toContain("without reaching a verdict");
    expect(report).toContain("database disk image is malformed");
    // And it still says something useful when nothing was observed.
    expect(reportNoVerdict(undefined)).toContain("unresolved await");
  });
});

describe("path and error helpers", () => {
  it("strips the repo root and leaves an outside path alone", () => {
    expect(relativeToRepo("/repo/packages/x.gz", "/repo")).toBe(
      "packages/x.gz",
    );
    expect(relativeToRepo("/elsewhere/x.gz", "/repo")).toBe("/elsewhere/x.gz");
  });

  it("describes a non-Error throw without rendering it useless", () => {
    // `String({})` is "[object Object]", which satisfies a truthiness check
    // while destroying the reason — the class of bug that made an earlier
    // rejection assertion pass for nothing.
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain string")).toBe("plain string");
  });
});

describe("stranded-state comparison", () => {
  it("reports a key whose value the update stopped preserving", () => {
    // The class the gate exists for. A moved storage key leaves the contract
    // untouched and the data unreachable, so the value is the only witness.
    expect(findingKeys(
      { journal: [{ event: "created" }], items: ["a"] },
      { journal: [], items: ["a"] },
    )).toEqual(["journal"]);
  });

  it("does not report a key the update ADDED", () => {
    // Adding a field is what `Default<>` is for. Only keys present BEFORE are
    // compared; treating a new key as loss would fail every additive change.
    expect(findingKeys({ items: ["a"] }, { items: ["a"], favorites: [] }))
      .toEqual([]);
  });

  it("reports a key that disappeared entirely", () => {
    expect(findingKeys({ items: ["a"] }, {})).toEqual(["items"]);
  });

  it("treats a missing after-state as everything stranded", () => {
    // A materialize that produced no readable root lost all of it; saying
    // "nothing changed" there would be the quietest possible false green.
    expect(findingKeys({ a: 1, b: 2 }, undefined)).toEqual(["a", "b"]);
  });

  it("compares by value, not identity", () => {
    expect(findingKeys({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(findingKeys({ a: [1, 2] }, { a: [2, 1] })).toEqual(["a"]);
  });

  it("does not treat an empty before-state as a finding", () => {
    // A vintage whose root held nothing has nothing to strand. The "did it
    // restore" control is what catches an empty fixture; this must not
    // double-report it as data loss.
    expect(findingKeys({}, { items: ["a"] })).toEqual([]);
  });

  it("does not compare the RENDERINGS", () => {
    // `$UI` and its variants are recomputed by the setup, and the stored
    // rendering and a fresh one are not the same artifact — measured on the
    // committed `default-app.tsx` fixture, a COMMENT-only edit to
    // `piece-grid.tsx` reports `$UI` as stranded. Comparing them says nothing
    // about data and reds every pattern edit.
    expect(findingKeys(
      { $UI: { children: [null] }, $TILE_UI: { a: 1 }, $CHIP_UI: 1, items: [] },
      { $UI: { children: [[]] }, $TILE_UI: { a: 2 }, $CHIP_UI: 2, items: [] },
    )).toEqual([]);
  });

  it("does not compare a RENDERING that sits under no `$UI` key", () => {
    // The name list cannot reach this one. A transformer hoist
    // (`__cfPattern_N`, the body of a `map`) is a recorded instantiation in its
    // own right, and its whole result is a vnode — keys `type`/`name`/`props`/
    // `children`, no `$UI` anywhere. Measured on the committed
    // `default-app.tsx` fixture, which records two of them: a UI-only edit
    // inside that map body reported `children` stranded on both and took the
    // gate to exit 1, for a change that stores nothing.
    const row = (label: string) => ({
      type: "vnode",
      name: "tr",
      props: {},
      children: [{ type: "vnode", name: "td", props: {}, children: [label] }],
    });
    expect(findingKeys(row("🗑️"), row("✕"))).toEqual([]);
    // ...and nested inside state, where the name list cannot reach it either.
    expect(findingKeys(
      { items: [{ label: "a", view: row("🗑️") }] },
      { items: [{ label: "a", view: row("✕") }] },
    )).toEqual([]);
  });

  it("still reports a key whose RENDERING became data, or data a rendering", () => {
    // The reduction is not a blanket skip of anything vnode-shaped: it says
    // "two renderings are the same artifact", not "this key is exempt".
    const view = { type: "vnode", name: "tr", props: {}, children: [] };
    expect(findingKeys({ preview: view }, { preview: ["a"] }))
      .toEqual(["preview"]);
    expect(findingKeys({ preview: ["a"] }, { preview: view }))
      .toEqual(["preview"]);
  });

  it("still compares $NAME, which is derived but stable", () => {
    // The exclusion is the renderings, NOT derived values in general: `$NAME`
    // stayed equal across both measured UI-only edits, and it is a cheap tell
    // that the data behind it went missing.
    expect(findingKeys({ $NAME: "Home (2)" }, { $NAME: "Home (0)" }))
      .toEqual(["$NAME"]);
  });

  it("compares a `FabricValue` by its CONTENTS", () => {
    // The quietest failure this comparison could have. A `FabricSpecialObject`
    // keeps its state in private fields, so a structural comparison sees two
    // objects with no properties and calls them equal whatever they hold —
    // `deepEqual` documents exactly that. Reduced to a tagged content hash
    // first, so a changed one is a finding and an unchanged one is not.
    const held = new FabricBytes(new Uint8Array([1, 2, 3]));
    const identical = new FabricBytes(new Uint8Array([1, 2, 3]));
    const different = new FabricBytes(new Uint8Array([9, 9, 9]));
    expect(findingKeys({ blob: held }, { blob: identical })).toEqual([]);
    expect(findingKeys({ blob: held }, { blob: different })).toEqual(["blob"]);
  });

  it("grades a value that went EMPTY as lost, and one that merely changed as not", () => {
    // The grading the gate keys its verdict on: `lost` fails, a bare change
    // only warns. All three of these are real measurements from the committed
    // fixtures, and none of them is data going missing — each is the new
    // version resolving something the old one had left unresolved, because a
    // replay recomputes as well as reads.
    const changed = [
      // `topic.tsx` backfilling from its own `createdByName` shadow.
      [{ createdBy: { kind: "person", name: "" } }, {
        createdBy: { kind: "person", name: "t" },
      }],
      [{ $NAME: "Topics (2)" }, { $NAME: "Topics (3)" }],
      [{ artSyncState: "" }, { artSyncState: "generated" }],
    ] as const;
    for (const [before, after] of changed) {
      const findings = strandedKeys(before, after);
      expect(findings.length, `${JSON.stringify(before)}`).toBe(1);
      expect(findings[0].lost, `${JSON.stringify(before)} should only warn`)
        .toBe(false);
    }

    // ...and the shape that still stops the gate: something became nothing.
    for (
      const [before, after] of [
        [{ journal: [{ event: "created" }] }, { journal: [] }],
        [{ items: ["a"] }, {}],
        [{ title: "captured" }, { title: "" }],
        [{ count: 7 }, { count: 0 }],
        [{ enabled: true }, { enabled: false }],
        [{ child: { note: "captured" } }, { child: {} }],
      ] as const
    ) {
      const findings = strandedKeys(before, after);
      expect(findings.length, `${JSON.stringify(before)}`).toBe(1);
      expect(findings[0].lost, `${JSON.stringify(before)} should FAIL`)
        .toBe(true);
    }
  });

  it("grades PARTIAL loss as lost, not merely changed", () => {
    // The class whole-value grading missed. `isEmptyValue` is shallow, so
    // judging emptiness only at the top means a key fails only when it empties
    // ENTIRELY — and a `.for()` list, the commonest durable shape here, almost
    // never does. Every row below was measured WARNING before the emptiness
    // test recursed, which is the gate reporting "state changed" for state that
    // is gone.
    for (
      const [label, before, after] of [
        ["rows unreadable", { items: ["a", "b", "c"] }, {
          items: [undefined, undefined, undefined],
        }],
        ["array truncated", { items: ["a", "b", "c"] }, { items: ["a"] }],
        ["sibling survives", { profile: { name: "ada", id: 1 } }, {
          profile: { id: 1 },
        }],
        ["row body emptied", { items: [{ t: "x", body: "real" }] }, {
          items: [{ t: "x", body: "" }],
        }],
        ["array became an object", { items: ["a"] }, { items: { 0: "a" } }],
      ] as const
    ) {
      const findings = strandedKeys(before, after);
      expect(findings.length, label).toBe(1);
      expect(findings[0].lost, `${label} should FAIL, not warn`).toBe(true);
    }

    // ...and the recursion costs none of the warnings it was added alongside:
    // a leaf that was ALREADY empty had nothing to lose, and two non-empty
    // scalars differing is a change.
    for (
      const [label, before, after] of [
        ["nested gain", { createdBy: { kind: "person", name: "" } }, {
          createdBy: { kind: "person", name: "t" },
        }],
        ["row gained a field", { items: [{ t: "x" }] }, {
          items: [{ t: "x", extra: "new" }],
        }],
        ["scalar replaced", { note: "written" }, { note: "captured" }],
      ] as const
    ) {
      const findings = strandedKeys(before, after);
      if (findings.length === 0) continue; // an addition is not a finding
      expect(findings[0].lost, `${label} should only warn`).toBe(false);
    }
  });

  it("does not call a value lost when it was already empty", () => {
    // Nothing to lose. An empty-to-different transition is the ordinary
    // additive case a replay produces constantly, and grading it as loss would
    // fail the gate on every field a new version starts filling in.
    const findings = strandedKeys({ note: "" }, { note: "written" });
    expect(findings.map((finding) => finding.lost)).toEqual([false]);
  });

  it("grades a REPOINTED cell as changed, and a vanished one as lost", () => {
    // `{"[cell]": {...}}` is an identity, not a container: a cell that looks
    // empty still names a document. So a cell pointing somewhere ELSE is a
    // change, not an emptying, and only WARNS.
    //
    // That is a real limit and it is deliberate, not an oversight: a pattern
    // update rotates compiler-generated internal cell identities on purpose,
    // so failing on a moved reduction would red every legitimate edit. The
    // consequence is that a genuinely repointed `of:` document is warned about
    // rather than failed on — the `of:`-versus-`computed:` weighting noted on
    // `StateFinding` is what would separate the two, and the reduction carries
    // the id that would answer it.
    const cell = (id: string) => ({ "[cell]": { space: "s", id, path: [] } });
    const findings = strandedKeys({ ref: cell("a") }, { ref: cell("b") });
    expect(findings.map((finding) => finding.key)).toEqual(["ref"]);
    expect(findings[0].lost).toBe(false);
    // A cell that became NOTHING is lost — the emptiness test runs before the
    // identity comparison, so this is not covered by the warn above.
    expect(strandedKeys({ ref: cell("a") }, {})[0].lost).toBe(true);
    // ...including one nested inside a container that survives, which is the
    // shape whole-value grading used to miss.
    expect(
      strandedKeys({ box: { ref: cell("a"), keep: 1 } }, {
        box: { keep: 1 },
      })[0].lost,
    ).toBe(true);
  });

  it("survives a value that points back at itself", () => {
    // A materialized root can be cyclic — the live cell at every stream
    // position reaches the runtime, which reaches itself. Left in, the
    // comparison recurses until the stack ends and takes every remaining
    // fixture down with it.
    const before: Record<string, unknown> = { items: ["a"] };
    before.self = before;
    const after: Record<string, unknown> = { items: ["a"] };
    after.self = after;
    expect(findingKeys(before, after)).toEqual([]);
  });
});

describe("stranded-state comparison is a SUBSET check", () => {
  it("does not report a nested object that gained a field", () => {
    // The false positive the cross-space case surfaced. An update may ADD, and
    // additions are not only top-level: a nested pattern gaining a defaulted
    // field turns {note, owner} into {note, owner, addedLater: []} several
    // levels down. Comparing for equality reds a perfectly compatible change.
    expect(findingKeys(
      { child: { note: "captured", owner: "v" } },
      { child: { owner: "v", note: "captured", addedLater: [] } },
    )).toEqual([]);
  });

  it("still reports a nested value that CHANGED", () => {
    expect(findingKeys(
      { child: { note: "captured" } },
      { child: { note: "different" } },
    )).toEqual(["child"]);
  });

  it("still reports a nested key that DISAPPEARED", () => {
    expect(findingKeys({ child: { note: "captured" } }, { child: {} }))
      .toEqual(["child"]);
  });

  it("allows an array to grow but not to lose or reorder", () => {
    // Appending is an addition. Truncating loses data, and reordering moves an
    // element out from under a reader that knew its index.
    expect(findingKeys({ xs: [1, 2] }, { xs: [1, 2, 3] })).toEqual([]);
    expect(findingKeys({ xs: [1, 2] }, { xs: [1] })).toEqual(["xs"]);
    expect(findingKeys({ xs: [1, 2] }, { xs: [2, 1] })).toEqual(["xs"]);
  });

  it("does NOT subset a reduction — a cell is an identity, not a shape", () => {
    // `{"[cell]": {space, id, path}}` is what a cell- or stream-valued key
    // reduces to, and its `path` is an array. Left to the subset rule, a
    // longer path is a superset and so "preserved": a stream that moved from
    // the document root to `["value"]` in the SAME document would read clean,
    // which is the moved-storage class this whole comparison exists for.
    const at = (path: string[]) => ({
      "[cell]": { space: "did:key:zA", id: "of:fid1:one", path },
    });
    expect(findingKeys({ touch: at([]) }, { touch: at([]) })).toEqual([]);
    expect(findingKeys({ touch: at([]) }, { touch: at(["value"]) }))
      .toEqual(["touch"]);
    expect(findingKeys({ touch: at(["a"]) }, { touch: at(["b"]) }))
      .toEqual(["touch"]);
  });

  it("treats a before-value of `undefined` as nothing to strand", () => {
    // The before state is read under the root's stored schema, and a
    // schema-driven read enumerates the keys the schema DECLARES whether or not
    // the document holds them — measured on the committed `home.tsx` fixture,
    // `defaultProfile` reads as `undefined` because that root predates any
    // profile being created. An update that starts filling one in — a
    // `Default<>` added to a field already declared — added data rather than
    // stranding it.
    expect(findingKeys({ defaultProfile: undefined }, { defaultProfile: "v" }))
      .toEqual([]);
    // The other direction is still loss: something was there, and is not now.
    expect(findingKeys({ defaultProfile: "v" }, { defaultProfile: undefined }))
      .toEqual(["defaultProfile"]);
  });
});

/**
 * The read the comparison rests on, and the one place it could go silently
 * blind: a value the schema does not resolve arrives here as `undefined`, which
 * the rule above then reads as "held nothing".
 */
describe("relaxing the stored schema for reading", () => {
  it("drops an `unknown` type wherever it sits", () => {
    // Both spellings, because a pattern reaches them differently: a DECLARED
    // `unknown` field lowers to the first, and an index signature
    // (`[key: string]: unknown`, which `system/default-app.tsx` declares) to
    // the second. Measured on the committed `default-app.tsx` fixture, the
    // second is what hid `summaryIndex`, which the result type does not name.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: { note: { type: "unknown" } },
      additionalProperties: { type: "unknown" },
    })).toEqual({
      type: "object",
      properties: { note: {} },
      additionalProperties: {},
    });
  });

  it("drops a union that INCLUDES `unknown`, which constrains nothing", () => {
    expect(schemaRelaxedForComparison({ type: ["string", "unknown"] }))
      .toEqual({});
    // ...and leaves a union that does not.
    expect(schemaRelaxedForComparison({ type: ["string", "null"] }))
      .toEqual({ type: ["string", "null"] });
  });

  it("keeps every other keyword, so a stream still reduces to its document", () => {
    // What makes this a RELAXATION rather than a different read. Reading under
    // a bare `{}` would resolve the same keys, but without `asCell` a stream
    // comes back as its VALUE instead of the document it points at — and a
    // field that moved to a different doc is the class this comparison exists
    // for.
    expect(schemaRelaxedForComparison({
      asCell: ["stream"],
      type: "unknown",
      ifc: { classification: ["secret"] },
    })).toEqual({ asCell: ["stream"], ifc: { classification: ["secret"] } });
  });

  it("relaxes inside `$defs`, which is where a `$ref` lands", () => {
    expect(schemaRelaxedForComparison({
      $ref: "#/$defs/Row",
      $defs: {
        Row: { type: "object", properties: { v: { type: "unknown" } } },
      },
    })).toEqual({
      $ref: "#/$defs/Row",
      $defs: { Row: { type: "object", properties: { v: {} } } },
    });
  });

  it("keeps a property that is NAMED `type`", () => {
    // The keyword and a property name are the same string. Dropping on the key
    // alone would delete the property, which is a schema the document no longer
    // matches rather than a relaxed one.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: { type: { type: "unknown" } },
    })).toEqual({
      type: "object",
      properties: { type: {} },
    });
  });

  it("drops `required` at every depth", () => {
    // A schema-driven read answers `undefined` for the WHOLE object when a
    // required property does not resolve. Patterns mark session-local drafts
    // required — `topic.tsx` requires `bodyDraft`, `editingBody` and three
    // more — and those are links to per-session cells a fresh replay runtime
    // holds nothing for. Enforcing it hid all 28 keys of real state behind one
    // absent draft, which is the opposite of what a comparison wants: it turns
    // the moved key the gate is hunting into an unreadable root.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: {
        row: {
          type: "object",
          properties: { v: { type: "string" } },
          required: ["v"],
        },
      },
      required: ["row"],
    })).toEqual({
      type: "object",
      properties: {
        row: { type: "object", properties: { v: { type: "string" } } },
      },
    });
  });

  it("keeps a property that is NAMED `required`", () => {
    // Same collision as `type`: the keyword's value is an ARRAY of names, a
    // property of that name holds a schema object. Matching on the key alone
    // would delete the property.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: { required: { type: "boolean" } },
      required: ["required"],
    })).toEqual({
      type: "object",
      properties: { required: { type: "boolean" } },
    });
  });

  it("leaves a schema with neither `unknown` nor `required` alone", () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
    };
    expect(schemaRelaxedForComparison(schema)).toEqual(schema);
    // Booleans are schemas too, and neither is an object to walk.
    expect(schemaRelaxedForComparison(true)).toBe(true);
    expect(schemaRelaxedForComparison(false)).toBe(false);
  });
});

describe("a recorded `main` maps back to a pattern key", () => {
  it("takes a repo path", () => {
    expect(
      patternKeyFromMain(
        "/packages/patterns/system/home.tsx",
        "/packages/patterns/",
      ),
    )
      .toBe("system/home.tsx");
  });

  it("takes the ROUTE the toolshed serves a pattern at", () => {
    // Not hypothetical: `lunch-poll/main.tsx` loads `profile-create` by URL, so
    // its manifest records `/api/patterns/...`. Resolved against the repo root
    // that is `<repo>/api/patterns/...`, which does not exist — the replay
    // reported a pattern sitting right there as unresolvable.
    expect(
      patternKeyFromMain(
        "/api/patterns/system/profile-create.tsx",
        "/packages/patterns/",
      ),
    )
      .toBe("system/profile-create.tsx");
  });

  it("declines an /api path whose `/patterns/` is not the mount", () => {
    // Matching "/api" plus the marker ANYWHERE resolved
    // `/api/anything/at/all/patterns/x.tsx` to the repo key `x.tsx`, so an
    // unrelated served path would name a real source file and be replayed as
    // though it were that pattern. A wrong answer, not a refused one — which
    // is the one thing this gate must never produce.
    for (
      const main of [
        "/api/v2/patterns/system/home.tsx",
        "/api/pieces/x/patterns/system/home.tsx",
        "/apifoo/patterns/system/home.tsx",
        "/patterns/system/home.tsx",
      ]
    ) {
      expect(patternKeyFromMain(main, "/packages/patterns/"), main)
        .toBeUndefined();
    }
  });

  it("declines anything that is neither", () => {
    expect(patternKeyFromMain(undefined, "/packages/patterns/"))
      .toBeUndefined();
    expect(patternKeyFromMain("cfc.ts", "/packages/patterns/")).toBeUndefined();
    // A path merely CONTAINING the marker is not a served route: the mount is
    // what makes it one, so the prefix has to be there.
    expect(
      patternKeyFromMain("/elsewhere/patterns/x.tsx", "/packages/patterns/"),
    ).toBeUndefined();
  });
});

describe("retention over the auto tier", () => {
  const ref = (testKey: string, tier: string, stamp: string) => ({
    testKey,
    tier,
    stamp,
    identity: ID_A,
    path: `${vintageDir(testKey, tier)}/${vintageFileName(stamp, ID_A)}`,
  });
  // Deliberately NOT in order, and deliberately not in the order a path sort
  // would produce either. Retention that happened to work on sorted input is
  // the bug that ships, because `collectVintages` returns path order and the
  // stamps only agree with it while the identities are identical.
  const stamps = [
    "2026-01-04T00-00-00.000Z",
    "2026-01-01T00-00-00.000Z",
    "2026-01-05T00-00-00.000Z",
    "2026-01-03T00-00-00.000Z",
    "2026-01-02T00-00-00.000Z",
  ];

  it("keeps the NEWEST generations and drops the oldest", () => {
    const vintages = stamps.map((stamp) =>
      ref("topics/t.test.tsx", AUTO, stamp)
    );

    const doomed = autoGenerationsToPrune(vintages, 3);

    // The two oldest, by STAMP — not the two that happened to be listed last.
    expect(doomed).toEqual([
      ref("topics/t.test.tsx", AUTO, "2026-01-01T00-00-00.000Z").path,
      ref("topics/t.test.tsx", AUTO, "2026-01-02T00-00-00.000Z").path,
    ]);
  });

  it("CANNOT name a pinned vintage, whatever the tree looks like", () => {
    // The one property that must never regress. A pinned vintage cannot be
    // recaptured — the pattern that wrote it no longer exists in runnable form
    // — so this is the difference between a pruner and a data-loss bug.
    const vintages = [
      ...stamps.map((s) => ref("topics/t.test.tsx", PINNED, s)),
      ...stamps.map((s) => ref("topics/t.test.tsx", AUTO, s)),
    ];

    const doomed = autoGenerationsToPrune(vintages, 1);

    expect(doomed.length).toBe(stamps.length - 1);
    for (const path of doomed) {
      expect(path, "retention named a fixture outside the auto tier")
        .toContain(`/${AUTO}/`);
      expect(path).not.toContain(`/${PINNED}/`);
    }
    // Stated as a count too, because the two ways this can break are caught by
    // different assertions and neither covers the other. MEASURED:
    //
    //   - filtering AFTER the slice names five AUTO fixtures and no pinned
    //     ones — wrong count, right tier, caught only by the length above;
    //   - dropping the filter entirely names four PINNED ones — right count,
    //     wrong tier, caught only by the path check.
    expect(doomed.filter((p) => p.includes(`/${PINNED}/`))).toEqual([]);
  });

  it("counts generations PER test key, not across the tree", () => {
    // Two keys with three generations each, keeping two, must drop one from
    // each — not the three oldest overall, which would empty the older key.
    const vintages = [
      ...stamps.slice(0, 3).map((s) => ref("a/a.test.tsx", AUTO, s)),
      ...stamps.slice(0, 3).map((s) => ref("b/b.test.tsx", AUTO, s)),
    ];

    const doomed = autoGenerationsToPrune(vintages, 2);

    expect(doomed.filter((p) => p.includes("a/a.test.tsx")).length).toBe(1);
    expect(doomed.filter((p) => p.includes("b/b.test.tsx")).length).toBe(1);
  });

  it("drops nothing when a key is under the limit", () => {
    const vintages = stamps.slice(0, 2).map((s) =>
      ref("topics/t.test.tsx", AUTO, s)
    );
    expect(autoGenerationsToPrune(vintages, AUTO_GENERATIONS_KEPT)).toEqual([]);
  });

  it("REFUSES to delete anything that is not an auto generation", async () => {
    // A second lock on the only irreversible door in this system. It is
    // redundant with the selection above by construction, and it stays: the
    // cost is a string comparison and the failure it guards is unrecoverable.
    const root = await Deno.makeTempDir({ prefix: "vintage-prune-" });
    try {
      const pinned = `${root}/topics/t.test.tsx/${PINNED}`;
      await Deno.mkdir(pinned, { recursive: true });
      const victim = `${pinned}/${vintageFileName(stamps[0], ID_A)}`;
      await Deno.writeTextFile(victim, "pinned bytes");

      await expect(removeVintages([victim], root)).rejects.toThrow(
        /refusing to prune/,
      );
      // The refusal is worth nothing if the file went anyway.
      expect(await Deno.readTextFile(victim)).toBe("pinned bytes");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("takes the companion directory with the fixture it belongs to", async () => {
    // A companion store is part of the fixture, not a fixture of its own, so
    // nothing enumerates it. Leaving one behind strands a directory that
    // nothing will ever read or clean up again.
    const root = await Deno.makeTempDir({ prefix: "vintage-prune-" });
    try {
      const dir = `${root}/topics/t.test.tsx/${AUTO}`;
      await Deno.mkdir(dir, { recursive: true });
      const path = `${dir}/${vintageFileName(stamps[0], ID_A)}`;
      await Deno.writeTextFile(path, "primary");
      const companion = vintageCompanionDir(path);
      await Deno.mkdir(companion, { recursive: true });
      await Deno.writeTextFile(`${companion}/did-abc.sqlite`, "companion");

      await removeVintages([path], root);

      expect(await exists(path)).toBe(false);
      expect(await exists(companion), "the companion store was orphaned")
        .toBe(false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("promoting a generation", () => {
  const ref = (testKey: string, tier: string, stamp: string) => ({
    testKey,
    tier,
    stamp,
    identity: ID_A,
    path: `${vintageDir(testKey, tier)}/${vintageFileName(stamp, ID_A)}`,
  });

  it("picks the NEWEST auto generation of the named key", () => {
    const vintages = [
      ref("a/a.test.tsx", AUTO, "2026-01-01T00-00-00.000Z"),
      ref("a/a.test.tsx", AUTO, "2026-01-09T00-00-00.000Z"),
      ref("a/a.test.tsx", AUTO, "2026-01-05T00-00-00.000Z"),
      // Another key's newer generation, which must not be chosen.
      ref("b/b.test.tsx", AUTO, "2026-02-01T00-00-00.000Z"),
      // And a pinned one, which is not a promotion candidate at all.
      ref("a/a.test.tsx", PINNED, "2026-03-01T00-00-00.000Z"),
    ];

    const newest = newestAutoGeneration(vintages, "a/a.test.tsx");

    expect(newest?.stamp).toBe("2026-01-09T00-00-00.000Z");
    expect(newest?.tier).toBe(AUTO);
  });

  it("has nothing to promote when the key has only pinned vintages", () => {
    const vintages = [ref("a/a.test.tsx", PINNED, "2026-01-01T00-00-00.000Z")];
    expect(newestAutoGeneration(vintages, "a/a.test.tsx")).toBeUndefined();
  });

  it("lands under pinned/ with the capture stamp CARRIED OVER", () => {
    // Restamping would date the promotion rather than the capture, and the
    // capture date is the whole content of the label: it says which
    // generation of the world the fixture holds.
    const source = ref("a/a.test.tsx", AUTO, "2026-01-09T00-00-00.000Z");

    const destination = promotedPath(source);

    expect(destination).toBe(
      `${vintageDir("a/a.test.tsx", PINNED)}/${
        vintageFileName("2026-01-09T00-00-00.000Z", ID_A)
      }`,
    );
    // And it still parses as the same fixture, one tier over — a promoted
    // vintage the enumerator no longer recognizes would silently stop being
    // replayed, which is the failure this whole tier exists to prevent.
    const reparsed = parseVintagePath(destination);
    expect(reparsed?.tier).toBe(PINNED);
    expect(reparsed?.testKey).toBe("a/a.test.tsx");
    expect(reparsed?.stamp).toBe(source.stamp);
    expect(reparsed?.identity).toBe(source.identity);
  });

  it("promotes a generation git does not track yet", async () => {
    // The defect the first real `--pin` run hit, and one only running it could
    // find: `git mv` refuses an untracked file outright, and a generation
    // captured minutes ago is exactly that. Capture-then-promote in one
    // sitting is the most natural first use of these two commands, and it
    // died with a raw stack trace.
    const root = await Deno.makeTempDir({ prefix: "vintage-promote-" });
    try {
      // Deliberately a real repository, because the fallback is chosen from
      // what git SAYS: outside a repo git fails differently ("not a git
      // repository"), so a test run in a bare temp dir would take the fallback
      // for the wrong reason and pass while the real case still crashed.
      const git = (...args: string[]) =>
        new Deno.Command("git", {
          args,
          cwd: root,
          stdout: "null",
          stderr: "null",
        })
          .output();
      await git("init");

      const auto = `${root}/topics/t.test.tsx/${AUTO}`;
      await Deno.mkdir(auto, { recursive: true });
      const stamp = "2026-01-09T00-00-00.000Z";
      const path = `${auto}/${vintageFileName(stamp, ID_A)}`;
      await Deno.writeTextFile(path, "captured minutes ago, never committed");
      const companion = vintageCompanionDir(path);
      await Deno.mkdir(companion, { recursive: true });
      await Deno.writeTextFile(`${companion}/did-abc.sqlite`, "child space");

      const ref = parseVintagePath(path, root)!;
      expect(ref.tier, "the fixture under test is not an auto generation")
        .toBe(AUTO);

      const moved = await promoteVintage(ref);

      expect(await exists(moved), "the promoted fixture is not there").toBe(
        true,
      );
      expect(await exists(path), "the source was left behind").toBe(false);
      expect(await Deno.readTextFile(moved)).toBe(
        "captured minutes ago, never committed",
      );
      // The companion travels with it, or the promoted fixture records roots
      // whose state it no longer has.
      expect(
        await Deno.readTextFile(`${vintageCompanionDir(moved)}/did-abc.sqlite`),
      ).toBe("child space");
      expect(parseVintagePath(moved, root)?.tier).toBe(PINNED);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("REFUSES when only the COMPANION collides, which git does silently", async () => {
    // The half the first guard missed. `git mv` refuses a destination FILE
    // that exists, but moves a directory INTO an existing directory of that
    // name — so a colliding companion is not refused, it is nested one level
    // down while the stale leftover keeps the name the replay reads. Measured
    // on the tracked path, which is the quiet one: untracked fails loudly
    // with ENOTEMPTY.
    const root = await Deno.makeTempDir({ prefix: "vintage-promote-" });
    try {
      const stamp = "2026-01-09T00-00-00.000Z";
      const name = vintageFileName(stamp, ID_A);
      const auto = `${root}/topics/t.test.tsx/${AUTO}`;
      const pinned = `${root}/topics/t.test.tsx/${PINNED}`;
      await Deno.mkdir(auto, { recursive: true });
      await Deno.mkdir(pinned, { recursive: true });
      await Deno.writeTextFile(`${auto}/${name}`, "the auto generation");
      await Deno.mkdir(vintageCompanionDir(`${auto}/${name}`), {
        recursive: true,
      });
      await Deno.writeTextFile(
        `${vintageCompanionDir(`${auto}/${name}`)}/child.sqlite`,
        "the promoted child space",
      );
      // The pinned PRIMARY is absent, so the first guard does not fire — only
      // a leftover companion is in the way.
      const stale = vintageCompanionDir(`${pinned}/${name}`);
      await Deno.mkdir(stale, { recursive: true });
      await Deno.writeTextFile(`${stale}/child.sqlite`, "STALE LEFTOVER");

      await expect(
        promoteVintage(parseVintagePath(`${auto}/${name}`, root)!),
      ).rejects.toThrow(/never overwrites a vintage/);

      // Nothing nested, nothing moved, nothing overwritten.
      expect(await exists(`${stale}/${vintageCompanionDir(name)}`)).toBe(false);
      expect(await Deno.readTextFile(`${stale}/child.sqlite`)).toBe(
        "STALE LEFTOVER",
      );
      expect(await exists(`${auto}/${name}`)).toBe(true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("RESUMES an interrupted promotion instead of refusing it", async () => {
    // The state the companion-first order exists to produce: the companion is
    // already in `pinned/` and the primary is still in `auto/`. Re-running
    // `--pin` must FINISH the job — that recoverability is the whole stated
    // reason for the ordering, and it rests on one conjunct in the collision
    // check (`exists(companion)`), which reads as belt-and-braces. Measured:
    // dropping it refuses the resume and both test files stay green.
    const root = await Deno.makeTempDir({ prefix: "vintage-promote-" });
    try {
      const stamp = "2026-01-09T00-00-00.000Z";
      const name = vintageFileName(stamp, ID_A);
      const auto = `${root}/topics/t.test.tsx/${AUTO}`;
      const pinned = `${root}/topics/t.test.tsx/${PINNED}`;
      await Deno.mkdir(auto, { recursive: true });
      await Deno.mkdir(pinned, { recursive: true });
      await Deno.writeTextFile(`${auto}/${name}`, "the primary, not yet moved");
      // The companion ALREADY moved; the source companion is gone.
      const movedCompanion = vintageCompanionDir(`${pinned}/${name}`);
      await Deno.mkdir(movedCompanion, { recursive: true });
      await Deno.writeTextFile(
        `${movedCompanion}/child.sqlite`,
        "already promoted",
      );

      const moved = await promoteVintage(
        parseVintagePath(`${auto}/${name}`, root)!,
      );

      expect(moved).toBe(`${pinned}/${name}`);
      expect(await Deno.readTextFile(moved)).toBe("the primary, not yet moved");
      expect(await exists(`${auto}/${name}`)).toBe(false);
      // The already-moved companion is untouched — neither nested nor
      // overwritten — so the promoted fixture is whole.
      expect(await Deno.readTextFile(`${movedCompanion}/child.sqlite`)).toBe(
        "already promoted",
      );
      expect(await exists(`${movedCompanion}/${vintageCompanionDir(name)}`))
        .toBe(false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("REFUSES to promote onto an existing pinned vintage", async () => {
    // A promotion is the only fixture-writing operation that could destroy a
    // pinned vintage, and a pinned vintage cannot be recaptured. `git mv`
    // refuses a destination that exists, so this looked covered — but the
    // untracked fallback is a plain rename, which overwrites in SILENCE, and
    // untracked is the normal state of a generation captured minutes ago. The
    // one path with no protection was the common one.
    const root = await Deno.makeTempDir({ prefix: "vintage-promote-" });
    try {
      const stamp = "2026-01-09T00-00-00.000Z";
      const name = vintageFileName(stamp, ID_A);
      const auto = `${root}/topics/t.test.tsx/${AUTO}`;
      const pinned = `${root}/topics/t.test.tsx/${PINNED}`;
      await Deno.mkdir(auto, { recursive: true });
      await Deno.mkdir(pinned, { recursive: true });
      await Deno.writeTextFile(`${auto}/${name}`, "the auto generation");
      await Deno.writeTextFile(`${pinned}/${name}`, "IRREPLACEABLE");

      await expect(
        promoteVintage(parseVintagePath(`${auto}/${name}`, root)!),
      ).rejects.toThrow(/never overwrites a vintage/);

      // The refusal is worth nothing if the bytes went anyway. This is the
      // assertion that fails without the guard — the rejection alone would not.
      expect(
        await Deno.readTextFile(`${pinned}/${name}`),
        "the pinned vintage was destroyed",
      ).toBe("IRREPLACEABLE");
      // ...and the source is still there to promote deliberately later.
      expect(await exists(`${auto}/${name}`)).toBe(true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("STAGES the rename when the fixture is tracked", async () => {
    // The other half, and the one that carries the argument for using git at
    // all: a committed fixture renamed behind git's back shows up as a delete
    // plus an add, which is precisely the diff that reads as someone
    // destroying a vintage — in a tree whose append-only discipline is people
    // reading diffs. Without this the fallback could swallow every case and
    // the untracked test above would still pass.
    const root = await Deno.makeTempDir({ prefix: "vintage-promote-" });
    try {
      const git = (...args: string[]) =>
        new Deno.Command("git", {
          args,
          cwd: root,
          stdout: "piped",
          stderr: "null",
        }).output();
      await git("init", "-q");
      await git("config", "user.email", "test@example.com");
      await git("config", "user.name", "Test");

      const auto = `${root}/topics/t.test.tsx/${AUTO}`;
      await Deno.mkdir(auto, { recursive: true });
      const stamp = "2026-01-09T00-00-00.000Z";
      const path = `${auto}/${vintageFileName(stamp, ID_A)}`;
      await Deno.writeTextFile(path, "a committed generation");
      // Staged is enough — `git ls-files` reads the index, so this needs no
      // commit and therefore trips over no signing configuration.
      await git("add", "-A");

      const moved = await promoteVintage(parseVintagePath(path, root)!);

      expect(await exists(moved)).toBe(true);
      expect(await exists(path)).toBe(false);
      // git knows about the move: the destination is in the index and the
      // source is not. A plain rename would leave the source staged and the
      // destination untracked.
      const staged = new TextDecoder()
        .decode((await git("ls-files")).stdout)
        .split("\n")
        .filter((line) => line.length > 0);
      expect(staged, "the promoted path is not in the index").toContain(
        moved.slice(root.length + 1),
      );
      expect(staged, "the source path is still in the index").not.toContain(
        path.slice(root.length + 1),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("handles a nested test key without folding the path", () => {
    // `a/b/c.test.tsx` has slashes in the KEY, so anything that finds the tier
    // by counting from the front loses a directory here.
    const source = ref(
      "deep/nest/c.test.tsx",
      AUTO,
      "2026-01-09T00-00-00.000Z",
    );
    expect(promotedPath(source)).toBe(
      `${VINTAGES_DIR}/deep/nest/c.test.tsx/${PINNED}/${
        vintageFileName("2026-01-09T00-00-00.000Z", ID_A)
      }`,
    );
  });
});

describe("what the capture and promote commands print", () => {
  it("tells --pin it needs exactly one test key", () => {
    expect(reportPinNeedsOneTestKey(0)).toContain("names the TEST");
    expect(reportPinNeedsOneTestKey(0)).toContain("--pin topics");
    expect(reportPinNeedsOneTestKey(3)).toContain("3 were named");
  });

  it("points --pin at capture when the key is already current", () => {
    const vintages = [{
      testKey: "a/a.test.tsx",
      tier: PINNED,
      stamp: "2026-01-01T00-00-00.000Z",
      identity: ID_A,
      path: `${vintageDir("a/a.test.tsx", PINNED)}/x.sqlite`,
    }];

    const message = reportNothingToPin("a/a.test.tsx", vintages);

    // The dead end this avoids: "nothing to promote" with no statement of what
    // WOULD produce something to promote.
    expect(message).toContain("already has a pinned vintage");
    expect(message).toContain("--capture-changed");
  });

  it("lists the keys that DO have a generation when the named one does not", () => {
    const vintages = [{
      testKey: "b/b.test.tsx",
      tier: AUTO,
      stamp: "2026-01-01T00-00-00.000Z",
      identity: ID_A,
      path: `${vintageDir("b/b.test.tsx", AUTO)}/x.sqlite`,
    }];

    const message = reportNothingToPin("a/a.test.tsx", vintages);

    expect(message).toContain("b/b.test.tsx");
    expect(message).not.toContain("already has a pinned vintage");
  });

  it("pairs each pin outcome with the right stream and exit code", () => {
    // Exit code is the part a human never reads and CI only reads. A promotion
    // that printed its success to stderr, or a refusal that exited 0, would
    // look completely normal in a terminal.
    const root = "/repo";
    expect(describePinOutcome({ kind: "needs-one-key", given: 0 }, root).code)
      .toBe(1);
    expect(
      describePinOutcome({
        kind: "nothing-to-pin",
        testKey: "a/a.test.tsx",
        vintages: [],
      }, root).code,
    ).toBe(1);

    const failed = describePinOutcome({
      kind: "failed",
      from: "/repo/vintages/a/auto/x.sqlite",
      detail: "disk full",
    }, root);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("disk full");
    // Repo-relative, because an absolute temp path is unreadable in a log.
    expect(failed.err).toContain("vintages/a/auto/x.sqlite");
    expect(failed.err).not.toContain("/repo/vintages");
    expect(failed.out, "a failure wrote to stdout").toBeUndefined();

    const promoted = describePinOutcome({
      kind: "promoted",
      from: "/repo/vintages/a/auto/x.sqlite",
      to: "/repo/vintages/a/pinned/x.sqlite",
    }, root);
    expect(promoted.code).toBe(0);
    expect(promoted.out).toContain("auto/x.sqlite");
    expect(promoted.out).toContain("pinned/x.sqlite");
    expect(promoted.err, "a success wrote to stderr").toBeUndefined();
  });

  it("still LISTS what a partly-failed capture wrote, and exits 1", () => {
    // The shape that would otherwise lie: some generations captured, one
    // failed. Suppressing the list because the command failed would leave
    // files on disk it had just implied it did not create.
    const partial = describeCaptureOutcome({
      kind: "captured",
      captured: ["/repo/vintages/a/auto/new.sqlite"],
      pruned: ["/repo/vintages/a/auto/old.sqlite"],
      problems: ["  b/b.test.tsx: tests did not pass"],
    }, "/repo");

    expect(partial.code).toBe(1);
    expect(partial.out, "the written file went unreported").toContain(
      "+ vintages/a/auto/new.sqlite",
    );
    expect(partial.out, "the pruned file went unreported").toContain(
      "- vintages/a/auto/old.sqlite",
    );
    expect(partial.err).toContain("b/b.test.tsx");

    // The clean case exits 0 and says nothing on stderr.
    const clean = describeCaptureOutcome({
      kind: "captured",
      captured: ["/repo/vintages/a/auto/new.sqlite"],
      pruned: [],
      problems: [],
    }, "/repo");
    expect(clean.code).toBe(0);
    expect(clean.err).toBeUndefined();

    // And a refusal is stderr + exit 1, never a quiet success.
    const refused = describeCaptureOutcome({
      kind: "refused-red",
      failures: [{ testKey: "a/a.test.tsx", path: "p", detail: "d" }],
    }, "/repo");
    expect(refused.code).toBe(1);
    expect(refused.out).toBeUndefined();

    // "Nothing to do" is a SUCCESS. Exiting 1 here would make the common,
    // correct case indistinguishable from a broken one.
    const current = describeCaptureOutcome(
      { kind: "all-current", replayed: 4 },
      "/repo",
    );
    expect(current.code).toBe(0);
    expect(current.err).toBeUndefined();
  });

  it("says WHY it will not capture onto a red tree", () => {
    const message = reportCaptureRefusedOnRed(2);
    expect(message).toContain("2 fixture(s) failed");
    // The reasoning, not just the refusal: a generation is a record of a world
    // that worked, and everyone else will replay it as evidence.
    expect(message).toContain("record of a world that WORKED");
  });

  it("distinguishes 'nothing to do' from 'nothing happened'", () => {
    // A command that captures nothing and says nothing reads as broken. This
    // is the message that makes a no-op legible as the common, correct case.
    const message = reportEveryGenerationCurrent(4);
    expect(message).toContain("all 4 fixture(s) are current");
    expect(message).toContain("same world");
  });

  it("REFUSES a flag it does not recognize, rather than ignoring it", () => {
    // A misspelled flag matches no branch and falls through to the plain gate:
    // it replays everything, prints a healthy summary and exits 0, so someone
    // who asked to capture a generation is told the tree is fine. Measured on
    // the real command with `--capture-chnged` and `--pinn`.
    expect(unknownFlags(["--capture-chnged"])).toEqual(["--capture-chnged"]);
    expect(unknownFlags(["--pinn", "a/a.test.tsx"])).toEqual(["--pinn"]);
    // A DROPPED dash counts too. Measured: `-capture-changed` and `-x` both
    // fell through to the plain gate and exited 0 with a healthy summary —
    // the very defect this function was added to prevent, inside the fix.
    expect(unknownFlags(["-capture-changed"])).toEqual(["-capture-changed"]);
    expect(unknownFlags(["-x"])).toEqual(["-x"]);
    // `--` is the end-of-flags separator and `deno task` forwards it
    // verbatim, so rejecting it refused an ordinary invocation.
    expect(unknownFlags(["--", "--update", "a/a.test.tsx"])).toEqual([]);
    // Positionals are not flags — a test key is an argument, not a typo.
    expect(unknownFlags(["--pin", "a/a.test.tsx"])).toEqual([]);
    // `--only=<value>` is the same flag as `--only`, written with its value
    // attached.
    expect(unknownFlags(["--only=system/home.test.tsx"])).toEqual([]);
    for (const flag of KNOWN_FLAGS) expect(unknownFlags([flag])).toEqual([]);

    const message = reportUnknownFlags(["--capture-chnged"]);
    expect(message).toContain("--capture-chnged");
    // It must name what IS valid, or the reader is left guessing at a typo.
    expect(message).toContain("--capture-changed");
    expect(message).toContain("exit 0");
  });

  it("reads a replay scope from the command line", () => {
    expect(replayScope([])).toEqual({ only: [], whole: true });
    expect(replayScope(["--only", "a/a.test.tsx"])).toEqual({
      only: ["a/a.test.tsx"],
      whole: false,
    });
    expect(replayScope(["--only"])).toHaveProperty("error");
  });

  it("refuses a filter beside a capture command", () => {
    for (const flag of ["--update", "--capture-changed", "--pin"]) {
      expect(replayScope(["--only", "a", flag])).toEqual({
        error: reportOnlyWithCapture(),
      });
    }
    // A capture on its own reads every fixture, which is what it needs.
    expect(replayScope(["--pin"])).toEqual({ only: [], whole: true });
  });

  it("reports an empty replay by what was asked for", () => {
    expect(reportEmptyReplay([])).toBe(reportNothingReplayed());
    expect(reportEmptyReplay(["a"])).toBe(reportNothingMatched(["a"]));
  });

  describe("judgeWholeTree()", () => {
    const drop = (pattern: string, paths: string[]): AcceptedStateDrop => ({
      pattern,
      paths,
      capturedThrough: "2026-01-01T00-00-00.000Z",
      reason: "test",
      record: "docs/history/example.md",
    });
    const drops = [drop("a.tsx", ["x", "y"]), drop("b.tsx", ["z"])];
    const replay = {
      covered: new Set(["a.tsx"]),
      coveredBy: new Map<string, unknown>(),
      dropsApplied: new Set([acceptedDropKey("a.tsx", "x")]),
    };

    it("finds uncovered patterns and stale or unjudgeable removals", () => {
      expect(judgeWholeTree(true, ["a.tsx", "c.tsx"], replay, drops))
        .toEqual({
          uncovered: ["c.tsx"],
          staleDrops: [acceptedDropKey("a.tsx", "y")],
          unjudgeableDrops: ["b.tsx"],
        });
    });

    it("makes none of the three checks for a filtered run", () => {
      expect(judgeWholeTree(false, ["a.tsx", "c.tsx"], replay, drops))
        .toEqual({ uncovered: [], staleDrops: [], unjudgeableDrops: [] });
    });
  });

  it("names the filter when it matched no fixture", () => {
    const message = reportNothingMatched(["a/a.test.tsx", "b"]);
    expect(message).toContain("`a/a.test.tsx` or `b`");
    expect(message).toContain("failure");
  });

  it("takes a fixture whose path holds a filter value, and only then", () => {
    const root = "/work/labs";
    const relative = "packages/piece/test/vintages/system/home.test.tsx/" +
      "pinned/2026-07-30T21-32-46.548Z-abc.sqlite";
    const fixture = `${root}/${relative}`;
    const takes = (only: string[]) => replayFilterTakes(fixture, root, only);
    expect(takes([])).toBe(true);
    expect(takes([relative])).toBe(true);
    expect(takes(["system/home.test.tsx"])).toBe(true);
    expect(takes(["topics/topics.test.tsx"])).toBe(false);
    expect(takes(["topics", "system"])).toBe(true);
  });

  it("matches a filter against the path inside the repository only", () => {
    // A term that names part of the checkout's directory matches no
    // fixture.
    const fixture =
      "/work/labs/packages/piece/test/vintages/a.test.tsx/x.sqlite";
    expect(replayFilterTakes(fixture, "/work/labs", ["labs"])).toBe(false);
  });

  it("matches a filter written with either separator", () => {
    const root = "C:\\work\\labs";
    const fixture = `${root}\\packages\\piece\\test\\vintages\\a.test.tsx`;
    expect(replayFilterTakes(fixture, root, ["piece/test/vintages"])).toBe(
      true,
    );
    expect(
      replayFilterTakes(fixture, root, ["piece\\test\\vintages"]),
    ).toBe(true);
  });

  it("says why a filter cannot be given beside a capture", () => {
    // A capture command decides what is due by reading every fixture, and its
    // positional argument is a test key rather than a fixture. A filter next to
    // one therefore has no meaning, and the task refuses the pair.
    const message = reportOnlyWithCapture();
    expect(message).toContain("--only");
    expect(message).toContain("whole tree");
  });

  it("EXITS 1 on an empty tree, not just prints differently", () => {
    // The message says an empty tree is the moment someone is most likely to
    // believe the regime runs when it does not. An exit code is the half of
    // that message a script can read, so pairing the warning with the healthy
    // code makes "nothing here" indistinguishable from "all current" to
    // everything except a human reading the terminal.
    const empty = describeCaptureOutcome(
      { kind: "all-current", replayed: 0 },
      "/repo",
    );
    expect(empty.code, "an empty tree reported success").toBe(1);
    // On STDERR, like every other nonzero exit in both commands. Splitting
    // this case in two is how that went wrong: leaving the failing half on
    // stdout made `cmd 2>err.log >/dev/null || cat err.log` print nothing.
    expect(empty.err, "a failure explained itself on stdout").toBeDefined();
    expect(empty.out).toBeUndefined();

    // ...and a genuinely current tree still exits 0, on stdout.
    const current = describeCaptureOutcome(
      { kind: "all-current", replayed: 4 },
      "/repo",
    );
    expect(current.code).toBe(0);
    expect(current.out).toBeDefined();
    expect(current.err).toBeUndefined();
  });

  it("prints no empty stdout line when every capture failed", () => {
    // `out: ""` still PRINTS, so the errors would arrive under a leading blank
    // line that reads as truncated output.
    const allFailed = describeCaptureOutcome({
      kind: "captured",
      captured: [],
      pruned: [],
      problems: ["  a/a.test.tsx: tests did not pass"],
    }, "/repo");

    expect(allFailed.out).toBeUndefined();
    expect(allFailed.code).toBe(1);
    expect(allFailed.err).toContain("a/a.test.tsx");
  });

  it("does not claim an EMPTY tree is current", () => {
    // "all 0 fixture(s) are current" is vacuously true and actively
    // misleading: it asserts currency about a tree that proved nothing, at the
    // moment someone is most likely to believe the regime is running when it
    // is not. `--capture-changed` cannot fix an empty tree — it only ever adds
    // a generation beside an existing fixture — so it must name what does.
    const message = reportEveryGenerationCurrent(0);

    expect(message).not.toContain("are current");
    expect(message).toContain("no fixtures");
    expect(message).toContain("--update <test path>");
  });
});

describe("derived-hoist classification", () => {
  it("recognizes a transformer-emitted pattern hoist", () => {
    expect(isDerivedHoistSymbol("__cfPattern_4")).toBe(true);
    expect(isDerivedHoistSymbol("__cfPattern_12")).toBe(true);
  });

  it("returns false for authored exports and other synthetics", () => {
    expect(isDerivedHoistSymbol("default")).toBe(false);
    expect(isDerivedHoistSymbol("setup")).toBe(false);
    expect(isDerivedHoistSymbol("__cfLift_2")).toBe(false);
    expect(isDerivedHoistSymbol("__cfPattern_")).toBe(false);
    expect(isDerivedHoistSymbol("x__cfPattern_4")).toBe(false);
  });

  it("returns false for numbers the per-file counter never mints", () => {
    expect(isDerivedHoistSymbol("__cfPattern_0")).toBe(false);
    expect(isDerivedHoistSymbol("__cfPattern_01")).toBe(false);
  });

  it("classifies a stored-argument refusal in Error and string form", () => {
    const message = `${STORED_ARGUMENT_SCHEMA_REFUSAL}: params: missing ` +
      `required property boundRemoveHistoryEntry`;
    expect(isStoredArgumentRefusal(new Error(message))).toBe(true);
    expect(isStoredArgumentRefusal(message)).toBe(true);
  });

  it("returns false for every other error", () => {
    expect(isStoredArgumentRefusal(new Error("commit failed"))).toBe(false);
    expect(isStoredArgumentRefusal("compile error")).toBe(false);
    expect(isStoredArgumentRefusal(undefined)).toBe(false);
  });
});

describe("hoist supersession rule", () => {
  const REFUSED = `${STORED_ARGUMENT_SCHEMA_REFUSAL}: params: missing ` +
    `required property boundRemoveHistoryEntry`;

  it("names the stored-argument rule for a refused hoist", () => {
    expect(hoistSupersessionReason("__cfPattern_4", REFUSED, false))
      .toBe("stored arguments superseded");
  });

  it("names the no-longer-emitted rule for a missing hoist", () => {
    expect(hoistSupersessionReason("__cfPattern_6", "gone", true))
      .toBe("hoist no longer emitted");
  });

  it("prefers the stored-argument rule when both could apply", () => {
    // The refusal the candidate actually made is the more specific account
    // of what happened, and the one whose remedy the reader needs.
    expect(hoistSupersessionReason("__cfPattern_4", REFUSED, true))
      .toBe("stored arguments superseded");
  });

  it("returns undefined for an authored artifact under either shape", () => {
    // The partition: the same two refusals that supersede a hoist are loss
    // when they land on something an author wrote, and must fail the run.
    expect(hoistSupersessionReason("Row", REFUSED, false)).toBeUndefined();
    expect(hoistSupersessionReason("Row", "gone", true)).toBeUndefined();
    expect(hoistSupersessionReason("default", REFUSED, true)).toBeUndefined();
    expect(hoistSupersessionReason("__cfPattern_0", REFUSED, true))
      .toBeUndefined();
  });

  it("returns undefined for any other refusal of a hoist", () => {
    expect(hoistSupersessionReason("__cfPattern_4", "commit failed", false))
      .toBeUndefined();
    expect(hoistSupersessionReason("__cfPattern_4", undefined, false))
      .toBeUndefined();
  });
});
