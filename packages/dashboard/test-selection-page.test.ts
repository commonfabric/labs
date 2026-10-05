/**
 * Covers the page behind the two selection tiles: what it says about a
 * manifest, and what it says when there is not one.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type Manifest,
  sampleEntry,
  sampleManifest,
} from "@commonfabric/test-support/records";

import {
  FLAKY_SECTION_ID,
  HEALTH_SECTION_ID,
  testSelectionPage,
  UNSCHEDULABLE_SECTION_ID,
} from "./test-selection-page.ts";
import {
  FLAKE_EXCLUSION_FALLBACK,
  FLAKE_WINDOW_FALLBACK_DAYS,
  LANE_BUDGET_FALLBACK_SECONDS,
} from "./test-selection-manifest.ts";
import { livePage } from "./live-page.ts";

const NOW = Date.parse("2026-08-20T04:00:00.000Z");

/** The page as the route serves it. */
function pageHtml(manifest: Manifest | undefined, now: number): string {
  return livePage(testSelectionPage(manifest, now));
}

/** A manifest whose one test was held back as flaky. */
function heldBack(fields: Partial<Manifest> = {}): Manifest {
  const entry = sampleEntry({ k: "unit", s: "memory", n: "space > writes" }, {
    flakeRate: 0.42,
    flakeEvidence: { flakes: 84, runs: 180 },
  });
  return sampleManifest({
    entries: [entry],
    withheld: [{ test: entry.test, suite: entry.suite, reason: "flaky" }],
    ...fields,
  });
}

describe("test-selection-page", () => {
  describe("testSelectionPage()", () => {
    it("says so when the publisher has written no manifest", () => {
      const page = pageHtml(undefined, NOW);
      expect(page).toContain("No selection manifest has been published yet.");
      expect(page).not.toContain("<table>");
    });

    it("names a flaky test in full, beside the rate it was measured at", () => {
      const page = pageHtml(heldBack(), NOW);
      expect(page).toContain("space &gt; writes");
      expect(page).toContain("42.0%");
      expect(page).toContain(`id="${FLAKY_SECTION_ID}"`);
    });

    it("shows the counts a rate was taken from beside it", () => {
      // A share without its denominator cannot be weighed, and the
      // exclusion this page explains was decided on the share.
      const page = pageHtml(heldBack(), NOW);
      expect(page).toContain("42.0% · 84 in 180");
    });

    it("shows the share alone where a manifest carries no counts", () => {
      const bare = sampleEntry({ k: "unit", s: "memory", n: "bare" }, {
        flakeRate: 0.3,
      });
      const page = pageHtml(
        sampleManifest({
          entries: [bare],
          withheld: [{
            test: bare.test,
            suite: bare.suite,
            reason: "flaky",
          }],
        }),
        NOW,
      );
      expect(page).toContain(`<td class="measure">30.0%</td>`);
    });

    it("says the flake share counts runs, and what it is measured against", () => {
      // A share without its denominator is not a figure anybody can read,
      // and neither half of this one is guessable from the number.
      const page = pageHtml(heldBack(), NOW);
      expect(page).toContain("The share of the runs each test took part in");
      expect(page).toContain("nothing is charged against the count");
      expect(page).toContain("one disagreement among two runs reads as the half");
    });

    it("takes the flake window and threshold from the manifest's own dials", () => {
      const page = pageHtml(
        heldBack({
          dials: { FLAKE_WINDOW_DAYS: 30, FLAKE_EXCLUSION_RATE: 0.2 },
        }),
        NOW,
      );
      expect(page).toContain("over the last 30 days");
      expect(page).toContain("Past 20.0% a test is held back");
    });

    it("falls back to the published policy when the dials name neither", () => {
      const page = pageHtml(heldBack(), NOW);
      expect(page).toContain(`over the last ${FLAKE_WINDOW_FALLBACK_DAYS} days`);
      expect(page).toContain(
        `Past ${(FLAKE_EXCLUSION_FALLBACK * 100).toFixed(1)}% a test`,
      );
    });

    it("orders held-back tests by the rate that held them back", () => {
      const worst = sampleEntry({ k: "unit", s: "memory", n: "worst" }, {
        flakeRate: 0.9,
      });
      const mild = sampleEntry({ k: "unit", s: "memory", n: "mild" }, {
        flakeRate: 0.1,
      });
      const page = pageHtml(
        sampleManifest({
          entries: [mild, worst],
          withheld: [mild, worst].map((entry) => ({
            test: entry.test,
            suite: entry.suite,
            reason: "flaky" as const,
          })),
        }),
        NOW,
      );
      const worstAt = page.indexOf(">worst<");
      const mildAt = page.indexOf(">mild<");
      expect(worstAt).toBeGreaterThan(-1);
      expect(mildAt).toBeGreaterThan(-1);
      expect(worstAt).toBeLessThan(mildAt);
    });

    it("leaves out a section with nothing to list", () => {
      const page = pageHtml(heldBack(), NOW);
      expect(page).not.toContain("Too long for any lane");
    });

    describe("the cost model", () => {
      /** A manifest whose publisher measured the model as broken. */
      const broken = () =>
        sampleManifest({
          health: {
            suites: {
              "cli-core": { fixed: 28, tooLong: 0, batches: 0 },
              "pattern-unit": {
                fixed: 351.3,
                tooLong: 181,
                batches: 36,
                ratio: { median: 0.36, p90: 0.82 },
              },
            },
            lanes: {
              observed: 40,
              pastBound: 3,
              projectedInside: 38,
              overran: 2,
            },
            previous: {
              generatedAt: "2026-09-25T16:30:32.893Z",
              suites: {
                "cli-core": { fixed: 28, tooLong: 0 },
                "pattern-unit": { fixed: 185.5, tooLong: 0 },
              },
            },
            alarms: [
              "pattern-unit: a lane pays 5m51s before it runs any of it",
            ],
          },
        });

      it("says what the publisher found broken", () => {
        const page = pageHtml(broken(), NOW);
        expect(page).toContain(`id="${HEALTH_SECTION_ID}"`);
        expect(page).toContain("The cost model is broken.");
        expect(page).toContain(
          "<li>pattern-unit: a lane pays 5m51s before it runs any of it</li>",
        );
      });

      it("lists the dearest suite first, marked where it is past the budget", () => {
        const page = pageHtml(broken(), NOW);
        expect(page.indexOf("pattern-unit</td>"))
          .toBeLessThan(page.indexOf("cli-core</td>"));
        expect(page).toContain(
          `<tr class="over"><td class="name">pattern-unit</td>`,
        );
        expect(page).toContain(`<tr><td class="name">cli-core</td>`);
      });

      it("shows a figure beside what it was in the manifest before", () => {
        const page = pageHtml(broken(), NOW);
        expect(page).toContain(`351s <span class="was">was 186s</span>`);
        expect(page).toContain(`181 <span class="was">was 0</span>`);
        // Unchanged, so nothing is said about what it was.
        expect(page).toContain(`<td class="measure">28s</td>`);
      });

      it("shows what batches spent over what they were charged", () => {
        const page = pageHtml(broken(), NOW);
        expect(page).toContain(`<td class="measure">0.36</td>`);
        expect(page).toContain(`<td class="measure">0.82</td>`);
      });

      it("says how the lanes came out", () => {
        const page = pageHtml(broken(), NOW);
        expect(page).toContain(
          "3 of the 40 lanes in the cost window ran past their bound, 2 of " +
            "them among the 38 the packer projected to finish inside it.",
        );
      });

      it("says nothing is broken where the publisher found nothing", () => {
        const manifest = broken();
        manifest.health!.alarms = [];
        expect(pageHtml(manifest, NOW))
          .not.toContain("The cost model is broken.");
      });

      it("says so where no lane recorded its work, and names no earlier manifest where there is none", () => {
        const manifest = broken();
        manifest.health!.lanes = {
          observed: 0,
          pastBound: 0,
          projectedInside: 0,
          overran: 0,
        };
        delete manifest.health!.previous;
        const page = pageHtml(manifest, NOW);
        expect(page).toContain(
          "No lane in the cost window recorded its work as a whole.",
        );
        expect(page).not.toContain("A grayed figure is the one in");
        expect(page).toContain(`351s</td>`);
      });

      it("says so where the manifest carries no model figures", () => {
        expect(pageHtml(sampleManifest(), NOW)).toContain(
          "This manifest carries no figures about its cost model that this " +
            "page can read.",
        );
      });
    });

    it("names the tests that are too long for any lane", () => {
      const huge = sampleEntry({ k: "integration", s: "cli", n: "acl.sh" }, {
        cost: 900,
      });
      const page = pageHtml(
        sampleManifest({
          unschedulable: [{ test: huge.test, suite: huge.suite, cost: 900 }],
        }),
        NOW,
      );
      expect(page).toContain("Too long for any lane · 1");
      expect(page).toContain("900s");
      expect(page).toContain("acl.sh");
      expect(page).toContain(`id="${UNSCHEDULABLE_SECTION_ID}"`);
    });

    it("marks the lane whose projected work is past its budget", () => {
      const page = pageHtml(
        sampleManifest({
          lanes: [
            { lane: 1, projectedSeconds: 10, batches: [] },
            {
              lane: 2,
              projectedSeconds: LANE_BUDGET_FALLBACK_SECONDS + 20,
              batches: [],
            },
          ],
        }),
        NOW,
      );
      expect(page).toContain(`<div class="lane"><b>Lane 1</b>`);
      expect(page).toContain(`<div class="lane over"><b>Lane 2</b>`);
    });

    it("holds a lane's bar at its budget rather than past the track", () => {
      const page = pageHtml(
        sampleManifest({
          lanes: [{
            lane: 1,
            projectedSeconds: LANE_BUDGET_FALLBACK_SECONDS * 4,
            batches: [],
          }],
        }),
        NOW,
      );
      expect(page).toContain(`width:100.0%`);
    });

    it("says the packing assumes a pull request that made nothing mandatory", () => {
      // A real lane re-packs against its own diff, so the figures here are
      // the floor rather than what any one pull request runs.
      const page = pageHtml(
        sampleManifest({
          lanes: [{ lane: 1, projectedSeconds: 10, batches: [] }],
        }),
        NOW,
      );
      expect(page).toContain("packs these with nothing mandatory");
    });

    it("counts the tests each lane holds", () => {
      const page = pageHtml(
        sampleManifest({
          lanes: [{
            lane: 1,
            projectedSeconds: 10,
            batches: [
              { suite: "workspace-unit", identities: ["a", "b"] },
              { suite: "workspace-browser", identities: ["c"] },
            ],
          }],
        }),
        NOW,
      );
      expect(page).toContain("3 tests");
    });

    it("says how long ago the manifest was generated", () => {
      const ago = (generatedAt: string) =>
        pageHtml(sampleManifest({ generatedAt }), NOW)
          .match(/, (\S+) ago/)?.[1];
      expect(ago("2026-08-20T03:48:00.000Z")).toBe("12m");
      expect(ago("2026-08-19T04:00:00.000Z")).toBe("24h");
      expect(ago("2026-08-13T04:00:00.000Z")).toBe("7d");
    });

    it("leaves a gap for a test the manifest no longer scores", () => {
      // A test can be held back and yet be missing from the entries: an
      // incremental manifest carries only what ran inside its window. Its
      // rate still occupies its column, so the kind stays under "kind".
      const scored = sampleEntry({ k: "unit", s: "memory", n: "scored" }, {
        flakeRate: 0.5,
      });
      const page = pageHtml(
        sampleManifest({
          entries: [scored],
          withheld: [scored, { test: { k: "browser", s: "shell", n: "gone" } }]
            .map((entry) => ({
              test: entry.test,
              suite: "workspace-unit",
              reason: "flaky" as const,
            })),
        }),
        NOW,
      );
      expect(page).toContain(
        `<tr><td class="measure">50.0%</td><td>unit</td>`,
      );
      expect(page).toContain(`<tr><td class="measure">—</td><td>browser</td>`);
    });

    it("escapes a test name carrying markup", () => {
      const nasty = sampleEntry(
        { k: "unit", s: "memory", n: `<script>alert("x")</script>`, v: "a>b" },
        { flakeRate: 0.5 },
      );
      const page = pageHtml(
        sampleManifest({
          entries: [nasty],
          withheld: [{
            test: nasty.test,
            suite: nasty.suite,
            reason: "flaky",
          }],
        }),
        NOW,
      );
      expect(page).not.toContain("<script>alert");
      expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
      expect(page).toContain("(a&gt;b)");
    });
  });
});
