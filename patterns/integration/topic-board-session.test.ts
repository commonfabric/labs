/** Exercises board navigation across different creation and activity orders. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { env } from "@commonfabric/integration";
import {
  seedIdentity,
  seedTopicBoard,
  topicAt,
  topicTitle,
} from "./topic-board-fixture.ts";
import { BoardSession } from "./topic-board-session.ts";
import { initializePiecesController } from "./pieces-controller.ts";
import {
  clickCellLink,
  waitForPieceView,
} from "./topics-navigation-helpers.ts";

describe("BoardSession", () => {
  describe("instance members", () => {
    describe("openTopic()", () => {
      it("opens the newest seeded topic when a topic without citations is listed first", async () => {
        const identity = await seedIdentity(crypto.randomUUID());
        const fixture = await seedTopicBoard({
          apiUrl: new URL(env.API_URL),
          identity,
          topicCount: 3,
          crossrefsPerTopic: 1,
          citingTopics: 1,
        });
        const writer = await initializePiecesController({
          apiUrl: new URL(env.API_URL),
          identity,
          space: fixture.spaceDid,
        });
        try {
          const board = await writer.get(fixture.boardId);
          const firstTopic = await topicAt(board, 0);
          // A fixed future activity stamp puts this topic ahead of
          // the citing topic regardless of the seed's timestamp ties.
          await firstTopic.input.set(8_000_000_000_000, ["lastActivityAt"]);
          await firstTopic.result.get();
        } finally {
          await writer.dispose();
        }

        const session = await BoardSession.open({ fixture, identity });
        try {
          await session.load();
          await session.signIn();
          await session.showBoard();

          const first = await clickCellLink(session.page, "Open");
          expect(first.replace(/^of:/, "")).toBe(fixture.topics[0].fid);
          await waitForPieceView(session.page, fixture.spaceDid, first);
          await session.load();
          await session.signIn();
          await session.showBoard();

          await session.openTopic((pieceId) => {
            expect(pieceId.replace(/^of:/, "")).toBe(fixture.topics[2].fid);
            return [topicTitle(2), topicTitle(1)];
          });
          await session.followCrossref(topicTitle(1));
          await waitForPieceView(
            session.page,
            fixture.spaceDid,
            fixture.topics[1].fid,
          );
        } finally {
          await session.close();
        }
      });
    });
  });
});
