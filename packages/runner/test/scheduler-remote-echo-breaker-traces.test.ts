/**
 * The remote-echo breaker against revision histories of the Topics social
 * space (`topics-dev-476ea34f`), taken from the 2026-08-18 export of that
 * space's database. `fixtures/topics-echo-traces.json.gz` holds two sets:
 *
 * - `storm`: the five documents most rewritten in the July 2026 write storms,
 *   two minutes of each. Every one is the loop the breaker exists for: two or
 *   three sessions rewriting one result slot with their own spelling of a
 *   link, the value flipping on every commit. The two fast documents are at
 *   their densest two minutes, and the three slow ones at the two minutes of
 *   their busiest hour closest to that hour's average density, so the slow
 *   slices hold the cadence those loops sustained for hours rather than a
 *   peak: three to five echoes per session per ten seconds.
 * - `quiet`: every document written four or more times in the three weeks
 *   after the storms ended, the busiest ordinary traffic the space saw: cold
 *   loads re-persisting user-scoped derivations, board indexes recomputed as
 *   topics were added, and drafts typed into session-scoped cells.
 *
 * A trace is a list of `[session, secondsSinceFirst, valueIndex]` commits.
 * The replay gives each session one breaker and one action, as each session
 * is its own runtime and the export names no actions, and counts a commit as
 * an echo step for its session when it changed the document's value and as a
 * convergence step when it did not. Three approximations, none of which an
 * assertion here rests on: the export records what was committed and not what
 * triggered the run, so a handler's write or a derivation of some other input
 * counts as a self-triggered rewrite would; a session whose several actions
 * shared a slot is counted as one action; and every commit is fed whether or
 * not a tripped breaker would have deferred the run that made it, which can
 * only raise the count. The replay is therefore an upper bound on what the
 * breaker would see from the quiet traffic, and for the storm documents, whose
 * every commit was a derivation rewriting the document that had just
 * re-triggered it, the count a breaker on that session would have kept.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/utils/logger";

import { RemoteEchoBreaker } from "../src/scheduler/echo-breaker.ts";
import { gunzip } from "./traverse-replay/gzip.ts";

type TraceKind =
  | "storm-fast"
  | "storm-slow"
  | "quiet-space"
  | "quiet-user"
  | "quiet-session-draft";

interface Trace {
  readonly label: string;
  readonly kind: TraceKind;
  readonly note?: string;
  readonly sessions: number;
  readonly events: readonly (readonly [number, number, number])[];
}

interface Traces {
  readonly storm: readonly Trace[];
  readonly quiet: readonly Trace[];
}

const ACTION = "topics-derivation";

const traces: Traces = JSON.parse(
  new TextDecoder().decode(
    await gunzip(
      Deno.readFileSync(
        new URL("./fixtures/topics-echo-traces.json.gz", import.meta.url),
      ),
    ),
  ),
);

/** Counts the commits that changed the document's value. */
function changedCommits(trace: Trace): number {
  return trace.events.filter((event, index) =>
    index > 0 && event[2] !== trace.events[index - 1][2]
  ).length;
}

/**
 * Replays one document's history through one breaker per session and returns
 * how many times each session's breaker tripped.
 */
function replay(trace: Trace): number[] {
  const breakers = Array.from(
    { length: trace.sessions },
    () => new RemoteEchoBreaker(),
  );
  let previous: number | undefined;
  for (const [session, seconds, value] of trace.events) {
    // The first commit has nothing before it to differ from, and a
    // convergence step for a pair no breaker holds yet is a no-op.
    const changed = previous !== undefined && value !== previous;
    previous = value;
    breakers[session].observe(
      ACTION,
      [{ docKey: trace.label, changed }],
      seconds * 1000,
    );
  }
  // `stats()` counts active deadlines against the instant it is given; the
  // trip count is cumulative and does not depend on it.
  return breakers.map((breaker) =>
    breaker.stats(Number.POSITIVE_INFINITY).trips
  );
}

/** Lists the traces of `kind`. */
function ofKind(kind: TraceKind): Trace[] {
  const found = [...traces.storm, ...traces.quiet]
    .filter((trace) => trace.kind === kind);
  expect(found.length).toBeGreaterThan(0);
  return found;
}

/** Lists the labels of the traces of `kind` on which some session trips. */
function tripped(kind: TraceKind): string[] {
  return ofKind(kind)
    .filter((trace) => replay(trace).some((trips) => trips > 0))
    .map((trace) => trace.label);
}

/** Lists the labels of the traces of `kind` on which no session trips. */
function untripped(kind: TraceKind): string[] {
  return ofKind(kind)
    .filter((trace) => replay(trace).every((trips) => trips === 0))
    .map((trace) => trace.label);
}

describe("scheduler-remote-echo-breaker-traces", () => {
  // The breaker logs one error line per trip through the process-wide
  // "scheduler" logger. The storm traces trip by design, so the lines carry
  // nothing here; silence the logger for the file and restore it after.
  const logger = getLogger("scheduler");
  let level: typeof logger.level;

  beforeAll(() => {
    level = logger.level;
    logger.level = "silent";
  });

  afterAll(() => {
    logger.level = level;
  });

  describe("the fixture", () => {
    it("holds the five storm documents and more than a hundred quiet ones", () => {
      expect(traces.storm.length).toBe(5);
      expect(traces.quiet.length).toBeGreaterThan(100);
    });

    it("holds storm documents whose every commit after the first changed the value", () => {
      for (const trace of traces.storm) {
        expect(changedCommits(trace)).toBe(trace.events.length - 1);
      }
    });
  });

  describe("the storm documents", () => {
    it("trips on every document looping at the fast cadence", () => {
      expect(untripped("storm-fast")).toEqual([]);
    });

    it("trips on every document looping at the slow cadence", () => {
      // Three of the five storm documents looped at three to five echoes per
      // session per ten seconds for hours, which is the cadence the toolshed
      // instance serving the space sustained once it was saturated. A breaker
      // that only sees the fast cadence leaves the slow majority running.

      expect(untripped("storm-slow")).toEqual([]);
    });
  });

  describe("the quiet documents", () => {
    it("never trips on a space-scoped document", () => {
      expect(tripped("quiet-space")).toEqual([]);
    });

    it("never trips on a user-scoped document", () => {
      // The busiest quiet traffic: a cold board load re-persisting one
      // user-scoped derivation per session, over two hundred sessions on one
      // document, each writing it once or twice.

      expect(tripped("quiet-user")).toEqual([]);
    });

    it("trips on the two typed drafts, which the breaker never sees", () => {
      // The session-scoped drafts are text typed into a per-session cell by
      // an event handler, up to ten commits in ten seconds, and the breaker
      // never classifies a handler's write. The replay cannot tell a handler
      // write from a derivation's, so on these two it trips where the breaker
      // would not. They stay in the fixture because they are the densest
      // write bursts the quiet weeks held, and the one over-approximation the
      // replay makes that a threshold proposal has to be read against.

      expect(tripped("quiet-session-draft")).toEqual([
        "of:fid1:jzdkfT6iIEuv6sCf/session",
        "of:fid1:34W9RnbyUmOdgiRd/session",
      ]);
    });
  });
});
