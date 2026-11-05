/**
 * How the cost of opening a FabriChat room, and of sending in one, grows with
 * the number of messages it holds.
 *
 * `fabrichat-room.bench.ts` measures one room of one size, which catches a
 * regression but says nothing about shape: a change that is flat at thirty
 * messages and quadratic at three hundred looks the same there. This file
 * measures two of its segments across room sizes, so the shape of each curve
 * is a thing the dashboard charts:
 *
 * - `<size>` is that file's `messages`: a signed-in cold load, timed until the
 *   last message has rendered and a badge names every member.
 * - `send <size>` is its `send`: a message sent from the composer of a room
 *   already showing, timed until the message's row renders.
 *
 * A room renders a row for every message of its main conversation, however
 * many its own `latest` holds, so a room of three hundred messages builds a
 * main-conversation row for each of them except the replies in the thread
 * the fixture seeds, which are rows of the thread pane alone. The curve is
 * what says what that costs.
 *
 * Every room has the twelve members of the fixed-size benchmark, each with a
 * profile of their own, so the members' share of a load is the same at every
 * size and the curve is the messages'. Each size seeds two rooms, one each
 * series, because a `send` adds a message to the room it measures, and a
 * hundred-message room's `<size>` would otherwise measure a room some sends
 * larger than its name. The `send <size>` room itself grows by one message per
 * send, from `<size>` before the first of its five sends, one per invocation
 * of the body and one for its read-accounted sample, to four more before the
 * last; a fresh room per send would multiply each size's seeding by five,
 * and that growth stays well inside one step of a curve whose sizes are a
 * factor of three or more apart.
 *
 * Requirements and stdout discipline are the same as the fixed-size benchmark.
 */

import { debugStr } from "@commonfabric/data-model";
import { env } from "@commonfabric/integration";
import {
  benchPosture,
  reporter,
  runPassphrase,
  seedLoadedRoom,
  sizeFromEnv,
} from "./fabrichat-room-bench-support.ts";
import {
  DEFAULT_MEMBER_COUNT,
  type FabrichatRoomFixture,
} from "./fabrichat-room-fixture.ts";
import { RoomSession } from "./fabrichat-room-session.ts";

const GROUP = "fabrichat room scale";

/** Room sizes the curves are sampled at, in messages. */
const SIZES = [10, 30, 100, 300];

/**
 * The largest room built by default.
 *
 * A room is seeded a message at a time, each a trusted send through a member's
 * runtime that waits for the room to record it before the next member writes,
 * so seeding time grows with the size, and each size seeds two rooms. On the
 * runner the Benchmarks workflow uses, a hundred-message room takes about seven
 * minutes to seed and over a minute and a half to load, and a send into it
 * does not settle within the browser driver's five-minute bound, so the
 * default stops below it. The sizes above the limit are declared and skipped
 * rather than left out, so the curve they belong to is written down and
 * running them is one setting: `CF_FABRICHAT_SCALE_LIMIT` raises it.
 */
const DEFAULT_SCALE_LIMIT = 30;

const SCALE_LIMIT = sizeFromEnv(
  "CF_FABRICHAT_SCALE_LIMIT",
  DEFAULT_SCALE_LIMIT,
);

const MEMBERS = sizeFromEnv("CF_FABRICHAT_MEMBERS", DEFAULT_MEMBER_COUNT);

/**
 * Measured iterations per size, plus one unmeasured warm-up. Lower than the
 * fixed-size benchmark's: the rooms are larger, and their seeding already
 * dominates the run.
 */
const ITERATIONS = 3;
const WARMUP = 1;

/**
 * Invocations `Deno.bench` makes but does not measure: of `n + 2`, only the
 * first, whatever `warmup` is set to (measured on Deno 2.9.4). So `n` is one
 * less than the iterations a run measures.
 */
const DISCARDED_INVOCATIONS = 1;

const PASSPHRASE = runPassphrase("fabrichat room scale benchmark");

const report = reporter("fabrichat-room-scale");

report(
  `sizes ${SIZES.join(", ")} with ${MEMBERS} members; building up to ` +
    `${SCALE_LIMIT} messages at ${env.API_URL}`,
);

/**
 * Rooms are seeded on first use rather than at module scope, so a size that is
 * skipped costs nothing and a size that runs is seeded once for all of its
 * iterations.
 */
const seeded = new Map<string, Promise<FabrichatRoomFixture>>();

/** The room of `size` messages that the series `series` visits. */
function room(series: "load" | "send", size: number) {
  const key = `${series} ${size}`;
  let seeding = seeded.get(key);
  if (!seeding) {
    seeding = seedLoadedRoom({
      passphrase: `${PASSPHRASE} ${key}`,
      memberCount: MEMBERS,
      messageCount: size,
      report,
    });
    seeded.set(key, seeding);
  }
  return seeding;
}

/** Invocations of each case so far, by name. */
const invocations = new Map<string, number>();

/** Counts an invocation of `name`, and returns whether it is the sampled one. */
function samplesThisTime(name: string): boolean {
  const seen = (invocations.get(name) ?? 0) + 1;
  invocations.set(name, seen);
  return seen === DISCARDED_INVOCATIONS + 1;
}

/**
 * Takes `name`'s read-accounted sample in a browser of its own, apart from any
 * timed interval, and writes it to stderr. `reach` brings the browser to the
 * series' starting point and returns the operation to sample.
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

/** Loads the room and signs in, short of the room appearing. */
async function signedIn(session: RoomSession): Promise<() => Promise<void>> {
  await session.load();
  await session.signIn();
  return () => session.showMessages();
}

/** How many `send` bodies have been written, so that each is new. */
let sent = 0;

/** Brings the room up and drafts the next `send` body. */
async function drafted(session: RoomSession): Promise<() => Promise<void>> {
  await session.load();
  await session.signIn();
  await session.showMessages();
  sent++;
  return await session.draft(`Benchmark send ${sent}.`);
}

/**
 * Registers the series `series` at `size`, under `name`, whose iterations each
 * open a browser, reach the starting point with `reach`, and time the
 * operation it returns.
 */
function sizeBench(
  name: string,
  series: "load" | "send",
  size: number,
  reach: (session: RoomSession) => Promise<() => Promise<void>>,
): void {
  Deno.bench({
    name,
    group: GROUP,
    n: ITERATIONS - DISCARDED_INVOCATIONS,
    warmup: WARMUP,
    ignore: size > SCALE_LIMIT,
  }, async (b) => {
    await benchPosture(report);
    const fixture = await room(series, size);
    if (samplesThisTime(name)) await recordReads(name, fixture, reach);
    const session = await RoomSession.open(fixture);
    try {
      const operation = await reach(session);
      b.start();
      await operation();
      b.end();
    } finally {
      await session.close();
    }
  });
}

for (const size of SIZES) {
  // Bare sizes: the group already says these are rooms, and the dashboard has
  // little room for a series label.
  sizeBench(`${size}`, "load", size, signedIn);
  sizeBench(`send ${size}`, "send", size, drafted);
}
