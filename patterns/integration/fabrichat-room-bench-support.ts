/**
 * What the FabriChat room benchmarks share: reading a room size from the
 * environment, writing diagnostics where the workflow keeps them, seeding a
 * room and loading it once before anything is timed, and reading the posture
 * the deployment under measurement declares.
 */

import { env } from "@commonfabric/integration";
import { writeAllSync } from "./cfc-browser-helpers.ts";
import {
  type FabrichatRoomFixture,
  seedFabrichatRoomOutOfProcess,
} from "./fabrichat-room-fixture.ts";
import { RoomSession } from "./fabrichat-room-session.ts";
import {
  type DeclaredTopicsBrowserPosture,
  readDeclaredTopicsBrowserPosture,
} from "./topics-browser-posture.ts";

/** Reads a positive integer from `name`, or `fallback` when it is unset. */
export function sizeFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; got ${raw}`);
  }
  return value;
}

const encoder = new TextEncoder();

/**
 * Returns a writer of diagnostics tagged `tag` to stderr. A bench body's
 * console output is captured by the JSON reporter, so the stream is written
 * directly, and looped, because one `writeSync` may take only part of a buffer
 * holding a whole sample dump.
 */
export function reporter(tag: string): (message: string) => void {
  return (message) =>
    writeAllSync(Deno.stderr, encoder.encode(`[${tag}] ${message}\n`));
}

export interface SeedLoadedRoomOptions {
  /** The passphrase the room's members derive from, new to this run. */
  passphrase: string;
  memberCount: number;
  messageCount: number;

  /** Where progress is written. */
  report: (message: string) => void;
}

/** The fixtures used by the fixed-size room benchmark. */
export interface FabrichatBenchmarkRooms<Room> {
  /** The room every segment but `send` and `react` visits. */
  read: Room;

  /** The room `send` writes to. */
  send: Room;

  /** The room `react` writes to. */
  react: Room;
}

/**
 * Seeds the fixed-size benchmark's rooms together, so that a run waits only as
 * long as the slowest seed, and resolves only once every one has finished, so
 * that no seed is still running while a segment measures. Rejects as soon as
 * one seed does.
 */
export async function seedFabrichatBenchmarkRooms<Room>(
  seed: (label: keyof FabrichatBenchmarkRooms<Room>) => Promise<Room>,
): Promise<FabrichatBenchmarkRooms<Room>> {
  const [read, send, react] = await Promise.all([
    seed("read"),
    seed("send"),
    seed("react"),
  ]);
  return { read, send, react };
}

/**
 * Seeds a room, then loads it once as its starter, untimed, and returns it.
 *
 * A seeded room's first load builds and commits the derived state of every
 * row, which no later load repeats, so a benchmark whose first measured visit
 * were that load would measure something its other visits do not.
 */
export async function seedLoadedRoom(
  { passphrase, memberCount, messageCount, report }: SeedLoadedRoomOptions,
): Promise<FabrichatRoomFixture> {
  const startedAt = performance.now();
  const fixture = await seedFabrichatRoomOutOfProcess({
    apiUrl: new URL(env.API_URL),
    passphrase,
    memberCount,
    messageCount,
  });
  const seededAt = performance.now();
  const session = await RoomSession.open(fixture);
  try {
    await session.load();
    await session.signIn();
    await session.showMessages();
  } finally {
    await session.close();
  }
  report(
    `seeded ${memberCount} members, ${messageCount} messages as room ` +
      `${fixture.roomId} in space ${fixture.roomSpace} in ` +
      `${Math.round(seededAt - startedAt)}ms; first load took ` +
      `${Math.round(performance.now() - seededAt)}ms`,
  );
  return fixture;
}

let reading: Promise<DeclaredTopicsBrowserPosture> | undefined;

/**
 * Reads, once per process, the server-execution posture the deployment under
 * measurement declares, refusing one that declares none, and writes it with
 * `report`: a timing means something only beside the posture that produced
 * it.
 */
export function benchPosture(
  report: (message: string) => void,
): Promise<DeclaredTopicsBrowserPosture> {
  reading ??= readDeclaredTopicsBrowserPosture(
    env.API_URL,
    env.FRONTEND_URL,
    "A FabriChat room benchmark",
  ).then((posture) => {
    report(`posture ${posture.mode} (shell from ${posture.clientFrom})`);
    return posture;
  });
  return reading;
}

/**
 * The passphrase a run's rooms derive their members from. It is new to each
 * process, so a run's rooms are their members' first, and a run against a
 * toolshed that kept an earlier run's spaces does not find those members'
 * Homes listing that run's rooms as well.
 */
export function runPassphrase(benchmark: string): string {
  return `${benchmark} ${crypto.randomUUID()}`;
}
