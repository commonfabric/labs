/**
 * Covers the flaky tests as JSON: what it reports of each test held back,
 * the runs it links to, and what it answers with no manifest or an
 * unreadable store.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import {
  type Disagreement,
  type Manifest,
  parseManifest,
  sampleEntry,
  sampleManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";
import { describe, it } from "@commonfabric/test-support/test";

import {
  FLAKY_TESTS_JSON_PATH,
  flakyTestsJson,
} from "./flaky-tests-json.ts";
import type { TestSelectionSource } from "./test-selection-history.ts";
import { makeTestFlakes } from "./tiles/test-flakes.ts";

const NOW = Date.parse("2026-08-20T04:00:00.000Z");

const OLDER: Disagreement = {
  day: "2026-08-18",
  commit: "c1",
  failed: { place: "local" },
};

const NEWER: Disagreement = {
  day: "2026-08-19",
  commit: "c2",
  seed: 20260819,
  failed: {
    place: "pr",
    ci: { runId: "1001", runAttempt: 1, job: "Test (3/8)" },
  },
  passed: {
    place: "pr",
    ci: { runId: "1001", runAttempt: 2, job: "Test (3/8)" },
  },
};

/**
 * A manifest holding two tests, the noisier of them held back as flaky with
 * two disagreements behind it, as a reader of the store gets it back.
 */
function heldBack(fields: Partial<Manifest> = {}): Manifest {
  const flaky = sampleEntry(
    { k: "integration", s: "shell", n: "login > shows the menu", v: "opposite" },
    {
      flakeRate: 0.42,
      flakeEvidence: { flakes: 84, runs: 180 },
      lastRun: "2026-08-19",
      lastFailure: "2026-08-19",
      disagreements: [OLDER, NEWER],
    },
  );
  const steady = sampleEntry({ k: "unit", s: "memory", n: "space > writes" }, {
    flakeRate: 0.001,
    flakeEvidence: { flakes: 1, runs: 900 },
    disagreements: [OLDER],
  });
  const manifest = parseManifest(serializeManifest(sampleManifest({
    commit: "head",
    generatedAt: "2026-08-20T03:00:00.000Z",
    entries: [flaky, steady],
    withheld: [{ test: flaky.test, suite: flaky.suite, reason: "flaky" }],
    ...fields,
  })));
  if (manifest === undefined) throw new Error("the sample does not read");
  return manifest;
}

/** A source whose newest manifest is `manifest`. */
function reading(read: () => Promise<Manifest | undefined>): TestSelectionSource {
  return {
    latest: read,
    history: () => Promise.resolve({ samples: [], errors: [] }),
  };
}

/** The response the flaky tests tile's route gives for `source`. */
function served(source: TestSelectionSource): Promise<Response> {
  const route = makeTestFlakes({ source, now: () => NOW }).routes?.find((
    held,
  ) => held.path === FLAKY_TESTS_JSON_PATH);
  if (route === undefined) throw new Error("the tile serves no flaky.json");
  return Promise.resolve(
    route.handler(
      new Request(`http://dashboard${FLAKY_TESTS_JSON_PATH}`),
      new URL(`http://dashboard${FLAKY_TESTS_JSON_PATH}`),
    ),
  );
}

describe("flaky-tests-json", () => {
  describe("flakyTestsJson()", () => {
    it("reports each test held back with the figures the page shows", () => {
      const body = flakyTestsJson(heldBack(), NOW, "owner/repo");
      expect(body).toMatchObject({
        generatedAt: "2026-08-20T04:00:00.000Z",
        manifest: {
          commit: "head",
          generatedAt: "2026-08-20T03:00:00.000Z",
          windowDays: 60,
          exclusionRate: 0.05,
        },
        tests: [{
          kind: "integration",
          member: "shell",
          name: "login > shows the menu",
          variant: "opposite",
          suite: "workspace-unit",
          unit: "runtime/shell/test/shell.test.ts",
          flakeShare: 0.42,
          flakes: 84,
          runs: 180,
          lastFailure: "2026-08-19",
          lastRun: "2026-08-19",
        }],
      });
    });

    it("gives no last failure where the manifest carries none", () => {
      // A manifest written before the publisher counted it says nothing
      // about when the test last failed, which is not that it never has.
      const manifest = heldBack();
      delete manifest.entries[0]!.lastFailure;
      expect(flakyTestsJson(manifest, NOW).tests[0]!.lastFailure).toBeNull();
    });

    it("leaves out a test that disagreed without being held back", () => {
      const body = flakyTestsJson(heldBack(), NOW);
      expect(JSON.stringify(body)).not.toContain("space > writes");
      expect(body.tests.length).toBe(1);
    });

    it("lists the runs each disagreement was seen across, newest first", () => {
      const body = flakyTestsJson(heldBack(), NOW, "owner/repo");
      expect(body.tests[0]!.disagreements).toEqual([
        {
          day: "2026-08-19",
          commit: "c2",
          seed: 20260819,
          failed: {
            place: "pr",
            runId: "1001",
            runAttempt: 1,
            job: "Test (3/8)",
            url: "https://github.com/owner/repo/actions/runs/1001/attempts/1",
          },
          passed: {
            place: "pr",
            runId: "1001",
            runAttempt: 2,
            job: "Test (3/8)",
            url: "https://github.com/owner/repo/actions/runs/1001/attempts/2",
          },
        },
        {
          // A workstation's run is named by where it was made alone, and a
          // passing run folded before runs were kept is not named at all.
          day: "2026-08-18",
          commit: "c1",
          seed: null,
          failed: {
            place: "local",
            runId: null,
            runAttempt: null,
            job: null,
            url: null,
          },
          passed: null,
        },
      ]);
    });

    it("reads the window and threshold from the manifest's dials", () => {
      const body = flakyTestsJson(
        heldBack({
          dials: { FLAKE_WINDOW_DAYS: 30, FLAKE_EXCLUSION_RATE: 0.01 },
        }),
        NOW,
      );
      expect(body).toMatchObject({
        manifest: { windowDays: 30, exclusionRate: 0.01 },
      });
    });

    it("gives nulls for a held-back test the corpus does not hold", () => {
      const body = flakyTestsJson(heldBack({ entries: [] }), NOW);
      expect(body.tests).toEqual([{
        kind: "integration",
        member: "shell",
        name: "login > shows the menu",
        variant: "opposite",
        suite: "workspace-unit",
        unit: null,
        flakeShare: null,
        flakes: null,
        runs: null,
        lastFailure: null,
        lastRun: null,
        disagreements: [],
      }]);
    });

    it("reports no manifest and no tests for a store holding none", () => {
      expect(flakyTestsJson(undefined, NOW)).toEqual({
        generatedAt: "2026-08-20T04:00:00.000Z",
        manifest: null,
        tests: [],
      });
    });
  });

  describe("the flaky tests tile's route", () => {
    it("serves the newest manifest's flaky tests as JSON", async () => {
      const response = await served(
        reading(() => Promise.resolve(heldBack())),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.tests[0].name).toBe("login > shows the menu");
      expect(body.tests[0].disagreements.length).toBe(2);
    });

    it("answers 503 with the reason when the store cannot be read", async () => {
      using _quiet = stub(console, "error");
      const response = await served(
        reading(() => Promise.reject(new Error("HTTP 500"))),
      );
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.generatedAt).toBe("2026-08-20T04:00:00.000Z");
      expect(body.error).toBe("temporarily unavailable");
      expect(body.tests).toBeUndefined();
    });
  });
});
