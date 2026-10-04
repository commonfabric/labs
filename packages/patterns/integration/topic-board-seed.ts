#!/usr/bin/env -S deno run -A

/**
 * Seeds one synthetic topic board and writes the fixture describing it.
 *
 * `topic-board-navigation.bench.ts` runs this in a child Deno so the seed's
 * peak heap does not stay with the process that then drives the browser. It is
 * also the way to build a board by hand for local profiling:
 *
 *     deno run -A packages/patterns/integration/topic-board-seed.ts \
 *       --api-url=http://localhost:8000/ \
 *       --passphrase="my board" --topics=60 --crossrefs=3 \
 *       --citing-topics=8 --body-words=120 --out=/tmp/board.json
 *
 * The board goes in a new space owned by the identity `--passphrase` derives,
 * and the fixture's `spaceDid` names it. Progress goes to stderr; the fixture
 * goes to `--out` as JSON.
 */

import { parseArgs } from "@std/cli/parse-args";
import {
  parseTopicBoardDemand,
  seedIdentity,
  seedTopicBoard,
} from "./topic-board-fixture.ts";

const flags = parseArgs(Deno.args, {
  string: [
    "api-url",
    "passphrase",
    "topics",
    "demand",
    "crossrefs",
    "citing-topics",
    "body-words",
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

const topicCount = count("topics");
const demand = parseTopicBoardDemand(flags.demand);
const output = required("out");
const startedAt = performance.now();

const fixture = await seedTopicBoard({
  apiUrl: new URL(required("api-url")),
  identity: await seedIdentity(required("passphrase")),
  topicCount,
  demand,
  crossrefsPerTopic: count("crossrefs"),
  citingTopics: count("citing-topics"),
  bodyWords: count("body-words"),
  onTopic: (index) => {
    // One line per tenth of the board: enough to tell a slow seed from a stuck
    // one without a line per topic.
    const step = Math.max(1, Math.floor(topicCount / 10));
    if ((index + 1) % step !== 0 && index + 1 !== topicCount) return;
    console.error(
      `seeded ${index + 1}/${topicCount} topics in ${
        Math.round(performance.now() - startedAt)
      }ms`,
    );
  },
});

await Deno.writeTextFile(output, JSON.stringify(fixture));
