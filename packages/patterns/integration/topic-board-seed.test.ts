/** Verifies the child seeder's persisted board through a fresh reader. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { env } from "@commonfabric/integration";
import {
  initializePiecesController,
  type PieceController,
} from "./pieces-controller.ts";
import {
  crossrefTargets,
  seedIdentity,
  seedTopicBoardOutOfProcess,
  topicAt,
  topicTitle,
} from "./topic-board-fixture.ts";

describe("topic board seed", () => {
  for (const demand of ["index", "full"] as const) {
    it(`persists the same topics and citation targets with ${demand} demand`, async () => {
      const passphrase = `topic board seed ${crypto.randomUUID()}`;
      const shape = {
        topicCount: 5,
        crossrefsPerTopic: 2,
        citingTopics: 3,
        bodyWords: 120,
      };
      const fixture = await seedTopicBoardOutOfProcess({
        apiUrl: new URL(env.API_URL),
        passphrase,
        demand,
        ...shape,
      });
      expect(fixture.seedDemand).toBe(demand);
      expect(fixture.topics.map((topic) => topic.title)).toEqual(
        Array.from(
          { length: shape.topicCount },
          (_, index) => topicTitle(index),
        ),
      );
      expect(new Set(fixture.topics.map((topic) => topic.fid)).size)
        .toBe(shape.topicCount);

      const reader = await initializePiecesController({
        apiUrl: new URL(env.API_URL),
        space: fixture.spaceDid,
        identity: await seedIdentity(passphrase),
      });
      try {
        const board = await reader.get(fixture.boardId, false);
        const rows = await board.result.get(["index"]) as { title: string }[];
        expect(rows.map((row) => row.title)).toEqual(
          fixture.topics.map((topic) => topic.title),
        );
        expect(await board.result.get(["topics"]))
          .toHaveLength(shape.topicCount);
        const topics: PieceController[] = [];
        for (let index = 0; index < shape.topicCount; index++) {
          const topic = await topicAt(board, index);
          expect(topic.id).toBe(fixture.topics[index].fid);
          expect(await topic.result.get(["title"])).toBe(topicTitle(index));
          const body = await topic.result.get(["body"]) as string;
          expect(body.split(" ")).toHaveLength(shape.bodyWords);
          topics.push(topic);
        }
        for (const [index, topic] of topics.entries()) {
          const mentions = (await topic.result.getCell()).key("mentions");
          await mentions.pull();
          const targets = crossrefTargets(index, shape);
          expect(mentions.get()).toHaveLength(targets.length);
          for (const [position, target] of targets.entries()) {
            expect(
              mentions.key(position).resolveAsCell()
                .equals(topics[target].getCell()),
            ).toBe(true);
          }
        }
      } finally {
        await reader.dispose();
      }
    });
  }
});
