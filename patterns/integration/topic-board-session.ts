/**
 * One browser's pass through a seeded topic board, in the steps a benchmark
 * measures separately.
 *
 * Each step waits on the thing it is waiting for — a routed view, a settled
 * runtime, rendered text — so a step's duration is the latency a person would
 * have seen, with no polling interval added to it.
 */

import { debugStr } from "@commonfabric/data-model";
import { Browser, env, type Page } from "@commonfabric/integration";
import { login } from "@commonfabric/integration/shell-utils";
import type { Identity } from "@commonfabric/identity";
import {
  settleView,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import {
  clickCellLink,
  waitForPieceView,
} from "./topics-navigation-helpers.ts";
import {
  readTopicMentionState,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";

export interface BoardSessionTarget {
  fixture: TopicBoardFixture;

  /** The identity the board was seeded under, and is read back with. */
  identity: Identity;
}

export class BoardSession {
  #browser: Browser;
  #page: Page;
  #target: BoardSessionTarget;
  #pageErrors: string[] = [];

  private constructor(
    browser: Browser,
    page: Page,
    target: BoardSessionTarget,
  ) {
    this.#browser = browser;
    this.#page = page;
    this.#target = target;
    // A navigation that threw in the page may well be fast, and would be
    // meaningless. Collect the exceptions and fail the run at teardown.
    page.addEventListener("pageerror", (event) => {
      this.#pageErrors.push(event.detail.message);
    });
  }

  /** A browser with a blank page, ready for {@link load}. */
  static async open(target: BoardSessionTarget): Promise<BoardSession> {
    // Always headless: a benchmark is measured, not watched, and a visible
    // window would put compositing for a real display in the numbers.
    const browser = await Browser.launch({ headless: true });
    return new BoardSession(browser, await browser.newPage(), target);
  }

  get page(): Page {
    return this.#page;
  }

  /** Cold page load: the shell boots and routes to the board. */
  async load(): Promise<void> {
    const { spaceDid, boardId } = this.#target.fixture;
    await this.#page.goto(`${env.FRONTEND_URL}${spaceDid}/${boardId}`);
    await waitForPieceView(this.#page, spaceDid, boardId);
  }

  /** Sign in, and wait for the runtime the board's data arrives through. */
  async signIn(): Promise<void> {
    await login(this.#page, this.#target.identity);
    await waitForRuntimeIdle(this.#page);
  }

  /**
   * Wait for the board's cards. The list is ordered by last activity, so the
   * first topic seeded is the last card rendered, and its title appearing means
   * every card is there.
   */
  async showBoard(): Promise<void> {
    await waitForSettledText(this.#page, "body", topicTitle(0));
    await settleView(this.#page);
  }

  /**
   * Open the topmost topic and wait for its page: the topic's own title, the
   * text `expected` names as the last thing the page has to form, and a settled
   * view. Waiting for that text is what keeps a segment boundary sharp. A
   * topic's body and its connections arrive separately, so a wait that stopped
   * at the title would leave the connections to finish inside the next segment
   * and charge that segment for them.
   *
   * Returns the opened piece's id.
   *
   * @throws when the page never shows all of `expected`, naming what the topic
   *   stores of its mentions and whether its References card rendered, with the
   *   wait's own error as the cause.
   */
  async openTopic(
    expected: (openedPieceId: string) => readonly string[],
  ): Promise<string> {
    const pieceId = await clickCellLink(this.#page, "Open");
    await waitForPieceView(this.#page, this.#target.fixture.spaceDid, pieceId);
    try {
      for (const text of expected(pieceId)) {
        await waitForSettledText(this.#page, "body", text);
      }
    } catch (cause) {
      throw new Error(await this.#describeUnformedTopic(pieceId), { cause });
    }
    await settleView(this.#page);
    return pieceId;
  }

  /** Follow the crossref labelled `title` to the sibling it names. */
  async followCrossref(title: string): Promise<void> {
    const pieceId = await clickCellLink(this.#page, title);
    await waitForPieceView(this.#page, this.#target.fixture.spaceDid, pieceId);
    await waitForSettledText(this.#page, "body", title);
    await settleView(this.#page);
  }

  async close(): Promise<void> {
    await this.#browser.close();
    if (this.#pageErrors.length > 0) {
      throw new Error(
        `Uncaught browser exception(s) during navigation:\n${
          this.#pageErrors.map((message) => `  ${message}`).join("\n")
        }`,
      );
    }
  }

  /**
   * What a topic page that never formed shows and stores. A sibling's title
   * reaches the page through the topic's References card, which renders the
   * `mentioned` list the `mention` handler writes. Under server execution the
   * handler's stream entry says whether it ever ran, and `mentioned` says what
   * it left.
   */
  async #describeUnformedTopic(pieceId: string): Promise<string> {
    const { spaceDid } = this.#target.fixture;
    const [referencesCard, state] = await Promise.all([
      this.#page.evaluate(() => {
        // The card's heading may sit in any shadow root on the page.
        const visit = (root: Document | ShadowRoot): boolean =>
          [...root.querySelectorAll("*")].some((element) =>
            (element.localName === "cf-heading" &&
              element.textContent?.trim() === "References") ||
            (element.shadowRoot !== null && visit(element.shadowRoot))
          );
        return visit(document);
      }).catch((error) => debugStr`unreadable: $quote,long${error}`),
      readTopicMentionState({
        apiUrl: new URL(env.API_URL),
        identity: this.#target.identity,
        spaceDid,
        pieceId,
      }).catch((error) => debugStr`unreadable: $quote,long${error}`),
    ]);
    return `Topic \`${pieceId}\` never finished forming. ` +
      `References card rendered: ${referencesCard}. ` +
      debugStr`Its stored mention state: $quote,indent,xlong${state}`;
  }
}
