/**
 * Verifies a synthetic seed through a fresh reader that starts no pieces locally.
 * This correctness probe is separate from uninstrumented navigation timings.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import { experimentalOptionsFromEnv } from "@commonfabric/runner";
import { watermarkCell } from "@commonfabric/runner/executor/watermark";

import {
  initializePiecesController,
  type PieceController,
} from "../../packages/patterns/integration/pieces-controller.ts";
import {
  crossrefTargets,
  seedIdentity,
  seedTopicBoard,
  topicAt,
} from "../../packages/patterns/integration/topic-board-fixture.ts";

const apiUrl = new URL(Deno.env.get("API_URL")!);
const runDir = Deno.env.get("CF_CAMPAIGN_RUN_DIR")!;
const spaceName = Deno.env.get("SPACE_NAME")!;
const expectedPosture =
  Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === "true";
expect(experimentalOptionsFromEnv(Deno.env.get).serverExecution).toBe(
  expectedPosture,
);
const topicCount = Number(Deno.env.get("CF_TOPIC_BOARD_TOPICS") ?? 5);
if (!Number.isInteger(topicCount) || topicCount < 1) {
  throw new Error("CF_TOPIC_BOARD_TOPICS must be a positive integer.");
}
const identity = await seedIdentity("server-execution topics campaign");
const shape = {
  topicCount,
  crossrefsPerTopic: 2,
  citingTopics: 3,
  bodyWords: 120,
};
const fixture = await seedTopicBoard({ apiUrl, spaceName, identity, ...shape });
await Deno.writeTextFile(join(runDir, "fixture.json"), JSON.stringify(fixture));
const response = await fetch(new URL("/api/health/stats", apiUrl));
if (!response.ok) {
  throw new Error(
    `Fetching /api/health/stats failed with status ${response.status}.`,
  );
}
await Deno.writeTextFile(
  join(runDir, "stats-after-seed.json"),
  await response.text(),
);

const reader = await initializePiecesController({
  apiUrl,
  space: spaceName,
  identity,
});
try {
  expect(reader.runtime.experimental.serverExecution).toBe(expectedPosture);
  const board = await reader.get(fixture.boardId, false);
  const actualTopics = await board.result.get(["topics"]) as unknown[];
  expect(actualTopics.length).toBe(shape.topicCount);
  const topics: PieceController[] = [];
  for (let index = 0; index < shape.topicCount; index++) {
    const topic = await topicAt(board, index);
    expect(topic.id).toBe(fixture.topics[index].fid);
    expect(await topic.result.get(["title"])).toBe(fixture.topics[index].title);
    const body = await topic.result.get(["body"]) as string;
    expect(body.split(" ").length).toBe(shape.bodyWords);
    topics.push(topic);
  }
  const edges: { from: string; to: string[] }[] = [];
  for (const [index, topic] of topics.entries()) {
    const mentions = (await topic.result.getCell()).key("mentions");
    await mentions.pull();
    const expected = crossrefTargets(index, shape);
    expect((mentions.get() as unknown[]).length).toBe(expected.length);
    for (const [position, target] of expected.entries()) {
      expect(
        mentions.key(position).resolveAsCell().equals(topics[target].getCell()),
      )
        .toBe(true);
    }
    edges.push({
      from: topic.id,
      to: expected.map((target) => topics[target].id),
    });
  }
  const index = await board.result.get(["index"]) as { title: string }[];
  expect(index.map((row) => row.title)).toEqual(
    fixture.topics.map((topic) => topic.title),
  );
  const watermark = expectedPosture
    ? await watermarkCell(reader.runtime, reader.getSpace()).pull()
    : null;
  console.log(JSON.stringify({
    clientPosture: reader.runtime.experimental.serverExecution,
    shape,
    verifiedTopics: topics.length,
    verifiedEdges: edges,
    watermarkObserved: watermark,
    watermarkCoverage: "not established by this readback probe",
  }));
} finally {
  await reader.dispose();
}
