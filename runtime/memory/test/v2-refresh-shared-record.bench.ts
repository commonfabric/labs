/**
 * What it costs a tracked graph to let go of one of many referrers of a
 * shared record, for a graph of 100, 1,000, or 10,000 roots that each link
 * to one board document under the same selector, so the board's one record
 * is attributed by every root's record. Two operations lose one such
 * referrer: a refresh after a commit that moves one root's link off the
 * board, and releasing one root. Either leaves the board's record with a
 * walker and makes it a suspect of the cycle sweep, whose search back for
 * a root reaches one through the first referrer it follows, so neither
 * should grow with the root count.
 *
 * Each sample makes the change, untimed for the commit, times the refresh
 * or the release, and then undoes the change, untimed, so every sample
 * starts from the same graph. Fixture construction and the result checks
 * are outside the timed interval. The records one untimed sweep visits are
 * written to stderr once per fixture.
 */

import { toFileUrl } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  extendTrackedGraph,
  refreshTrackedGraph,
  releaseTrackedRoots,
  rootReferrersOf,
  toDirtyKey,
  type TrackedGraphState,
  trackGraph,
} from "../v2/query.ts";

const SPACE = "did:key:z6Mk-memory-v2-refresh-shared-record-bench";
const IDENTITY = {
  principal: "did:key:refresh-shared-record-bench",
  sessionId: "session:refresh-shared-record-bench",
};
const BOARD = "of:refresh-shared-record-bench-board";

/** The topic whose link each sample moves, or whose root it releases. */
const MOVED = "of:refresh-shared-record-bench-topic-0";
const DIRTY = new Set([toDirtyKey(MOVED)]);

/** A topic's watch: its title, and the board's name through its link. */
const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    board: { type: "object", properties: { name: { type: "string" } } },
  },
} as const;

interface Fixture {
  topicCount: number;
  engine: Engine;
  path: string;
  state: TrackedGraphState;
  localSeq: number;
}

const fixtures: Fixture[] = [];

const topicId = (index: number) =>
  `of:refresh-shared-record-bench-topic-${index}`;

const topicRoot = (id: string) => ({
  id,
  selector: { path: [], schema: TOPIC_SCHEMA },
});

/** A topic's value, linking to the board or not. */
function topicValue(title: string, linked: boolean): FabricValue {
  return linked
    ? {
      title,
      board: {
        "/": {
          "link@1": { id: BOARD, path: [], space: SPACE, scope: "space" },
        },
      },
    }
    : { title };
}

/** Commits `MOVED` linking to the board or not. */
function commitMoved(fixture: Fixture, linked: boolean): void {
  fixture.localSeq += 1;
  applyCommit(fixture.engine, {
    ...IDENTITY,
    commit: {
      localSeq: fixture.localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: MOVED,
        value: { value: topicValue("moved", linked) },
      }],
    },
  });
}

/** Runs one refresh over the dirty `MOVED`. */
function refresh(fixture: Fixture): ReturnType<typeof refreshTrackedGraph> {
  return refreshTrackedGraph(SPACE, fixture.engine, fixture.state, DIRTY);
}

/**
 * Checks that `result` kept the board, which every other topic still
 * reaches, and returns the records the sweep visited.
 */
function checkKept(
  fixture: Fixture,
  result: { removed: ReadonlySet<string>; stats: { sweepVisits: number } },
): number {
  if (result.removed.size !== 0) {
    throw new Error("the change retracted a document");
  }
  if (![...fixture.state.entities.keys()].some((key) => key.endsWith(BOARD))) {
    throw new Error("the board left the graph");
  }
  return result.stats.sweepVisits;
}

async function createFixture(topicCount: number): Promise<Fixture> {
  const path = await Deno.makeTempFile({
    prefix: "v2-refresh-shared-record-bench-",
    suffix: ".sqlite",
  });
  const engine = await open({ url: toFileUrl(path) });
  applyCommit(engine, {
    ...IDENTITY,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: BOARD, value: { value: { name: "board" } } },
        ...Array.from({ length: topicCount }, (_, index) => ({
          op: "set" as const,
          id: topicId(index),
          value: { value: topicValue(`topic ${index}`, true) },
        })),
      ],
    },
  });
  const { state } = trackGraph(
    SPACE,
    engine,
    {
      roots: Array.from(
        { length: topicCount },
        (_, index) => topicRoot(topicId(index)),
      ),
    },
    undefined,
    IDENTITY,
  );
  // Every topic and the board.
  if (state.entities.size !== topicCount + 1) {
    throw new Error(
      `expected ${topicCount + 1} delivered documents, got ` +
        `${state.entities.size}`,
    );
  }
  const fixture = { topicCount, engine, path, state, localSeq: 1 };
  commitMoved(fixture, false);
  const visits = checkKept(fixture, refresh(fixture)!);
  commitMoved(fixture, true);
  refresh(fixture);
  console.error(
    `refresh-shared-record: ${topicCount} topics, ` +
      `${visits} records visited per sweep`,
  );
  return fixture;
}

for (const topicCount of [100, 1_000, 10_000]) {
  fixtures.push(await createFixture(topicCount));
}

globalThis.addEventListener("unload", () => {
  for (const fixture of fixtures) {
    close(fixture.engine);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        Deno.removeSync(`${fixture.path}${suffix}`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
});

for (const fixture of fixtures) {
  Deno.bench({
    name: `${fixture.topicCount} topics`,
    group: "refreshTrackedGraph after one topic's link leaves a shared board",
    baseline: fixture.topicCount === 100,
    fn(b) {
      commitMoved(fixture, false);
      b.start();
      const refreshed = refresh(fixture);
      b.end();
      checkKept(fixture, refreshed!);
      commitMoved(fixture, true);
      refresh(fixture);
    },
  });
}

for (const fixture of fixtures) {
  const referrers = rootReferrersOf(SPACE, [topicRoot(MOVED)], IDENTITY);
  Deno.bench({
    name: `${fixture.topicCount} topics`,
    group: "releaseTrackedRoots of one topic linking to a shared board",
    baseline: fixture.topicCount === 100,
    fn(b) {
      b.start();
      const released = releaseTrackedRoots(
        SPACE,
        fixture.engine,
        fixture.state,
        referrers,
      );
      b.end();
      // The released topic leaves; the board stays for the others.
      if (released.removed.size !== 1) {
        throw new Error("the release retracted other than its own topic");
      }
      extendTrackedGraph(SPACE, fixture.engine, fixture.state, {
        roots: [topicRoot(MOVED)],
      });
    },
  });
}
