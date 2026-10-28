#!/usr/bin/env -S deno run -A

/**
 * Seeds one FabriChat group room and writes the fixture describing it.
 *
 * The FabriChat room benchmarks run this in a child Deno, so the members'
 * runtimes and their peak heap do not stay with the process that then drives
 * the browser. It is also the way to build a room by hand for local profiling:
 *
 *     deno run -A packages/patterns/integration/fabrichat-room-seed.ts \
 *       --api-url=http://localhost:8000/ --passphrase="my room" \
 *       --members=12 --messages=30 --threads=1 --replies=5 \
 *       --reaction-every=4 --out=/tmp/room.json
 *
 * The members' identities derive from `--passphrase`, and the fixture names
 * the passphrase, so the starter can sign in with it. Progress goes to stderr;
 * the fixture goes to `--out` as JSON. An act the room refuses fails the seed
 * with the refusal's reason, and the process exits non-zero.
 */

import { parseArgs } from "@std/cli/parse-args";
import { seedFabrichatRoom } from "./fabrichat-room-fixture.ts";

const flags = parseArgs(Deno.args, {
  string: [
    "api-url",
    "passphrase",
    "members",
    "messages",
    "threads",
    "replies",
    "reaction-every",
    "out",
  ],
});

function required(name: string): string {
  const value = flags[name as keyof typeof flags];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}

function count(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return value;
}

const output = required("out");
const startedAt = performance.now();

const seeding = seedFabrichatRoom({
  apiUrl: new URL(required("api-url")),
  passphrase: required("passphrase"),
  memberCount: count("members"),
  messageCount: count("messages"),
  threadCount: count("threads"),
  repliesPerThread: count("replies"),
  reactionEvery: count("reaction-every"),
  onMessage: (written, total) => {
    // One line per tenth of the room: enough to tell a slow seed from a stuck
    // one without a line per message.
    const step = Math.max(1, Math.floor(total / 10));
    if (written % step !== 0 && written !== total) return;
    console.error(
      `wrote ${written}/${total} messages in ${
        Math.round(performance.now() - startedAt)
      }ms`,
    );
  },
});

// Once the members' runtimes have locked the realm down, a rejection escaping
// the top level is reported as `SES_UNHANDLED_REJECTION` and the process still
// exits with status 0, so a failure sets the status here, where it is caught.
let fixture: Awaited<typeof seeding>;
try {
  fixture = await seeding;
} catch (error) {
  console.error(
    `Seeding failed: ${error instanceof Error ? error.message : error}`,
  );
  Deno.exit(1);
}

await Deno.writeTextFile(output, JSON.stringify(fixture));
