import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type CoverageFigures,
  type TestIdentity,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";

import {
  aliasLineFor,
  buildReport,
  coverageRise,
  firstFailures,
  flakyNewTests,
  MAIN_REPORT_MARKER,
  measuredSetRises,
  nameSimilarity,
  outcomesOf,
  partsOf,
  type PullRequestView,
  renames,
  renderReport,
  renderWithdrawal,
  type ReportInput,
  reportIsEmpty,
  type RunOutcomes,
  selectionOf,
  shownIdentity,
  unknownPullRequest,
  type Verdict,
} from "./report.ts";
import {
  COVERAGE_COMMENT_LINES,
  EXCLUDED_FROM_COVERAGE_GATE,
  LOCAL_COVERAGE_MAX_SETS,
  RENAME_SIMILARITY,
} from "./policy.ts";

//
// Fixtures
//
// Every case is written in test names, coverage figures and verdicts,
// because those are the three vocabularies the module reads.
//

/** A unit test in a package, which is where almost every identity lives. */
function test(name: string, scope = "bakery"): TestIdentity {
  return { k: "unit", s: scope, n: name };
}

function key(name: string, scope = "bakery"): string {
  return testIdentityKey(test(name, scope));
}

/** One batch a lane measured about itself, which is not a test. */
const laneBatch: TestIdentity = {
  k: "gate",
  s: "ci",
  n: "ci-lane batch bakery-unit",
};

/** One run's verdicts, written as a name-to-verdict list. */
function run(
  entries: readonly (readonly [string, Verdict])[],
): RunOutcomes {
  return new Map(entries.map(([name, verdict]) => [key(name), verdict]));
}

/** A source-group figure set: a package measured by every test in the run. */
function figures(
  entries: readonly (readonly [string, number])[],
): CoverageFigures {
  return { groups: new Map(entries), sets: new Map(), cold: false };
}

/** An own-tests figure set: a package measured by only its own tests. */
function ownTests(
  entries: readonly (readonly [string, number])[],
  suite = "workspace-unit",
): CoverageFigures {
  return {
    groups: new Map(),
    sets: new Map(
      entries.map(([member, lines]) => [`${suite}/${member}`, lines] as const),
    ),
    cold: false,
  };
}

/** Two figure sets as one, which is what a run's measurement really is. */
function both(...sets: readonly CoverageFigures[]): CoverageFigures {
  return {
    groups: new Map(sets.flatMap((set) => [...set.groups])),
    sets: new Map(sets.flatMap((set) => [...set.sets])),
    cold: sets.some((set) => set.cold),
  };
}

/** A pull request whose run ran these names, over a manifest that knows them. */
function ranThere(
  entries: readonly (readonly [string, Verdict])[],
  extra: Partial<PullRequestView> = {},
): PullRequestView {
  return {
    ...unknownPullRequest(),
    manifest: true,
    ran: run(entries),
    flakes: new Map(entries.map(([name]) => [key(name), undefined])),
    ...extra,
  };
}

/** Every named test in the one unit a case's fixtures live in. */
function inOneUnit(...names: readonly string[]): Map<string, string> {
  return new Map(names.map((name) => [key(name), "workspace-unit\tbakery"]));
}

/** A pull request whose run ran nothing, over a manifest that knows these. */
function knows(
  names: readonly string[],
  extra: Partial<PullRequestView> = {},
): PullRequestView {
  return {
    ...unknownPullRequest(),
    manifest: true,
    ran: new Map(),
    flakes: new Map(names.map((name) => [key(name), undefined])),
    ...extra,
  };
}

/** An input with nothing in it; each case fills in the part it needs. */
function input(partial: Partial<ReportInput> = {}): ReportInput {
  return {
    current: new Map(),
    previous: new Map(),
    pullRequest: unknownPullRequest(),
    coverage: figures([]),
    coverageBefore: figures([]),
    touched: new Set(),
    coverageGate: { reached: [], ran: true },
    day: "2026-09-07",
    ...partial,
  };
}

describe("report", () => {
  describe("outcomesOf()", () => {
    const record = (
      name: string,
      outcome: TestRecord["outcome"],
    ): TestRecord => ({
      line: "record",
      test: test(name),
      outcome,
      durationMs: 1,
    });

    it("folds every record of one identity into one verdict", () => {
      const outcomes = outcomesOf([
        record("kneads", "pass"),
        record("kneads", "pass"),
        record("proves", "fail"),
      ]);
      expect(outcomes.get(key("kneads"))).toBe("pass");
      expect(outcomes.get(key("proves"))).toBe("fail");
    });

    it("reports a pass and a failure at one commit as disagreement", () => {
      const outcomes = outcomesOf([
        record("kneads", "pass"),
        record("kneads", "fail"),
      ]);
      expect(outcomes.get(key("kneads"))).toBe("mixed");
    });

    it("reports a skipped test as skipped rather than as a pass", () => {
      expect(outcomesOf([record("kneads", "skip")]).get(key("kneads")))
        .toBe("skip");
    });

    // A lane writes what its setup and each of its batches cost through
    // the record machinery every test uses, and a batch that ended badly
    // is written as a failure. Nothing enumerates those measurements and
    // no lane can be asked to run one, so none of them is a test.
    it("gives no verdict on a lane measuring itself", () => {
      const outcomes = outcomesOf([
        record("kneads", "fail"),
        {
          line: "record",
          test: laneBatch,
          outcome: "fail",
          durationMs: 391_400,
        },
      ]);
      expect(outcomes.get(key("kneads"))).toBe("fail");
      expect(outcomes.has(testIdentityKey(laneBatch))).toBe(false);
    });
  });

  describe("selectionOf()", () => {
    it("says nothing was measured when the pull request's run is unread", () => {
      expect(selectionOf(unknownPullRequest(), key("kneads")))
        .toBe("unknown");
    });

    it("reports what the pull request's own run did with it", () => {
      const view = ranThere([["kneads", "pass"], ["proves", "fail"]]);
      expect(selectionOf(view, key("kneads"))).toBe("passed-there");
      expect(selectionOf(view, key("proves"))).toBe("failed-there");
    });

    it("separates each reason a run did not reach a test", () => {
      const view = knows(["bakes"], {
        withheld: new Map([[key("kneads"), "flaky" as const]]),
        flakes: new Map([
          [key("kneads"), undefined],
          [key("bakes"), undefined],
        ]),
      });
      expect(selectionOf(view, key("kneads"))).toBe("withheld-flaky");
      expect(selectionOf(view, key("bakes"))).toBe("not-selected");
    });

    // Saying the selector passed over a test needs a manifest that holds
    // it. Without one all that is known is that the run did not run it,
    // and claiming otherwise would credit the selector with a decision
    // nothing made.
    it("does not claim the selector passed over a test it never saw", () => {
      const view: PullRequestView = { ...unknownPullRequest(), ran: new Map() };
      expect(selectionOf(view, key("kneads"))).toBe("did-not-run");
    });

    // Under selection a lane runs a unit with a skip list, so a skip is
    // the selector's own decision and the manifest says so. A skip no
    // manifest explains is the test skipping itself.
    it("separates a skip the selector chose from one the test chose", () => {
      const chosen = ranThere([["kneads", "skip"]], {
        flakes: new Map([[key("kneads"), undefined]]),
      });
      expect(selectionOf(chosen, key("kneads"))).toBe("not-selected");
      const itself: PullRequestView = {
        ...unknownPullRequest(),
        manifest: true,
        ran: run([["kneads", "skip"]]),
        selected: new Set([key("kneads")]),
        flakes: new Map([[key("kneads"), undefined]]),
      };
      expect(selectionOf(itself, key("kneads"))).toBe("skipped-there");
    });

    // An identity the packing reached, and one the store has never seen,
    // are both identities that run. A run with no record of either
    // recorded less than it ran rather than running less than it should
    // have, and saying there is no manifest would deny one there is.
    it("separates a test that was to have run from one nothing knows", () => {
      const selected = knows(["kneads"], {
        selected: new Set([key("kneads")]),
      });
      expect(selectionOf(selected, key("kneads"))).toBe("unrecorded");
      expect(selectionOf(knows([]), key("kneads"))).toBe("unrecorded");
    });
  });

  describe("firstFailures()", () => {
    // Its inputs are keys this module's own vocabulary produced, so one
    // that is not an identity is a caller in breach rather than data to
    // work around.
    it("refuses a key that is not a test identity", () => {
      expect(() =>
        firstFailures(input({
          previous: new Map([["not a key", "pass"]]),
          current: new Map([["not a key", "fail"]]),
        }))
      ).toThrow("not a test identity key");
    });

    it("names failures in a settled order", () => {
      const failures = firstFailures(input({
        previous: run([["proves", "pass"], ["bakes", "pass"]]),
        current: run([["proves", "fail"], ["bakes", "fail"]]),
      }));
      expect(failures.map((failure) => failure.test.n)).toEqual([
        "bakes",
        "proves",
      ]);
    });

    it("names a test that passed before and failed at this commit", () => {
      const failures = firstFailures(input({
        previous: run([["kneads", "pass"]]),
        current: run([["kneads", "fail"]]),
      }));
      expect(failures.map((failure) => failure.test.n)).toEqual(["kneads"]);
    });

    // A batch is written as a failure when a test in it failed. What
    // this commit is said to have broken is that test, once.
    it("names the test a batch failed on rather than the batch", () => {
      const failures = firstFailures(input({
        previous: new Map<string, Verdict>([
          ...run([["kneads", "pass"]]),
          [testIdentityKey(laneBatch), "pass"],
        ]),
        current: outcomesOf([
          {
            line: "record",
            test: test("kneads"),
            outcome: "fail",
            durationMs: 12,
          },
          {
            line: "record",
            test: laneBatch,
            outcome: "fail",
            durationMs: 391_400,
          },
        ]),
      }));
      expect(failures.map((failure) => failure.test.n)).toEqual(["kneads"]);
    });

    // A break never gets attributed to whoever merged next after somebody
    // else broke something.
    it("says nothing about a test that was already failing", () => {
      expect(firstFailures(input({
        previous: run([["kneads", "fail"]]),
        current: run([["kneads", "fail"]]),
      }))).toEqual([]);
    });

    it("says nothing about a test the previous run did not judge", () => {
      expect(firstFailures(input({
        previous: run([["proves", "pass"]]),
        current: run([["kneads", "fail"]]),
      }))).toEqual([]);
    });

    it("says nothing about a test the previous run skipped", () => {
      expect(firstFailures(input({
        previous: run([["kneads", "skip"]]),
        current: run([["kneads", "fail"]]),
      }))).toEqual([]);
    });

    // A test that both passed and failed at this commit is disagreeing
    // with itself, which is what the scorer calls flake evidence rather
    // than a catch.
    it("says nothing about a test that disagreed with itself here", () => {
      expect(firstFailures(input({
        previous: run([["kneads", "pass"]]),
        current: run([["kneads", "mixed"]]),
      }))).toEqual([]);
    });

    // The comment carries what a later run found that the pull request's
    // own run could not have found for itself, and a failure that run
    // reported is not that.
    it("says nothing about a test the pull request's own run failed", () => {
      expect(firstFailures(input({
        previous: run([["kneads", "pass"]]),
        current: run([["kneads", "fail"]]),
        pullRequest: ranThere([["kneads", "fail"]]),
      }))).toEqual([]);
    });

    it("carries what the pull request did and the rate the store has", () => {
      const failures = firstFailures(input({
        previous: run([["kneads", "pass"]]),
        current: run([["kneads", "fail"]]),
        pullRequest: ranThere([["kneads", "pass"]], {
          flakes: new Map([[key("kneads"), { flakes: 4, runs: 100 }]]),
        }),
      }));
      expect(failures[0]?.selection).toBe("passed-there");
      expect(failures[0]?.flakes).toEqual({ flakes: 4, runs: 100 });
    });
  });

  describe("coverageRise()", () => {
    const touched = new Set(["tasks"]);

    it("reports a rise the change had to add before it is mentioned", () => {
      expect(coverageRise(input({
        touched,
        coverageBefore: figures([["workspace", 1000]]),
        coverage: figures([["workspace", 1000 + COVERAGE_COMMENT_LINES]]),
      }))).toEqual({
        from: 1000,
        to: 1000 + COVERAGE_COMMENT_LINES,
        groups: [],
      });
    });

    // As near as this gets to saying where a test would go: the groups
    // the change touched that rose with the whole.
    it("names the touched source groups that rose as well", () => {
      const rise = coverageRise(input({
        touched: new Set(["tasks", "packages/memory", "packages/runner"]),
        coverageBefore: figures([
          ["workspace", 1000],
          ["tasks", 40],
          ["packages/memory", 10],
          ["packages/runner", 90],
        ]),
        coverage: figures([
          ["workspace", 1000 + COVERAGE_COMMENT_LINES],
          ["tasks", 40],
          ["packages/memory", 24],
          ["packages/runner", 101],
        ]),
      }));
      expect(rise?.groups).toEqual([
        { group: "packages/memory", from: 10, to: 24 },
        { group: "packages/runner", from: 90, to: 101 },
      ]);
    });

    it("says nothing about one line", () => {
      expect(coverageRise(input({
        touched,
        coverageBefore: figures([["workspace", 1000]]),
        coverage: figures([["workspace", 1001]]),
      }))).toBeUndefined();
    });

    it("says nothing about a fall", () => {
      expect(coverageRise(input({
        touched,
        coverageBefore: figures([["workspace", 1000]]),
        coverage: figures([["workspace", 900]]),
      }))).toBeUndefined();
    });

    it("says nothing when one of the two runs measured nothing", () => {
      expect(coverageRise(input({
        touched,
        coverage: figures([["workspace", 9000]]),
      }))).toBeUndefined();
    });

    // The repository-wide figure moves a little between runs on its own,
    // so a change that touched no source at all would otherwise be told
    // about a rise it could not have caused.
    it("says nothing to a change that touched no source", () => {
      expect(coverageRise(input({
        coverageBefore: figures([["workspace", 1000]]),
        coverage: figures([["workspace", 2000]]),
      }))).toBeUndefined();
    });

    // A cold compile cache reaches compile branches a warm one does not,
    // so a warm run after a cold one reads higher with no test changed.
    it("says nothing when only one of the two runs found the compile cache cold", () => {
      const rise = {
        touched,
        coverageBefore: { ...figures([["workspace", 1000]]), cold: true },
        coverage: figures([["workspace", 1000 + COVERAGE_COMMENT_LINES]]),
      };
      expect(coverageRise(input(rise))).toBeUndefined();
      expect(
        coverageRise(input({
          ...rise,
          coverage: { ...rise.coverage, cold: true },
        }))?.to,
      ).toBe(1000 + COVERAGE_COMMENT_LINES);
    });
  });

  describe("measuredSetRises()", () => {
    const gated = "packages/memory";
    const excluded = [...EXCLUDED_FROM_COVERAGE_GATE.keys()][0]!;
    /** The gate having run over exactly these sets. */
    const over = (...members: string[]) => ({
      reached: members.map((member) => `workspace-unit/${member}`),
      ran: true,
    });
    const overTheCap = {
      reached: Array.from(
        { length: LOCAL_COVERAGE_MAX_SETS + 1 },
        (_, index) => `workspace-unit/packages/gated-${index}`,
      ),
      ran: false,
    };

    it("names the cap when the change reached more sets than it allows", () => {
      const rises = measuredSetRises(input({
        coverageBefore: ownTests([[gated, 10]]),
        coverage: ownTests([[gated, 14]]),
        touched: new Set([gated]),
        coverageGate: overTheCap,
      }));
      expect(rises[0]?.route).toBe("over-the-cap");
      expect(rises[0]?.touched).toBe(LOCAL_COVERAGE_MAX_SETS + 1);
    });

    // Two sets over one member count twice against the cap, because the
    // cap is what the gate applies and the gate counts sets. Counting
    // members here would say the gate ran when it did not.
    it("counts a set rather than a member against the cap", () => {
      const rises = measuredSetRises(input({
        coverageBefore: ownTests([[gated, 10]]),
        coverage: ownTests([[gated, 14]]),
        touched: new Set([gated]),
        coverageGate: {
          reached: [
            `workspace-unit/${gated}`,
            `memory-e2e/${gated}`,
            `memory-browser/${gated}`,
          ],
          ran: false,
        },
      }));
      expect(rises[0]?.route).toBe("over-the-cap");
      expect(rises[0]?.touched).toBe(3);
    });

    it("names the exclusion list, with its reason", () => {
      const rises = measuredSetRises(input({
        coverageBefore: ownTests([[excluded, 10]]),
        coverage: ownTests([[excluded, 14]]),
        touched: new Set([excluded]),
        coverageGate: over(),
      }));
      expect(rises[0]?.route).toBe("excluded");
      expect(rises[0]?.reason).toBe(EXCLUDED_FROM_COVERAGE_GATE.get(excluded));
    });

    // A package the gate would never have measured is on the exclusion
    // list whatever else the change touched, so the cap cannot be the
    // route that let its rise through.
    it("names the exclusion list even when the cap was also passed", () => {
      const rises = measuredSetRises(input({
        coverageBefore: ownTests([[excluded, 10]]),
        coverage: ownTests([[excluded, 14]]),
        touched: new Set([excluded]),
        coverageGate: overTheCap,
      }));
      expect(rises[0]?.route).toBe("excluded");
    });

    it("names the change when it did not reach the risen set", () => {
      const rises = measuredSetRises(input({
        coverageBefore: ownTests([[gated, 10]]),
        coverage: ownTests([[gated, 14]]),
        touched: new Set(["tasks"]),
        coverageGate: over(),
      }));
      expect(rises[0]?.route).toBe("elsewhere");
    });

    // The change touched the package, the gate ran over it, and the rise
    // landed anyway. That is the two measurements disagreeing, and saying
    // the change did not touch the package would be false.
    it("says the measurements disagree when the gate did run", () => {
      const rises = measuredSetRises(input({
        coverageBefore: ownTests([[gated, 10]]),
        coverage: ownTests([[gated, 14]]),
        touched: new Set([gated]),
        coverageGate: over(gated),
      }));
      expect(rises[0]?.route).toBe("gated");
    });

    // A package the run before this one did not measure has no figure to
    // compare against, and calling its first figure a rise would report
    // every package the moment it gains a gate.
    it("says nothing about a package the run before did not measure", () => {
      expect(measuredSetRises(input({
        coverage: ownTests([[gated, 14]]),
        touched: new Set(["tasks"]),
      }))).toEqual([]);
    });

    it("says nothing about a package that did not rise", () => {
      expect(measuredSetRises(input({
        coverageBefore: ownTests([[gated, 10]]),
        coverage: both(ownTests([[gated, 10]]), figures([["workspace", 900]])),
      }))).toEqual([]);
    });

    // Both metrics carry the same package name, and only the own-tests
    // one is the quantity the per-package gate compares.
    it("reads the own-tests figure and not the whole run's figure", () => {
      expect(measuredSetRises(input({
        coverageBefore: figures([[gated, 10]]),
        coverage: figures([[gated, 400]]),
      }))).toEqual([]);
    });

    it("counts only the sets the gate reached", () => {
      // An excluded member carries no set, so touching every one of them
      // reaches nothing and the gate ran over an empty selection.
      const rises = measuredSetRises(input({
        coverageBefore: ownTests([[gated, 10]]),
        coverage: ownTests([[gated, 14]]),
        touched: new Set([...EXCLUDED_FROM_COVERAGE_GATE.keys()]),
        coverageGate: over(),
      }));
      expect(rises[0]?.route).toBe("elsewhere");
    });
  });

  describe("flakyNewTests()", () => {
    it("names a test this change added that disagreed with itself", () => {
      const flaky = flakyNewTests(input({
        previous: run([["proves", "pass"]]),
        current: run([["proves", "pass"], ["kneads", "mixed"]]),
        pullRequest: knows(["proves"]),
      }));
      expect(flaky.map((entry) => entry.test.n)).toEqual(["kneads"]);
    });

    it("says nothing about a test that was already there", () => {
      expect(flakyNewTests(input({
        previous: run([["kneads", "pass"]]),
        current: run([["kneads", "mixed"]]),
        pullRequest: knows(["kneads"]),
      }))).toEqual([]);
    });

    // A run that shipped only part of its records makes every test in the
    // missing part look absent. A test the store already knows has run
    // before, whatever that run managed to upload, so it is not new.
    it("says nothing about a test the store already knows", () => {
      expect(flakyNewTests(input({
        previous: new Map(),
        current: run([["kneads", "mixed"]]),
        pullRequest: knows(["kneads"]),
      }))).toEqual([]);
    });

    it("says nothing when no manifest says which tests the store knows", () => {
      expect(flakyNewTests(input({
        current: run([["kneads", "mixed"]]),
      }))).toEqual([]);
    });

    it("says nothing about a new test that simply passed", () => {
      expect(flakyNewTests(input({
        current: run([["kneads", "pass"]]),
        pullRequest: knows([]),
      }))).toEqual([]);
    });
  });

  describe("partsOf()", () => {
    it("splits a name at its last group separator", () => {
      expect(partsOf("bakery > the oven > holds its heat"))
        .toEqual({ chain: "bakery > the oven", leaf: "holds its heat" });
    });

    it("gives an empty chain for a name that names no group", () => {
      expect(partsOf("holds its heat"))
        .toEqual({ chain: "", leaf: "holds its heat" });
    });
  });

  describe("nameSimilarity()", () => {
    it("is one for a name against itself", () => {
      expect(nameSimilarity("kneads the dough", "kneads the dough")).toBe(1);
    });

    it("is high for a small edit and low for a different name", () => {
      expect(nameSimilarity("kneads the dough", "kneads dough"))
        .toBeGreaterThan(RENAME_SIMILARITY);
      expect(nameSimilarity("kneads the dough", "lights the oven"))
        .toBeLessThan(RENAME_SIMILARITY);
    });

    // Two tests under one group share the whole chain, so a comparison
    // over the whole name would say how deep the nesting is.
    it("does not count the group above a name towards its own part", () => {
      const chain = "coverage-check > writeCoverageDebtSuggestion() > ";
      expect(
        nameSimilarity(`${chain}kneads dough`, `${chain}lights an oven`),
      )
        .toBe(nameSimilarity("kneads dough", "lights an oven"));
    });

    // "returns undefined" sits under dozens of groups, so a comparison
    // over the leaf alone calls every pair of those a rename.
    it("does not call two groups' identical leaves alike", () => {
      expect(
        nameSimilarity("oven > returns undefined", "mill > returns undefined"),
      ).toBeLessThan(RENAME_SIMILARITY);
    });
  });

  describe("renames()", () => {
    /**
     * A view where one departing test has caught things, and every test
     * a case names shares one invocation unit with it.
     */
    const withCatches = (
      name: string,
      catches: number,
      ...others: readonly string[]
    ): PullRequestView => ({
      ...unknownPullRequest(),
      manifest: true,
      catches: new Map([[key(name), catches]]),
      units: inOneUnit(name, ...others),
    });

    it("pairs a departure with an arrival and offers the alias line", () => {
      const suggestions = renames(input({
        previous: run([["kneads the dough", "pass"], ["proves", "pass"]]),
        current: run([["kneads the dougk", "pass"], ["proves", "pass"]]),
        pullRequest: withCatches("kneads the dough", 4.5, "proves"),
      }));
      expect(suggestions.length).toBe(1);
      expect(suggestions[0]!.to.n).toBe("kneads the dougk");
      expect(suggestions[0]!.catches).toBe(4.5);
      expect(JSON.parse(suggestions[0]!.aliasLine)).toEqual({
        date: "2026-09-07",
        from: { k: "unit", s: "bakery", n: "kneads the dough" },
        to: { k: "unit", s: "bakery", n: "kneads the dougk" },
      });
    });

    it("offers nothing when the departing test caught nothing", () => {
      expect(renames(input({
        previous: run([["kneads the dough", "pass"], ["proves", "pass"]]),
        current: run([["kneads the dougk", "pass"], ["proves", "pass"]]),
        pullRequest: withCatches("kneads the dough", 0, "proves"),
      }))).toEqual([]);
    });

    it("offers nothing when the names are not alike", () => {
      expect(renames(input({
        previous: run([["kneads the dough", "pass"], ["proves", "pass"]]),
        current: run([["lights the oven", "pass"], ["proves", "pass"]]),
        pullRequest: withCatches("kneads the dough", 4, "proves"),
      }))).toEqual([]);
    });

    // Test names share a describe chain, so two leaves under one chain
    // are alike enough to pair by similarity alone. What separates a
    // rename from a deletion beside an unrelated addition is that the
    // rename's new name is clearly closer than anything else.
    it("offers nothing when two arrivals are nearly as close", () => {
      expect(renames(input({
        previous: run([[
          "census > drops a unit the tree no longer has",
          "pass",
        ]]),
        current: run([
          ["census > drops a unit the tree no longer had", "pass"],
          ["census > keeps a unit the tree no longer has", "pass"],
        ]),
        pullRequest: withCatches(
          "census > drops a unit the tree no longer has",
          4,
        ),
      }))).toEqual([]);
    });

    it("offers nothing for a name the store already knows", () => {
      expect(renames(input({
        previous: run([["kneads the dough", "pass"], ["proves", "pass"]]),
        current: run([["kneads the dougk", "pass"], ["proves", "pass"]]),
        pullRequest: {
          ...withCatches("kneads the dough", 4, "proves"),
          flakes: new Map([[key("kneads the dougk"), undefined]]),
        },
      }))).toEqual([]);
    });

    // A variant is a separate history by construction, so a test under
    // one is never the same test as one under another.
    it("does not pair across variants", () => {
      const gone = testIdentityKey({ ...test("kneads the dough"), v: "on" });
      const arrived = testIdentityKey({
        ...test("kneads the dougk"),
        v: "off",
      });
      expect(renames(input({
        previous: new Map([[gone, "pass" as const]]),
        current: new Map([[arrived, "pass" as const]]),
        pullRequest: {
          ...unknownPullRequest(),
          manifest: true,
          catches: new Map([[gone, 4]]),
          units: new Map([
            [gone, "workspace-unit\tbakery"],
            [arrived, "workspace-unit\tbakery"],
          ]),
        },
      }))).toEqual([]);
    });

    it("offers each of two renames made in one change", () => {
      const suggestions = renames(input({
        previous: run([
          ["kneads the dough", "pass"],
          ["lights the oven", "pass"],
          ["proves", "pass"],
        ]),
        current: run([
          ["kneads the dougk", "pass"],
          ["lights the ovek", "pass"],
          ["proves", "pass"],
        ]),
        pullRequest: {
          ...unknownPullRequest(),
          manifest: true,
          catches: new Map([
            [key("kneads the dough"), 4],
            [key("lights the oven"), 2],
          ]),
          units: inOneUnit(
            "kneads the dough",
            "lights the oven",
            "kneads the dougk",
            "lights the ovek",
            "proves",
          ),
        },
      }));
      expect(suggestions.map((suggestion) => suggestion.from.n)).toEqual([
        "kneads the dough",
        "lights the oven",
      ]);
    });

    it("does not pair across scopes", () => {
      const gone = testIdentityKey(test("kneads the dough", "oven"));
      expect(renames(input({
        previous: new Map([[gone, "pass" as const]]),
        current: new Map([[
          testIdentityKey(test("kneads the dough", "mill")),
          "pass" as const,
        ]]),
        pullRequest: {
          ...unknownPullRequest(),
          manifest: true,
          catches: new Map([[gone, 4]]),
          units: new Map([[gone, "workspace-unit\toven"]]),
        },
      }))).toEqual([]);
    });

    // An arrival two departures both point at answers for neither of
    // them, and appending both lines would credit one test with two
    // tests' records.
    it("offers nothing for an arrival two departures both point at", () => {
      expect(renames(input({
        previous: run([
          ["kneads the dough", "pass"],
          ["kneads the dougx", "pass"],
          ["proves", "pass"],
        ]),
        current: run([["kneads the dougk", "pass"], ["proves", "pass"]]),
        pullRequest: {
          ...unknownPullRequest(),
          manifest: true,
          catches: new Map([
            [key("kneads the dough"), 4],
            [key("kneads the dougx"), 3],
          ]),
          units: inOneUnit(
            "kneads the dough",
            "kneads the dougx",
            "kneads the dougk",
            "proves",
          ),
        },
      }))).toEqual([]);
    });

    // Records exist only for tests that ran. A test missing from a run
    // whose whole unit produced nothing is a test nothing judged, not a
    // test that left, and offering to bridge its history to a name that
    // arrived elsewhere would credit one test with another's record.
    it("offers nothing when the departing test's unit did not run", () => {
      expect(renames(input({
        previous: run([["kneads the dough", "pass"]]),
        current: run([["kneads the dougk", "pass"]]),
        pullRequest: {
          ...unknownPullRequest(),
          manifest: true,
          catches: new Map([[key("kneads the dough"), 4]]),
          units: new Map([[key("kneads the dough"), "workspace-unit\tbakery"]]),
        },
      }))).toEqual([]);
    });
  });

  describe("aliasLineFor()", () => {
    it("writes a line the alias file accepts as it stands", () => {
      expect(aliasLineFor(test("was"), test("is"), "2026-09-07")).toBe(
        '{"date":"2026-09-07","from":{"k":"unit","s":"bakery","n":"was"},' +
          '"to":{"k":"unit","s":"bakery","n":"is"}}',
      );
    });
  });

  describe("shownIdentity()", () => {
    it("writes an identity as a code span", () => {
      expect(shownIdentity(test("kneads"))).toBe("`[unit] bakery: kneads`");
    });

    it("names a variant beside the identity it configures", () => {
      expect(shownIdentity({ ...test("kneads"), v: "server-execution" }))
        .toContain("(server-execution)");
    });

    // A test name is repository content reaching a comment posted with a
    // write token, so a name carrying a backtick must not be able to
    // close its own span and render the rest as Markdown.
    it("fences a name that carries backticks", () => {
      const shown = shownIdentity(test("holds `x` and @octocat"));
      expect(shown.startsWith("``")).toBe(true);
      expect(shown.endsWith("``")).toBe(true);
      expect(shown).toContain("holds `x` and @octocat");
    });

    // A code span cannot cross a line break, so a name carrying one would
    // end its own span and render the rest as Markdown.
    it("puts a name that carries line breaks on one line", () => {
      const shown = shownIdentity(test("first\n\n@octocat **bold**"));
      expect(shown).not.toContain("\n");
      expect(shown).toContain("first @octocat **bold**");
    });
  });

  describe("renderReport()", () => {
    const context = { commit: "a".repeat(40), runUrl: "https://ci/run/7" };

    /** A report holding one of each note, which is what the prose is read on. */
    function everything(): ReportInput {
      return input({
        previous: run([
          ["kneads the dough", "pass"],
          ["proves", "pass"],
          ["bakes", "pass"],
        ]),
        current: run([
          ["kneads the dougk", "pass"],
          ["proves", "fail"],
          ["bakes", "pass"],
          ["scores the loaf", "mixed"],
        ]),
        pullRequest: knows(["proves", "bakes"], {
          catches: new Map([[key("kneads the dough"), 6]]),
          flakes: new Map([
            [key("proves"), { flakes: 5, runs: 80 }],
            [key("bakes"), undefined],
          ]),
          units: inOneUnit("kneads the dough", "proves", "bakes"),
        }),
        coverageBefore: both(
          figures([["workspace", 100]]),
          ownTests([["packages/memory", 10]]),
        ),
        coverage: both(
          figures([["workspace", 100 + COVERAGE_COMMENT_LINES]]),
          ownTests([["packages/memory", 18]]),
        ),
        touched: new Set(["tasks"]),
      });
    }

    it("says nothing when the run found nothing", () => {
      const report = buildReport(input());
      expect(reportIsEmpty(report)).toBe(true);
      expect(renderReport(report, context)).toBeUndefined();
    });

    it("carries every note the run found", () => {
      const body = renderReport(buildReport(everything()), context)!;
      expect(body).toContain("Failing for the first time at this commit");
      expect(body).toContain("Coverage debt");
      expect(body).toContain("packages/memory");
      expect(body).toContain("A new test that turned out to be flaky");
      expect(body).toContain("A rename that discarded a test's history");
      expect(body).toContain("kneads the dougk");
    });

    it("names the commit and the tests, and never a person", () => {
      // It addresses the change, not the person: the subject is a commit
      // and a test, and nothing here can name an author.

      const body = renderReport(buildReport(everything()), context)!;
      expect(body).toContain(context.commit.slice(0, 12));
      expect(body).not.toContain("@");
      expect(body).not.toMatch(/\bauthor\b/i);
      expect(body).not.toMatch(/\byou\b/i);
      expect(body).not.toMatch(/\bwho\b/i);
    });

    it("keeps no history between runs", () => {
      // Nothing is aggregated, ever. A report is a pure function of one
      // run, so a second run's report carries nothing from the first.

      const first = buildReport(everything());
      const second = buildReport(input({
        previous: run([["slices", "pass"]]),
        current: run([["slices", "fail"]]),
      }));
      expect(first.firstFailures.length).toBeGreaterThan(0);
      expect(second.firstFailures.map((failure) => failure.test.n))
        .toEqual(["slices"]);
      expect(second.renames).toEqual([]);
      expect(second.coverageRise).toBeUndefined();
      expect(buildReport(everything())).toEqual(first);
    });

    it("says the selector traded the coverage away, not that it was missed", () => {
      // It is not a judgement, because the system chose not to run the
      // test.

      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: knows(["proves"]),
        })),
        context,
      )!;
      expect(body).toContain("Test selection traded that coverage away");
      expect(body).toContain("nothing here was missed");
      expect(body).not.toMatch(/\b(should have|failed to|forgot)\b/i);
    });

    it("labels a test the store knows disagrees with itself", () => {
      // It is accurate about flakes.

      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: ranThere([["proves", "pass"]], {
            flakes: new Map([[key("proves"), { flakes: 7, runs: 900 }]]),
          }),
        })),
        context,
      )!;
      // The counts rather than the share, so a reader can weigh them:
      // seven in nine hundred is not the claim seven in nine is.
      expect(body).toContain("disagree with itself 7 times in 900 runs");
      expect(body).toContain("may be its own and not the change's");
    });

    it("counts one run as a run rather than as runs", () => {
      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: ranThere([["proves", "pass"]], {
            flakes: new Map([[key("proves"), { flakes: 1, runs: 1 }]]),
          }),
        })),
        context,
      )!;
      expect(body).toContain("disagree with itself once in 1 run over");
    });

    it("counts one disagreement in words rather than as a figure", () => {
      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: ranThere([["proves", "pass"]], {
            flakes: new Map([[key("proves"), { flakes: 1, runs: 40 }]]),
          }),
        })),
        context,
      )!;
      expect(body).toContain("disagree with itself once in 40 runs");
    });

    it("says nothing of a test the store has never seen disagree", () => {
      // A hedge on no evidence tells somebody a real failure may be
      // noise, which is the thing the label exists to avoid saying.
      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: ranThere([["proves", "pass"]], {
            flakes: new Map([[key("proves"), { flakes: 0, runs: 900 }]]),
          }),
        })),
        context,
      )!;
      expect(body).not.toContain("may be its own and not the change's");
    });

    it("says a withheld test could not have run rather than was not run", () => {
      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: knows(["proves"], {
            withheld: new Map([[key("proves"), "flaky" as const]]),
          }),
        })),
        context,
      )!;
      expect(body).toContain("too flaky to judge a change by");
      // And that the branch stayed green for it, which a reader of a
      // failure list would otherwise assume the other way.
      expect(body).toContain("does not fail the run on that branch");
    });

    it("says no run of a withheld test saw it pass and fail at once", () => {
      // An identity is withheld for a flake rate the same window's counts
      // are behind, so the store's counts always follow this line. What
      // the line adds is what those counts do not cover: the two runs the
      // comparison is over are not among the disagreements they count.

      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: knows(["proves"], {
            withheld: new Map([[key("proves"), "flaky" as const]]),
            flakes: new Map([[key("proves"), { flakes: 7, runs: 900 }]]),
          }),
        })),
        context,
      )!;
      expect(body).toContain("no execution of it passed at this commit");
      expect(body).toContain("none failed in the previous run");
      expect(body).toContain("not what either of those two runs saw");
      // And the counts still follow it, saying what the window holds
      // rather than what these two runs did.
      expect(body).toContain("disagree with itself 7 times in 900 runs");
    });

    // A pull request that ran the test and passed it is a flake or an
    // interaction, and telling its author the selector skipped the test
    // would be false wherever selection is not what decided.
    it("says the pull request ran it when its own run did", () => {
      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
          pullRequest: ranThere([["proves", "pass"]]),
        })),
        context,
      )!;
      expect(body).toContain("This pull request ran it, and it passed there");
      expect(body).not.toContain("traded that coverage away");
    });

    it("says so when the pull request's own run could not be read", () => {
      const body = renderReport(
        buildReport(input({
          previous: run([["proves", "pass"]]),
          current: run([["proves", "fail"]]),
        })),
        context,
      )!;
      expect(body).toContain("could not be read");
    });

    it("leads with the marker that makes it one comment", () => {
      // It is actionable and it ends: the marker is what makes the next
      // run edit this comment rather than add another.

      const body = renderReport(buildReport(everything()), context)!;
      expect(body.startsWith(MAIN_REPORT_MARKER)).toBe(true);
    });

    it("gives the alias line as something to paste", () => {
      const body = renderReport(buildReport(everything()), context)!;
      expect(body).toContain("`tasks/test-identity-aliases/`");
      expect(body).toContain('{"date":"2026-09-07","from":');
    });

    it("names where a test would go when a touched group rose", () => {
      const body = renderReport(
        buildReport(input({
          touched: new Set(["packages/memory"]),
          coverageBefore: figures([["workspace", 100], ["packages/memory", 5]]),
          coverage: figures([
            ["workspace", 100 + COVERAGE_COMMENT_LINES],
            ["packages/memory", 30],
          ]),
        })),
        context,
      )!;
      expect(body).toContain("these source groups the change touched rose");
      expect(body).toContain("`packages/memory`: 5 to 30, a rise of 25");
    });

    // Most of a repository-wide movement is often somewhere the change
    // never went, and saying so is what stops the note reading as an
    // accusation about lines nobody here wrote.
    it("says so when the rise is not in anything the change touched", () => {
      const body = renderReport(
        buildReport(input({
          touched: new Set(["packages/memory"]),
          coverageBefore: figures([["workspace", 100], ["packages/memory", 5]]),
          coverage: figures([
            ["workspace", 100 + COVERAGE_COMMENT_LINES],
            ["packages/memory", 5],
          ]),
        })),
        context,
      )!;
      expect(body).toContain("somewhere else in the repository");
    });

    it("names the exclusion list's reason and the sets counted", () => {
      const excluded = [...EXCLUDED_FROM_COVERAGE_GATE.keys()][0]!;
      const body = renderReport(
        buildReport(input({
          touched: new Set([
            "packages/memory",
            "packages/ui",
            "packages/html",
            "tasks",
          ]),
          coverageGate: {
            reached: [
              "workspace-unit/packages/memory",
              "workspace-unit/packages/ui",
              "workspace-unit/packages/html",
            ],
            ran: false,
          },
          coverageBefore: ownTests([[excluded, 10], ["packages/memory", 4]]),
          coverage: ownTests([[excluded, 14], ["packages/memory", 9]]),
        })),
        context,
      )!;
      expect(body).toContain("The list gives the reason:");
      expect(body).toContain(EXCLUDED_FROM_COVERAGE_GATE.get(excluded));
      expect(body).toContain("The change reached 3 measured sets.");
    });

    it("says the coverage note is not a failure", () => {
      const body = renderReport(buildReport(everything()), context)!;
      expect(body).toContain("Nothing failed for it and nothing will");
    });
  });

  describe("renderWithdrawal()", () => {
    it("carries the marker, so it replaces the comment it withdraws", () => {
      const body = renderWithdrawal({
        commit: "b".repeat(40),
        runUrl: "https://ci/run/8",
      });
      expect(body.startsWith(MAIN_REPORT_MARKER)).toBe(true);
      expect(body).toContain("no longer holds");
    });
  });
});
