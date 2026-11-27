/**
 * The Topics board's "Show more…" button in a real shell: a session sees one
 * page of cards, a press shows it the next ones, and the count it raised is
 * its own, so a second session of the same user still sees one page, and so
 * does a page loaded after the press.
 *
 * The cards are compared by which seeded titles they carry rather than by a
 * fixed order. The seed files one topic at a time and a handler's clock is
 * coarse, so several topics share an activity time and the order among them is
 * the board's to decide.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";

import type { Identity } from "@commonfabric/identity";
import { env, type Page } from "@commonfabric/integration";
import { login, ShellIntegration } from "@commonfabric/integration/shell-utils";

import { clickCfButton } from "./cfc-browser-helpers.ts";
import {
  seedIdentity,
  seedTopicBoard,
  type TopicBoardFixture,
} from "./topic-board-fixture.ts";
import { CARD_PAGE, waitForBoardCards } from "./topic-board-session.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

/** One page and a few topics more, so a press shows a short second page. */
const TOPIC_COUNT = CARD_PAGE + 5;

/** Opens the board on `page` as `identity`, which starts a session of its
 * own. */
async function openBoard(
  page: Page,
  fixture: TopicBoardFixture,
  identity: Identity,
): Promise<void> {
  await page.goto(`${FRONTEND_URL}${fixture.spaceDid}/${fixture.boardId}`);
  await login(page, identity);
  await waitForPieceView(page, fixture.spaceDid, fixture.boardId);
}

describe("Topics board paging", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let fixture: TopicBoardFixture;

  beforeAll(async () => {
    identity = await seedIdentity(crypto.randomUUID());
    fixture = await seedTopicBoard({
      apiUrl: new URL(API_URL),
      identity,
      topicCount: TOPIC_COUNT,
      crossrefsPerTopic: 0,
      citingTopics: 0,
      bodyWords: 8,
    });
  });

  it("shows the next cards in the session that presses Show more, and in no other", async () => {
    const titles = fixture.topics.map(({ title }) => title);

    const pressing = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: fixture.spaceDid, pieceId: fixture.boardId },
      identity,
    });
    const watching = await shell.newPage();
    await openBoard(watching, fixture, identity);

    const firstPage = await waitForBoardCards(
      pressing,
      fixture,
      CARD_PAGE,
      true,
    );
    expect(new Set(firstPage).size).toBe(CARD_PAGE);
    expect(await waitForBoardCards(watching, fixture, CARD_PAGE, true))
      .toEqual(firstPage);

    // The press shows the topics the first page left out, after the cards
    // already shown, and with every topic shown there is nothing more.
    await clickCfButton(pressing, "#show-more-cards");
    const everyCard = await waitForBoardCards(
      pressing,
      fixture,
      TOPIC_COUNT,
      false,
    );
    expect(everyCard.slice(0, CARD_PAGE)).toEqual(firstPage);
    expect(new Set(everyCard.slice(CARD_PAGE))).toEqual(
      new Set(titles.filter((title) => !firstPage.includes(title))),
    );

    // The other session still shows one page, and so does a page loaded once
    // the press has landed, which is a new session too.
    expect(await waitForBoardCards(watching, fixture, CARD_PAGE, true))
      .toEqual(firstPage);
    await openBoard(watching, fixture, identity);
    expect(await waitForBoardCards(watching, fixture, CARD_PAGE, true))
      .toEqual(firstPage);
  });
});
