/**
 * How the cost of showing a board grows with the number of topics on it.
 *
 * `topic-board-navigation.bench.ts` measures one board of one size, which
 * catches a regression but says nothing about shape: a change that is flat at
 * thirty topics and quadratic at three hundred looks the same there. This file
 * measures the same thing — a signed-in cold load, timed until every card has
 * rendered — across several board sizes, so the shape of the curve is a thing
 * the dashboard charts rather than a thing somebody has to go and measure.
 *
 * The boards carry no crossrefs. Citations are what the board can least afford
 * (see `DEFAULT_CITING_TOPICS` in `topic-board-fixture.ts`), and a scaling
 * measurement wants the cost of the list itself, not of the join over it.
 *
 * A second series per size measures a reopen, for the browser tier of
 * `docs/plans/topics-computation-cost.md`: a topic that this page has already
 * opened once, opened again. It asks whether reaching one topic costs more as
 * the board behind it grows, which is the question this file exists for and
 * which the navigation benchmark's single board cannot answer. Reopening writes
 * nothing, so both series share each size's one seeded board.
 *
 * Requirements and stdout discipline are the same as the navigation benchmark:
 * a toolshed at `API_URL`, a shell at `FRONTEND_URL`, a Chrome for Astral, and
 * nothing but the JSON report on stdout.
 */

import { env } from "@commonfabric/integration";
import {
  parseTopicBoardDemand,
  seedIdentity,
  seedTopicBoardOutOfProcess,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";
import { BoardSession } from "./topic-board-session.ts";
import { waitForSettledText, writeAllSync } from "./cfc-browser-helpers.ts";
import {
  formatTopicsSample,
  measureTopicsReads,
  prepareTopicsProgram,
  timeTopicsOperation,
  type TopicsProgram,
} from "./topics-browser-measurement.ts";
import {
  type DeclaredTopicsBrowserPosture,
  readDeclaredTopicsBrowserPosture,
} from "./topics-browser-posture.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

const DEMAND = parseTopicBoardDemand(Deno.env.get("CF_TOPIC_BOARD_DEMAND"));
const GROUP = "topic board scale";

/** Board sizes the curve is sampled at. */
const SIZES = [100, 1000, 10000];

/**
 * The largest board that can be built today.
 *
 * Seeding cost grows faster than the topic count, because the board recomputes
 * its whole crossref join and index on every write and each topic holds the
 * board's own list: on an Apple M3 Max, thirty topics take 33 seconds and
 * 0.95GB of peak resident memory, sixty take 143 seconds and 1.6GB, and a
 * hundred take 274 seconds and 2.6GB.
 *
 * Memory is what binds rather than time. It is close to linear at roughly 26MB
 * per topic, so a thousand needs on the order of 26GB — more than a runner has
 * — while time extrapolates to several hours. Ten thousand is out of reach on
 * both counts. Neither limit belongs to this benchmark, and neither is caused
 * by crossrefs: these boards carry none, creating the same topic pieces without
 * a board is linear and flat in memory, and attaching them to one in a single
 * write is refused by the board's element schema.
 *
 * `docs/development/BENCHMARKS.md` carries the same figures; move both together.
 *
 * The larger sizes are declared and skipped rather than left out, so the curve
 * they belong to is written down and turning them on is one edit. Raise this
 * with `CF_TOPIC_BOARD_SCALE_LIMIT` to run them once a board can be built at
 * that size.
 */
const DEFAULT_SCALE_LIMIT = 100;

const SCALE_LIMIT = (() => {
  const raw = Deno.env.get("CF_TOPIC_BOARD_SCALE_LIMIT");
  if (raw === undefined) return DEFAULT_SCALE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `CF_TOPIC_BOARD_SCALE_LIMIT must be a positive integer: ${raw}`,
    );
  }
  return parsed;
})();

/**
 * Measured iterations per size, plus one unmeasured warm-up. Lower than the
 * navigation benchmark's: each iteration loads a board an order of magnitude
 * larger, and the seed in front of it already dominates the run.
 */
const ITERATIONS = 3;
const WARMUP = 1;

const PASSPHRASE = "topic board scale benchmark";

/**
 * The topic page's empty-thread text. No board card carries it, so seeing it is
 * what says the board view has been replaced by the topic's — the shell
 * selects a piece before its page has rendered, and a title or a comment count
 * would otherwise be matched against the board's own card for that topic.
 */
const EMPTY_THREAD = "No comments yet.";

/** What a seeded topic's comment-count lift renders, none having a comment. */
const COMMENT_COUNT = "0 comments";

const encoder = new TextEncoder();

const note = (message: string): void => {
  // Boards are seeded inside a bench body, where the JSON reporter captures
  // console output. Writing to the stream is what reaches the workflow's copy
  // of stderr, and so `diagnostics.log`. Looped, because one `writeSync` may
  // take only part of the buffer and these carry whole sample dumps.
  writeAllSync(Deno.stderr, encoder.encode(`[topic-board-scale] ${message}\n`));
};

note(
  `sizes ${
    SIZES.join(", ")
  }; building up to ${SCALE_LIMIT} topics with ${DEMAND} demand at ${env.API_URL}`,
);

/**
 * Boards are seeded on first use rather than at module scope, so a size that
 * is skipped costs nothing and a size that runs is seeded once for all of its
 * iterations.
 */
const boards = new Map<number, Promise<TopicBoardFixture>>();

function board(topicCount: number): Promise<TopicBoardFixture> {
  let seeding = boards.get(topicCount);
  if (!seeding) {
    const startedAt = performance.now();
    seeding = seedTopicBoardOutOfProcess({
      apiUrl: new URL(env.API_URL),
      // One space per size, so each board holds only its own topics.
      spaceName: `${env.SPACE_NAME}-${topicCount}`,
      passphrase: PASSPHRASE,
      topicCount,
      demand: DEMAND,
      citingTopics: 0,
    }).then((fixture) => {
      note(
        `seeded ${topicCount} topics in ${
          Math.round(performance.now() - startedAt)
        }ms`,
      );
      return fixture;
    });
    boards.set(topicCount, seeding);
  }
  return seeding;
}

for (const topicCount of SIZES) {
  Deno.bench({
    // Bare sizes: the group already says these are topic boards, and the
    // dashboard has little room for a series label.
    name: `${topicCount}`,
    group: GROUP,
    n: ITERATIONS,
    warmup: WARMUP,
    ignore: topicCount > SCALE_LIMIT,
  }, async (b) => {
    const session = await BoardSession.open({
      fixture: await board(topicCount),
      identity: await seedIdentity(PASSPHRASE),
    });
    try {
      await session.load();
      await session.signIn();
      b.start();
      await session.showBoard();
      b.end();
    } finally {
      await session.close();
    }
  });
}

/**
 * The topic a reopen case opens: the newest, which is the board's first card,
 * since a freshly seeded board's last activity is each topic's creation.
 */
const reopenTopic = (topicCount: number): number => topicCount - 1;

/**
 * Shows the piece `pieceId` through the shell's own navigation, so one runtime
 * serves the whole sequence, and waits for the selected view to be it.
 */
async function showPiece(
  session: BoardSession,
  spaceName: string,
  pieceId: string,
): Promise<void> {
  await session.page.evaluate(
    async (space: string, piece: string) => {
      await globalThis.app.setView({ spaceName: space, pieceId: piece });
    },
    { args: [spaceName, pieceId] },
  );
  await waitForPieceView(session.page, spaceName, pieceId);
}

/**
 * Shows the topic at `index` of `fixture` and waits for its page to have
 * formed:
 * its empty thread, then its title, then the count its comment-count lift
 * produces. These boards carry no citations, so the topic has neither a
 * `Referenced by` card nor a `References` one to wait for.
 */
async function showTopicPage(
  session: BoardSession,
  fixture: TopicBoardFixture,
  index: number,
): Promise<void> {
  await showPiece(session, fixture.spaceName, fixture.topics[index].fid);
  await waitForSettledText(session.page, "body", EMPTY_THREAD);
  await waitForSettledText(session.page, "body", topicTitle(index));
  await waitForSettledText(session.page, "body", COMMENT_COUNT);
}

/**
 * Brings `session` to a board whose newest topic it has already opened once
 * and left again, and returns the operation that opens that topic a second
 * time.
 *
 * That second open is what `reopen` measures. What it is not is worth saying,
 * because the plan's phrase is "reopen or reconnect": the page, its shell, its
 * worker and its runtime client are all up throughout, so this is neither a
 * runtime restart nor a reconnect, and this helper can bracket neither. "The
 * board scaling benchmark" in `docs/development/BENCHMARKS.md` says why. Cold
 * initialization is the navigation benchmark's `load`, `sign in`, `board` and
 * `open topic` segments.
 */
async function reachReopen(
  session: BoardSession,
  fixture: TopicBoardFixture,
): Promise<() => Promise<void>> {
  const index = reopenTopic(fixture.topics.length);
  await session.load();
  await session.signIn();
  await session.showBoard();
  await showTopicPage(session, fixture, index);
  await showPiece(session, fixture.spaceName, fixture.boardId);
  await session.showBoard();
  return () => showTopicPage(session, fixture, index);
}

/**
 * The Topics program a read-accounted sample attributes its runs against,
 * compiled on first use so a run whose sizes are all skipped compiles nothing.
 */
let compiling: Promise<TopicsProgram> | undefined;

function topicsProgram(): Promise<TopicsProgram> {
  compiling ??= prepareTopicsProgram();
  return compiling;
}

/**
 * The server-execution posture the deployment under measurement runs, which
 * labels every sample. Read from the deployment on first use, so a run whose
 * sizes are all skipped asks it nothing, and read once so that every sample of
 * a run carries the same statement of what produced it.
 */
let reading: Promise<DeclaredTopicsBrowserPosture> | undefined;

/** Returns the deployment's declared posture, reading it on first use. */
function benchPosture(): Promise<DeclaredTopicsBrowserPosture> {
  reading ??= readDeclaredTopicsBrowserPosture(
    env.API_URL,
    env.FRONTEND_URL,
    "This benchmark",
  );
  return reading;
}

/**
 * Invocations of each size's reopen case so far, so that the samples written to
 * stderr come from an iteration the benchmark keeps rather than the one it
 * discards.
 *
 * Measured on Deno 2.9.4: a bench body is invoked `n + 2` times and the first
 * invocation is the only one dropped, whatever `warmup` is set to. `warmup`
 * does not control either count — 0, 1, 2 and 5 produce the same invocations
 * and the same measured set — so skipping one invocation is what makes this
 * correct, and `WARMUP` is not what to reason from if it changes.
 */
const invocations = new Map<number, number>();

/** Invocations `Deno.bench` makes but does not measure. */
const DISCARDED_INVOCATIONS = 1;

/** Whether this invocation of `topicCount` is the one that reports. */
function reportsThisTime(topicCount: number): boolean {
  const seen = (invocations.get(topicCount) ?? 0) + 1;
  invocations.set(topicCount, seen);
  return seen === DISCARDED_INVOCATIONS + 1;
}

/**
 * Records a size's reopen with read accounting on, in a browser of its own.
 *
 * It needs one: this runs after the timed interval, and the session that was
 * timed has already performed the reopen, so asking it to reopen again would
 * measure a third visit rather than the operation the interval timed.
 *
 * A reopen is expected to complete no run carrying an authored source
 * location — its runs do carry read samples, which is how they reach the
 * attribution check at all — so the measurement is declared with
 * `mayRunNothing` and what it records is a zero: each lift's row reading zero
 * runs is the reading, and a reopen that begins doing lift work shows up here
 * as rows rather than as an unexplained change in the timing beside it. The
 * declaration permits that zero without asserting it, and reaches only that one
 * outcome — a run carrying a location this sample cannot read still fails it,
 * as does a board whose pivot is not running.
 */
async function recordReopenReads(
  topicCount: number,
  fixture: TopicBoardFixture,
): Promise<void> {
  const session = await BoardSession.open({
    fixture,
    identity: await seedIdentity(PASSPHRASE),
  });
  try {
    const operation = await reachReopen(session, fixture);
    const sample = await measureTopicsReads(session.page, {
      label: `reopen ${topicCount}, reads`,
      posture: await benchPosture(),
      program: await topicsProgram(),
      operation,
      mayRunNothing: true,
    });
    note(formatTopicsSample(sample).join("\n"));
  } finally {
    await session.close();
  }
}

for (const topicCount of SIZES) {
  Deno.bench({
    name: `reopen ${topicCount}`,
    group: GROUP,
    n: ITERATIONS,
    warmup: WARMUP,
    ignore: topicCount > SCALE_LIMIT,
  }, async (b) => {
    const fixture = await board(topicCount);
    const session = await BoardSession.open({
      fixture,
      identity: await seedIdentity(PASSPHRASE),
    });
    try {
      const operation = await reachReopen(session, fixture);
      // A reopen may run nothing in the worker at all: on a 100-topic board
      // one iteration recorded a single `scheduler/run` span and later ones
      // recorded none, and on an eight-topic board a third visit to the same
      // topic recorded none. `mayRunNothing` is declared for that, and each
      // sample records the declaration alongside its run count.
      const sample = await timeTopicsOperation(session.page, {
        label: `reopen ${topicCount}`,
        posture: await benchPosture(),
        operation,
        interval: b,
        mayRunNothing: true,
      });
      if (reportsThisTime(topicCount)) {
        note(formatTopicsSample(sample).join("\n"));
        // Paired with the interval above, and taken after it so the timing the
        // benchmark reports carries none of the accounting's overhead. The
        // timed half cannot see reads and, with telemetry off, cannot see a
        // failed event commit either; this half records both.
        await recordReopenReads(topicCount, fixture);
      }
    } finally {
      await session.close();
    }
  });
}
