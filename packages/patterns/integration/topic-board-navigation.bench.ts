/**
 * End-to-end navigation of a data-heavy topic board, driven through a real
 * browser against a running toolshed.
 *
 * The micro-benchmarks elsewhere in the repository measure one component at a
 * time. This one measures what a person waits for: a cold page load of a board
 * carrying dozens of topics, signing in, the board's cards appearing, opening a
 * topic, and following a crossref from that topic to a sibling. Each of those
 * is its own benchmark, so the dashboard charts the timeline in parts as well
 * as end to end, and a regression lands on the segment that caused it.
 *
 * Two further segments measure the Topics derivations rather than the
 * navigation over them, for the browser tier of
 * `docs/plans/topics-computation-cost.md`. `comment` is a warm update: sending
 * a comment on an open topic, which moves that topic's comment count and last
 * activity. `backlink` opens the topic the most siblings cite and waits for the
 * rows its backlink derivation produces, which the `crossref` segment above
 * cannot measure — that one follows a citation outward from the topmost card,
 * and the topmost card is the newest topic, which nothing cites. Both record
 * their reads through `topics-browser-measurement.ts` alongside the interval
 * they chart.
 *
 * Every segment benchmark reaches its starting point outside the measured
 * window: the browser is launched, the board is loaded, and the earlier
 * segments are replayed with the timer stopped. Each iteration therefore
 * measures exactly one segment of a fresh navigation, and the benchmarks do not
 * depend on each other or on the order Deno runs them in.
 *
 * Requirements beyond the other bench files: a toolshed at `API_URL`, a shell at
 * `FRONTEND_URL` (which defaults to `API_URL`, where a compiled toolshed serves
 * one), and a Chrome for Astral to drive. `.github/workflows/benchmarks.yml`
 * provides all three. Locally, start the dev servers and run:
 *
 *     API_URL=http://localhost:8000/ FRONTEND_URL=http://localhost:5173/ \
 *       deno bench -A \
 *       packages/patterns/integration/topic-board-navigation.bench.ts
 *
 * Stdout carries the JSON report and nothing else, so everything this file has
 * to say goes to stderr. The board's size and the iteration count go there at
 * startup, since a run's numbers only mean something alongside them.
 */

import { debugStr } from "@commonfabric/data-model";
import {
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import type { Identity } from "@commonfabric/identity";
import {
  crossrefTargets,
  parseTopicBoardDemand,
  seedIdentity,
  seedTopicBoardOutOfProcess,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";
import { describeThrown } from "../../integration/describe-thrown.ts";
import { BoardSession } from "./topic-board-session.ts";
import {
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  fillCfTextarea,
  waitForRuntimeIdle,
  waitForSettledText,
  writeAllSync,
} from "./cfc-browser-helpers.ts";
import { clickButtonWithExactText } from "./note-button-helpers.ts";
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

/**
 * Stable dashboard group used with this file and the benchmark name to identify
 * each browser navigation series.
 */
const GROUP = "topic board";

const DEFAULT_TOPIC_COUNT = 30;

/**
 * Size of the seeded board. CI leaves this alone, so its series all describe
 * the same board; set `CF_TOPIC_BOARD_TOPICS` locally to see how a segment
 * scales with the amount of data. Whichever value is in force is written to
 * stderr below, and so into the run's diagnostics.
 */
const TOPIC_COUNT = (() => {
  const raw = Deno.env.get("CF_TOPIC_BOARD_TOPICS");
  if (raw === undefined) return DEFAULT_TOPIC_COUNT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`CF_TOPIC_BOARD_TOPICS must be a positive integer: ${raw}`);
  }
  return parsed;
})();

/**
 * Measured iterations per segment, plus one unmeasured warm-up. A browser
 * navigation costs seconds, and every iteration of a later segment replays the
 * earlier ones to reach its starting point, so this stays small.
 */
const ITERATIONS = 5;
const WARMUP = 1;

const PASSPHRASE = "topic board navigation benchmark";

/** Which of a topic's citations the crossref segment follows. */
const CROSSREF_INDEX = 0;

/** Heading of the card a topic's backlink rows are listed under. */
const BACKLINKS_HEADING = "Referenced by";

/** The comment composer's field. A topic page holds one `cf-textarea`. */
const COMMENT_FIELD = "cf-textarea";

/** The thread's rendered rows, which are what a sent comment has to reach. */
const COMMENT_ROW = "[data-comment-row]";

/**
 * Text of the composer's send button, which is how the button is addressed: a
 * pattern's non-`data-*` props are assigned as JS properties rather than set as
 * attributes, so `variant="primary"` matches no selector. No other control on a
 * topic page that is not being edited reads `Send`, and neither does the shell.
 */
const SEND_BUTTON = "Send";

/** The create surface the `#profile` wish renders when the viewer has none. */
const PROFILE_NAME_INPUT = "#wish-profile-name-input";

/** Pinned by the runner's wish builtin and by the profile-create pattern. */
const PROFILE_CREATE_ACTION = "CreateProfile";

/** The Profile name the comment segment's comments are filed under. */
const VIEWER = "Topic board benchmark viewer";

/**
 * How many times `Deno.bench` invokes a case's body, and how many of those it
 * discards.
 *
 * Measured on Deno 2.9.4: `n + 2` invocations, of which only the first is
 * dropped, whatever `warmup` is set to. Setting `warmup` to 0, 1, 2 or 5
 * produced the same invocation count and the same measured set, so the option
 * is not what to derive either number from.
 */
const BENCH_INVOCATIONS = ITERATIONS + 2;

/** Invocations `Deno.bench` makes but does not measure. */
const DISCARDED_INVOCATIONS = 1;

/**
 * Topics the comment segment needs: one per invocation of its body, and one
 * more for the read-accounted sample, which reaches its own starting point in a
 * browser of its own.
 */
const COMMENT_TOPICS_NEEDED = BENCH_INVOCATIONS + 1;

// Checked here, above the seeding below, so a board sized through
// `CF_TOPIC_BOARD_TOPICS` says so at once rather than after minutes of seeding
// and several browsers, part-way through the segment that runs out.
if (TOPIC_COUNT < COMMENT_TOPICS_NEEDED) {
  throw new Error(
    `The comment segment files one comment per iteration on a topic that has ` +
      `none, so it needs ${COMMENT_TOPICS_NEEDED} topics and ` +
      `CF_TOPIC_BOARD_TOPICS is ${TOPIC_COUNT}`,
  );
}

/**
 * Returns the indices of the topics that cite `index` on a board of
 * {@link TOPIC_COUNT}
 * topics, newest first, which are the rows the topic's backlink derivation
 * produces and the labels its `Referenced by` card shows.
 */
function citedBy(index: number): number[] {
  const citing: number[] = [];
  for (let candidate = TOPIC_COUNT - 1; candidate >= 0; candidate--) {
    const targets = crossrefTargets(candidate, { topicCount: TOPIC_COUNT });
    if (targets.includes(index)) citing.push(candidate);
  }
  return citing;
}

/**
 * The topic the backlink segment opens: the one the most siblings cite, so the
 * segment measures the largest set of backlink rows this board produces.
 *
 * Which topic that is depends on the board's size, because the fixture points
 * each citing topic's first citation at its immediate predecessor and spreads
 * the rest back over everything earlier. The check below is what holds it to
 * the property the segment needs, rather than this comment naming a topic.
 */
const BACKLINK_TOPIC = (() => {
  let chosen = -1;
  let mostCitations = 0;
  for (let index = 0; index < TOPIC_COUNT; index++) {
    const citations = citedBy(index).length;
    if (citations > mostCitations) {
      chosen = index;
      mostCitations = citations;
    }
  }
  if (chosen < 0) {
    throw new Error(
      `No topic on a ${TOPIC_COUNT}-topic board is cited, so the board ` +
        "produces no backlink rows to measure",
    );
  }
  return chosen;
})();

/** Titles the backlink segment's topic is cited by, which it waits to see. */
const BACKLINK_ROWS = citedBy(BACKLINK_TOPIC).map(topicTitle);

// A topic that cites as well as being cited shows both cards, and their rows
// are both `cf-cell-link`s labelled with a sibling's title, so a wait for a
// title could be satisfied by the wrong card. Say so here rather than let a
// board size chosen through `CF_TOPIC_BOARD_TOPICS` measure the wrong thing.
if (crossrefTargets(BACKLINK_TOPIC, { topicCount: TOPIC_COUNT }).length > 0) {
  throw new Error(
    `Topic ${BACKLINK_TOPIC} is the most cited on a ${TOPIC_COUNT}-topic ` +
      "board and also cites, so a wait for a sibling's title cannot tell its " +
      `\`${BACKLINKS_HEADING}\` rows from its \`References\` ones`,
  );
}

const note = (message: string): void => {
  // Module-scope diagnostics reach the workflow's stderr copy directly. Bench
  // bodies do not: the JSON reporter captures their console output, so a body
  // writes to `Deno.stderr` itself.
  console.error(`[topic-board-navigation] ${message}`);
};

const seedingStartedAt = performance.now();
note(
  `seeding ${TOPIC_COUNT} topics with ${DEMAND} demand into space ${env.SPACE_NAME} at ${env.API_URL}`,
);
const fixture: TopicBoardFixture = await seedTopicBoardOutOfProcess({
  apiUrl: new URL(env.API_URL),
  spaceName: env.SPACE_NAME,
  passphrase: PASSPHRASE,
  topicCount: TOPIC_COUNT,
  demand: DEMAND,
});
const identity: Identity = await seedIdentity(PASSPHRASE);
note(
  `seeded board ${fixture.boardId} in ${
    Math.round(performance.now() - seedingStartedAt)
  }ms; ${ITERATIONS} iterations per segment after ${WARMUP} warm-up`,
);

/**
 * The board the comment segment writes to, in a space of its own.
 *
 * Seeded on first use rather than at module scope, so a run filtered to the
 * segments that do not need it pays nothing for it. The scale benchmark seeds
 * its boards the same way and for the same reason.
 *
 * Sending a comment is a durable write: it moves the topic's comment count and
 * its last activity, and the board orders its cards by last activity, so a
 * commented topic becomes the topmost card. The `crossref` and `journey`
 * segments open the topmost card and then follow a citation out of it, and only
 * the newest few topics cite anything, so a comment landing on the shared
 * fixture would leave those two opening a card with nothing to follow. Do not
 * merge the two boards: nothing orders the cases within a file, so the failure
 * would depend on the order Deno happened to run them in.
 */
let commentSeeding: Promise<TopicBoardFixture> | undefined;

/** Returns the comment board, seeding it on first use. */
function commentBoard(): Promise<TopicBoardFixture> {
  commentSeeding ??= (async () => {
    const startedAt = performance.now();
    const seeded = await seedTopicBoardOutOfProcess({
      apiUrl: new URL(env.API_URL),
      spaceName: `${env.SPACE_NAME}-comment`,
      passphrase: PASSPHRASE,
      topicCount: TOPIC_COUNT,
      demand: DEMAND,
    });
    report(
      `seeded comment board ${seeded.boardId} in ${
        Math.round(performance.now() - startedAt)
      }ms`,
    );
    return seeded;
  })();
  return commentSeeding;
}

/** Returns the board every segment but `comment` shares. */
const mainBoard = (): Promise<TopicBoardFixture> => Promise.resolve(fixture);

/**
 * The Topics program compiled from the sources both boards were seeded from,
 * which a read-accounted sample attributes its runs against. Compiled on first
 * use, and one compile serves every sample.
 */
let compiling: Promise<TopicsProgram> | undefined;

/** Returns the compiled Topics program, compiling it on first use. */
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

/** Index of the topic `pieceId` addresses, by the fid the fixture recorded. */
function topicIndexOf(pieceId: string): number {
  const fid = pieceId.replace(/^of:/, "");
  const index = fixture.topics.findIndex((topic) => topic.fid === fid);
  if (index < 0) {
    throw new Error(`Opened piece ${pieceId} is not a seeded topic.`);
  }
  return index;
}

/**
 * Title of the sibling the topic at `index` cites, which is both the label of
 * the crossref link on its page and the heading of the page that link leads to.
 */
function citedTitle(index: number): string {
  const target = crossrefTargets(index, { topicCount: TOPIC_COUNT })
    .at(CROSSREF_INDEX);
  if (target === undefined) {
    throw new Error(`Topic ${index} cites nothing to navigate to.`);
  }
  return topicTitle(target);
}

/**
 * The text an opened topic's page has to show before it counts as complete:
 * the topic's own title, and the connection it cites.
 */
function expectedOnTopicPage(openedPieceId: string): readonly string[] {
  const index = topicIndexOf(openedPieceId);
  return [topicTitle(index), citedTitle(index)];
}

const encoder = new TextEncoder();

/**
 * Writes `message` to stderr from inside a bench body, where the JSON reporter
 * captures console output and `note()` above therefore cannot be used.
 */
function report(message: string): void {
  // Looped, because one `writeSync` may take only part of the buffer and these
  // carry whole sample dumps; `writeAllSync` says the rest.
  writeAllSync(
    Deno.stderr,
    encoder.encode(`[topic-board-navigation] ${message}\n`),
  );
}

/**
 * How many topics of the comment board have been commented on, so that no two
 * comments land on one topic.
 *
 * Every measured iteration therefore files the FIRST comment on a topic, which
 * is what makes the iterations one shape and their average a number about
 * something. Do not reuse a topic: each iteration would then measure a longer
 * thread than the last. How cost grows with thread length is a real question
 * and it is the headless tier's, whose thread cases run at 10, 100 and 1,000
 * comments.
 */
let commented = 0;

/** Returns the next uncommented topic of the comment board. */
function nextCommentTopic(): number {
  if (commented >= TOPIC_COUNT) {
    throw new Error(
      `The comment segment has used all ${TOPIC_COUNT} topics of the comment ` +
        "board",
    );
  }
  return commented++;
}

/**
 * Which of the two states a topic page's comment composer is in: `create` when
 * the `#profile` wish is showing its create surface, and `ready` when the
 * composer's send button is rendered and enabled. Neither holds while the wish
 * is still resolving, when it publishes no interface at all, so one wait tells
 * the two apart instead of two waits racing; `false` until one of them does.
 *
 * Self-contained, and settling before it reads: it is serialized and runs in
 * the page, and the state it is waiting for is one the page's own pending work
 * produces.
 */
const profileSurface = async (
  probe: ProbeApi,
  nameInput: string,
  sendLabel: string,
): Promise<"create" | "ready" | false> => {
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) return false;
  await settle();
  if (probe.collect(nameInput).length > 0) return "create";
  for (const host of probe.collect("cf-button")) {
    if ((host.textContent ?? "").trim() !== sendLabel) continue;
    const control = host.shadowRoot?.querySelector("[data-cf-button]") ?? host;
    if (
      probe.isRendered(control) && !probe.isDisabled(host) &&
      !probe.isDisabled(control)
    ) {
      return "ready";
    }
  }
  return false;
};

/**
 * Gives the page's viewer a Profile, which is what enables the comment
 * composer's send button: it is disabled until `#profile` resolves to a named
 * profile, and the wish renders its own create surface when there is none. The
 * field beside it is not gated, so a draft can be typed either way and it is
 * the send that waits. A Profile is durable, so a page that already has one is
 * left alone and only the first session of a run does any work here.
 *
 * @throws If the page shows neither surface.
 */
async function ensureProfile(page: Page): Promise<void> {
  const surface = await waitForCondition(page, profileSurface, {
    args: [PROFILE_NAME_INPUT, SEND_BUTTON],
  });
  if (surface === "ready") return;
  if (surface !== "create") {
    throw new Error(
      `The topic page shows neither the \`${PROFILE_NAME_INPUT}\` create ` +
        `surface nor an enabled \`${SEND_BUTTON}\` button`,
    );
  }
  await fillCfInput(page, PROFILE_NAME_INPUT, VIEWER);
  await clickTrustedAction(page, PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
}

/**
 * Shows the topic at `index` of `board` through the shell's own navigation, so
 * one runtime serves the whole sequence, and waits for the view to be that
 * topic. Reaching a topic by clicking needs it to be on a card or a link the
 * page already shows, which the topics these segments measure are not.
 */
async function showTopic(
  navigation: BoardSession,
  board: TopicBoardFixture,
  index: number,
): Promise<void> {
  const pieceId = board.topics[index].fid;
  await navigation.page.evaluate(
    async (spaceName: string, piece: string) => {
      await globalThis.app.setView({ spaceName, pieceId: piece });
    },
    { args: [board.spaceName, pieceId] },
  );
  await waitForPieceView(navigation.page, board.spaceName, pieceId);
}

/**
 * Opens a topic of the comment board and types a comment into its composer,
 * returning the operation that sends it. Everything the send needs is in place
 * before the operation runs: the page shows the topic, the viewer has a
 * Profile, and the draft holds the text. Typing writes the draft cell of its
 * own accord, and that write is not what the segment is named for.
 */
async function reachComment(
  navigation: BoardSession,
): Promise<() => Promise<void>> {
  await navigation.load();
  await navigation.signIn();
  await navigation.showBoard();
  const index = nextCommentTopic();
  await showTopic(navigation, await commentBoard(), index);
  await ensureProfile(navigation.page);
  // Unique to the topic, and no seeded title or body holds it: the fixture's
  // prose is drawn from a fixed vocabulary that does not include these words.
  const body = `benchmark comment on topic ${index}`;
  await fillCfTextarea(navigation.page, COMMENT_FIELD, body);
  await waitForRuntimeIdle(navigation.page);
  return async () => {
    await clickButtonWithExactText(navigation.page, SEND_BUTTON);
    // The thread's own rows, because the comment reaching the thread is what
    // the segment times. Against `body` the wait would answer to the text
    // being anywhere on the page, and the same text was typed into the
    // composer before the interval started.
    await waitForSettledText(navigation.page, COMMENT_ROW, body);
  };
}

/**
 * Brings `navigation` to the board and returns the operation that opens the
 * most cited topic and waits for every backlink row its derivation produces.
 * The heading renders only once there is a row to list, so waiting for it waits
 * on the derivation's output rather than on the page's furniture.
 */
async function reachBacklink(
  navigation: BoardSession,
): Promise<() => Promise<void>> {
  await navigation.load();
  await navigation.signIn();
  await navigation.showBoard();
  return async () => {
    await showTopic(navigation, fixture, BACKLINK_TOPIC);
    await waitForSettledText(navigation.page, "body", BACKLINKS_HEADING);
    for (const title of BACKLINK_ROWS) {
      await waitForSettledText(navigation.page, "body", title);
    }
  };
}

/**
 * Invocations of each case so far, so that the read-accounted sample is taken
 * around an iteration the benchmark keeps rather than the one it discards. See
 * {@link BENCH_INVOCATIONS} for what `Deno.bench` actually does here.
 */
const invocations = new Map<string, number>();

/** Whether this invocation of `name` is the one that samples. */
function samplesThisTime(name: string): boolean {
  const seen = (invocations.get(name) ?? 0) + 1;
  invocations.set(name, seen);
  return seen === DISCARDED_INVOCATIONS + 1;
}

/**
 * Takes `name`'s one read-accounted sample and writes it to stderr, the first
 * time it is asked for.
 *
 * The sample runs in a browser of its own, so the session about to be timed
 * reaches its starting point having had nothing done to it, and so the sample
 * measures the operation from the state every timed iteration starts in. Its
 * elapsed time carries the accounting's overhead, which is why it is reported
 * as reads rather than charted as a series of its own.
 */
async function recordReadsOnce(
  name: string,
  board: () => Promise<TopicBoardFixture>,
  reach: (navigation: BoardSession) => Promise<() => Promise<unknown>>,
): Promise<void> {
  if (!samplesThisTime(name)) return;
  const navigation = await BoardSession.open({
    fixture: await board(),
    identity,
  });
  try {
    const operation = await reach(navigation);
    const sample = await measureTopicsReads(navigation.page, {
      label: name,
      posture: await benchPosture(),
      program: await topicsProgram(),
      operation,
    });
    report(formatTopicsSample(sample).join("\n"));
  } finally {
    await navigation.close();
  }
}

/**
 * Opens a browser on `board`, brings it to a segment's starting point with
 * `reach`, and hands `measure` the bench context to bracket. A failure writes
 * its phase, elapsed time, error and main-thread diagnostics to stderr, without
 * requesting another reply from a possibly stalled worker.
 */
function benchSegment<Reached>(
  name: string,
  board: () => Promise<TopicBoardFixture>,
  reach: (navigation: BoardSession) => Promise<Reached>,
  measure: (
    navigation: BoardSession,
    reached: Reached,
    context: Deno.BenchContext,
  ) => Promise<void>,
): void {
  Deno.bench({
    name,
    group: GROUP,
    n: ITERATIONS,
    warmup: WARMUP,
  }, async (b) => {
    const navigation = await BoardSession.open({
      fixture: await board(),
      identity,
    });
    let startedAt = performance.now();
    let phase = "setup";
    try {
      const reached = await reach(navigation);
      phase = "measurement";
      startedAt = performance.now();
      await measure(navigation, reached, b);
    } catch (error) {
      const failure = {
        name,
        phase,
        elapsedMs: performance.now() - startedAt,
        error: describeThrown(error),
      };
      let diagnostics: unknown;
      try {
        diagnostics = await collectBrowserLoadSummary(navigation.page, name, {
          includeWorker: false,
        });
      } catch (diagnosticError) {
        diagnostics = { unavailable: describeThrown(diagnosticError) };
      }
      report(
        debugStr`failed attempt $quote,indent,long${{
          ...failure,
          diagnostics,
        }}`,
      );
      throw error;
    } finally {
      await navigation.close();
    }
  });
}

/**
 * Run `measure` against a navigation that `reach` has already brought to the
 * segment's starting point. Only `measure` is timed.
 */
function segment<Reached>(
  name: string,
  reach: (navigation: BoardSession) => Promise<Reached>,
  measure: (
    navigation: BoardSession,
    reached: Reached,
  ) => Promise<void>,
): void {
  benchSegment(name, mainBoard, reach, async (navigation, reached, b) => {
    b.start();
    await measure(navigation, reached);
    b.end();
  });
}

/**
 * Registers a segment whose measured operation is timed by the Topics
 * measurement helper: it turns telemetry and read accounting off, brackets the
 * bench context around the operation and the wait for its settled boundary, and
 * leaves its own requests outside that bracket. `reach` returns the operation
 * once it has reached the state the operation runs from.
 */
function measuredSegment(
  name: string,
  board: () => Promise<TopicBoardFixture>,
  reach: (navigation: BoardSession) => Promise<() => Promise<unknown>>,
): void {
  benchSegment(
    name,
    board,
    async (navigation) => {
      await recordReadsOnce(name, board, reach);
      return await reach(navigation);
    },
    async (navigation, operation, b) => {
      await timeTopicsOperation(navigation.page, {
        label: name,
        posture: await benchPosture(),
        operation,
        interval: b,
      });
    },
  );
}

segment(
  "load",
  () => Promise.resolve(),
  (navigation) => navigation.load(),
);

segment(
  "sign in",
  (navigation) => navigation.load(),
  (navigation) => navigation.signIn(),
);

segment(
  "board",
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
  },
  (navigation) => navigation.showBoard(),
);

segment(
  "open topic",
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
    await navigation.showBoard();
  },
  async (navigation) => {
    await navigation.openTopic(expectedOnTopicPage);
  },
);

segment(
  "crossref",
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
    await navigation.showBoard();
    return await navigation.openTopic(expectedOnTopicPage);
  },
  (navigation, opened) =>
    navigation.followCrossref(citedTitle(topicIndexOf(opened))),
);

segment(
  "journey",
  () => Promise.resolve(),
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
    await navigation.showBoard();
    const opened = await navigation.openTopic(expectedOnTopicPage);
    await navigation.followCrossref(citedTitle(topicIndexOf(opened)));
  },
);

measuredSegment("comment", commentBoard, reachComment);

measuredSegment("backlink", mainBoard, reachBacklink);
