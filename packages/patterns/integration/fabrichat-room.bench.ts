/**
 * End-to-end use of a FabriChat group room, driven through a real browser
 * against a running toolshed, signed in as the member who started the room.
 *
 * The room is one people came to have: twelve members, each with a real Home
 * and a profile created through it in a space of its own, a room their
 * starter created from their manager, and thirty messages written by the
 * members in turn, one thread of five replies, and a reaction on every third
 * message. `fabrichat-room-fixture.ts` builds it, and says why the profiles
 * matter: every participant chip and author badge reads a document in another
 * space.
 *
 * Each segment is its own benchmark, so the dashboard charts what a person
 * waits for in parts and a regression lands on the segment that caused it:
 *
 * - `load`: a cold page load, until the shell has routed to the room.
 * - `sign in`: signing in, until the runtime the room arrives through is idle.
 * - `messages`: the room appearing, until its last message has rendered and a
 *   badge names every member, each name read from that member's profile.
 * - `send`: sending a message from the composer, until its row renders.
 * - `react`: adding the viewer's reaction to one a member already left, until
 *   the message's tally counts both.
 * - `thread`: opening the thread under a message, until every reply renders in
 *   the thread pane.
 * - `journey`: `load`, `sign in` and `messages` end to end.
 *
 * Every segment reaches its starting point outside the measured window, in a
 * browser of its own: the room is loaded and the earlier steps are replayed
 * with the timer stopped. Each iteration therefore measures exactly one
 * segment of a fresh visit.
 *
 * `send` and `react` write to the room, so each runs against a room of its own
 * of the same shape, and neither changes what the other or the reading
 * segments measure. Each `send` adds one message to its room, so its room holds
 * between thirty and thirty-six messages as the run goes on; each `react` adds
 * one reaction to a message that had none of the viewer's, which leaves the
 * room's messages as they were.
 *
 * The three rooms are seeded together on first use, each by members whose
 * identities are new to this run, so each starter's Home lists that one room.
 * Each is then loaded once, untimed, through the same steps a segment takes: a
 * seeded room's first load builds and commits the derived state of every row,
 * which no later load repeats, and that load is not what any segment measures.
 *
 * Requirements are those of `topic-board-navigation.bench.ts`: a toolshed at
 * `API_URL`, a shell at `FRONTEND_URL`, a Chrome for Astral, and nothing but
 * the JSON report on stdout. Locally, start the dev servers and run:
 *
 *     API_URL=http://localhost:8000/ FRONTEND_URL=http://localhost:5173/ \
 *       deno bench -A packages/patterns/integration/fabrichat-room.bench.ts
 *
 * `CF_FABRICHAT_MEMBERS` and `CF_FABRICHAT_MESSAGES` resize all three rooms
 * for a local run; CI leaves them unset, so its series all describe the same
 * room. The size in force goes to stderr at startup.
 */

import { debugStr } from "@commonfabric/data-model";
import { env } from "@commonfabric/integration";
import { describeThrown } from "../../integration/describe-thrown.ts";
import { collectBrowserLoadSummary } from "./cfc-browser-helpers.ts";
import {
  benchPosture,
  type FabrichatBenchmarkRooms,
  reporter,
  runPassphrase,
  seedFabrichatBenchmarkRooms,
  seedLoadedRoom,
  sizeFromEnv,
} from "./fabrichat-room-bench-support.ts";
import {
  DEFAULT_MEMBER_COUNT,
  DEFAULT_REACTION_EVERY,
  type FabrichatRoomFixture,
  reactedMessages,
} from "./fabrichat-room-fixture.ts";
import { RoomSession } from "./fabrichat-room-session.ts";

/**
 * Stable dashboard group used with this file and the benchmark name to
 * identify each segment's series.
 */
const GROUP = "fabrichat room";

const MEMBERS = sizeFromEnv("CF_FABRICHAT_MEMBERS", DEFAULT_MEMBER_COUNT);
const MESSAGES = sizeFromEnv("CF_FABRICHAT_MESSAGES", 30);

/**
 * Measured iterations per segment, plus one unmeasured warm-up. A visit to the
 * room costs seconds, and every iteration of a later segment replays the
 * earlier ones to reach its starting point, so this stays small.
 */
const ITERATIONS = 5;
const WARMUP = 1;

/**
 * How many times `Deno.bench` invokes a case's body, and how many of those it
 * discards: `n + 2` invocations, of which only the first is dropped, whatever
 * `warmup` is set to (measured on Deno 2.9.4). So `n` is one less than the
 * iterations a run measures.
 */
const BENCH_INVOCATIONS = ITERATIONS + 1;
const DISCARDED_INVOCATIONS = 1;

/** The thread the `thread` segment opens. */
const THREAD = 0;

const PASSPHRASE = runPassphrase("fabrichat room benchmark");

// The `react` segment adds the viewer's reaction to a message carrying
// another member's, a different one each invocation, so it needs one such
// message per invocation of its body. Checked here, ahead of minutes of
// seeding, so a room resized through the environment says so at once.
const REACTABLE = reactedMessages(
  MESSAGES,
  MEMBERS,
  DEFAULT_REACTION_EVERY,
);
if (REACTABLE.length < BENCH_INVOCATIONS) {
  throw new Error(
    `The \`react\` segment reacts to one seeded reaction per invocation, so ` +
      `it needs ${BENCH_INVOCATIONS}, and a ${MESSAGES}-message room carries ` +
      `${REACTABLE.length}`,
  );
}

const report = reporter("fabrichat-room");

report(
  `${MEMBERS} members, ${MESSAGES} messages; ${ITERATIONS} iterations per ` +
    `segment after ${WARMUP} warm-up, at ${env.API_URL}`,
);

/** The rooms the segments visit, by what they do there. */
type Rooms = FabrichatBenchmarkRooms<FabrichatRoomFixture>;

let seeding: Promise<Rooms> | undefined;

/**
 * Seeds every room on first use, each in a child of its own and all three
 * together, and resolves once all of them have finished, so that no setup
 * work runs while a segment measures.
 */
function rooms(): Promise<Rooms> {
  const seed = (label: string) =>
    seedLoadedRoom({
      passphrase: `${PASSPHRASE} ${label}`,
      memberCount: MEMBERS,
      messageCount: MESSAGES,
      report,
    });
  seeding ??= seedFabrichatBenchmarkRooms(seed);
  return seeding;
}

/** Returns one of the rooms once all three have finished seeding. */
function room(label: keyof Rooms): () => Promise<FabrichatRoomFixture> {
  return async () => (await rooms())[label];
}

/** Invocations of each case so far, by name. */
const invocations = new Map<string, number>();

/**
 * Counts an invocation of `name`, and returns whether it is the first one the
 * benchmark keeps, which is the one that takes a read-accounted sample.
 */
function samplesThisTime(name: string): boolean {
  const seen = (invocations.get(name) ?? 0) + 1;
  invocations.set(name, seen);
  return seen === DISCARDED_INVOCATIONS + 1;
}

/** How many `send` bodies have been written, so that each is new. */
let sent = 0;

/** How many of {@link REACTABLE} the `react` segment has used. */
let reacted = 0;

/**
 * Opens a browser on `room`, brings it to a segment's starting point with
 * `reach`, and times `measure` alone. A failure writes its phase, elapsed
 * time, error and main-thread diagnostics to stderr before it propagates.
 */
function segment<Reached>(
  name: string,
  room: () => Promise<FabrichatRoomFixture>,
  reach: (session: RoomSession) => Promise<Reached>,
  measure: (session: RoomSession, reached: Reached) => Promise<void>,
  sample?: (session: RoomSession) => Promise<() => Promise<void>>,
): void {
  Deno.bench({
    name,
    group: GROUP,
    n: ITERATIONS - DISCARDED_INVOCATIONS,
    warmup: WARMUP,
  }, async (b) => {
    await benchPosture(report);
    const fixture = await room();
    if (sample !== undefined && samplesThisTime(name)) {
      await recordReads(name, fixture, sample);
    }
    const session = await RoomSession.open(fixture);
    let startedAt = performance.now();
    let phase = "setup";
    try {
      const reached = await reach(session);
      phase = "measurement";
      startedAt = performance.now();
      b.start();
      await measure(session, reached);
      b.end();
    } catch (error) {
      let diagnostics: unknown;
      try {
        diagnostics = await collectBrowserLoadSummary(session.page, name, {
          includeWorker: false,
        });
      } catch (diagnosticError) {
        diagnostics = { unavailable: describeThrown(diagnosticError) };
      }
      report(
        debugStr`failed attempt $quote,indent,long${{
          name,
          phase,
          elapsedMs: performance.now() - startedAt,
          error: describeThrown(error),
          diagnostics,
        }}`,
      );
      throw error;
    } finally {
      await session.close();
    }
  });
}

/**
 * Takes `name`'s read-accounted sample in a browser of its own, so the session
 * about to be timed starts with nothing done to it, and writes the sample to
 * stderr. `reach` brings the browser to the segment's starting point and
 * returns the operation to sample.
 */
async function recordReads(
  name: string,
  fixture: FabrichatRoomFixture,
  reach: (session: RoomSession) => Promise<() => Promise<void>>,
): Promise<void> {
  const session = await RoomSession.open(fixture);
  try {
    const operation = await reach(session);
    const sample = await session.sampleReads(operation);
    report(debugStr`${name} reads: $quote,long${sample}`);
  } finally {
    await session.close();
  }
}

/** Loads the room and signs in, the start of every segment past `sign in`. */
async function signedIn(session: RoomSession): Promise<void> {
  await session.load();
  await session.signIn();
}

/** Loads the room, signs in, and waits for it to appear. */
async function inRoom(session: RoomSession): Promise<void> {
  await signedIn(session);
  await session.showMessages();
}

/** Drafts the next `send` body in a room the session is already showing. */
async function draftNext(session: RoomSession): Promise<() => Promise<void>> {
  await inRoom(session);
  sent++;
  return await session.draft(`Benchmark send ${sent}.`);
}

segment(
  "load",
  room("read"),
  () => Promise.resolve(),
  (session) => session.load(),
);

segment(
  "sign in",
  room("read"),
  (session) => session.load(),
  (session) => session.signIn(),
);

segment(
  "messages",
  room("read"),
  signedIn,
  (session) => session.showMessages(),
  async (session) => {
    await signedIn(session);
    return () => session.showMessages();
  },
);

segment(
  "send",
  room("send"),
  draftNext,
  (_session, send) => send(),
  draftNext,
);

segment(
  "react",
  room("react"),
  async (session) => {
    await inRoom(session);
    const index = REACTABLE[reacted++];
    if (index === undefined) {
      throw new Error("The `react` segment has used every seeded reaction");
    }
    return session.reaction(index);
  },
  (_session, react) => react(),
);

segment(
  "thread",
  room("read"),
  inRoom,
  (session) => session.openThread(THREAD),
);

segment(
  "journey",
  room("read"),
  () => Promise.resolve(),
  inRoom,
);
