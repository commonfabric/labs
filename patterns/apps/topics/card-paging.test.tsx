/**
 * The board's cards, a page at a time: a board holding more topics than one
 * page shows the most recently active page of them and a "Show more…" button,
 * each press adds a page, and once every topic has a card the button is gone.
 *
 * The board is handed its topics as plain values rather than filed through
 * `addTopic`, which is what makes a board of more than two pages cheap enough
 * for a pattern test: the cards read only the scalars `CardSource` names, so a
 * value carrying those is all a card needs. The topic numbered `i` was active
 * at time `i + 1`, so the cards run from the highest number down.
 *
 * The session's page is also checked on its own, over three rows: each card
 * it holds is the row it shows, by identity rather than a copy, so a row that
 * moves keeps the card mapped from it.
 */
import {
  action,
  assert,
  Default,
  equals,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  countElements,
  findNode,
  hasText,
  isButton,
} from "../../tools/test-support/vnode-helpers.ts";
import Topics, {
  CARD_PAGE,
  type CardRow,
  shownCardRows,
  type TopicDemand,
} from "./main.tsx";

/** More topics than two pages hold, so the second press shows a short page. */
const TOPIC_COUNT = 120;

/** The title of the topic numbered `index`. */
const titleOf = (index: number): string =>
  `Paged ${String(index).padStart(4, "0")}`;

/** The board's topics, each carrying what its card reads. */
const TOPICS: TopicDemand[] = Array.from(
  { length: TOPIC_COUNT },
  (_, index) => ({
    [NAME]: titleOf(index),
    title: titleOf(index),
    body: "",
    mentions: [],
    createdAt: index + 1,
    lastActivityAt: index + 1,
    commentCount: 0,
  }),
);

const SHOW_MORE = "Show more…";

/**
 * Whether `view` shows `count` cards: the newest topic's, down to the topic
 * numbered `TOPIC_COUNT - count`, and no older one's.
 */
const showsNewest = (view: unknown, count: number): boolean =>
  countElements(view, "cf-card") === count &&
  hasText(view, titleOf(TOPIC_COUNT - 1)) &&
  hasText(view, titleOf(TOPIC_COUNT - count)) &&
  (count === TOPIC_COUNT || !hasText(view, titleOf(TOPIC_COUNT - count - 1)));

/** Whether `view` offers another page. */
const offersMore = (view: unknown): boolean =>
  findNode(view, isButton(SHOW_MORE)) !== undefined;

/** A card row titled `title`, whose topic is beside the point here. */
const rowTitled = (title: string): CardRow => ({
  topic: null,
  badge: "",
  title,
  snippet: "",
  caption: "",
});

export default pattern(() => {
  const topics = new Writable<TopicDemand[] | Default<[]>>(TOPICS);
  const board = Topics({ topics });

  // The rows a board-wide derivation would hand the session, and a session
  // that shows two of them.
  const rowA = new Writable<CardRow>(rowTitled("A"));
  const rowB = new Writable<CardRow>(rowTitled("B"));
  const rowC = new Writable<CardRow>(rowTitled("C"));
  const rowList = new Writable<CardRow[]>([]);
  const page = shownCardRows({ rows: rowList, shown: new Writable(2) });
  const action_list_rows = action(() => {
    rowList.set([rowA, rowB, rowC]);
  });
  const action_move_the_last_row_first = action(() => {
    rowList.set([rowC, rowA, rowB]);
  });

  return {
    [UI]: board[UI],
    [TESTS]: [
      { render: board[UI] },
      // A page is fewer cards than the board holds topics, so the board shows
      // the first page and offers the next.
      {
        assertion: assert(() =>
          CARD_PAGE === 50 && showsNewest(board[UI], CARD_PAGE) &&
          offersMore(board[UI])
        ),
      },
      { press: board[UI], control: SHOW_MORE },
      {
        assertion: assert(() =>
          showsNewest(board[UI], 2 * CARD_PAGE) && offersMore(board[UI])
        ),
      },
      // The third page is the last twenty topics, and with every topic shown
      // there is nothing more to offer.
      { press: board[UI], control: SHOW_MORE },
      {
        assertion: assert(() =>
          showsNewest(board[UI], TOPIC_COUNT) && !offersMore(board[UI])
        ),
      },
      { action: action_list_rows },
      {
        assertion: assert(() =>
          page.length === 2 && equals(page[0] as object, rowA) &&
          equals(page[1] as object, rowB)
        ),
      },
      // `C` moves to the front: the page holds it, as the link it was, and
      // `B` falls off the end.
      { action: action_move_the_last_row_first },
      {
        assertion: assert(() =>
          page.length === 2 && equals(page[0] as object, rowC) &&
          equals(page[1] as object, rowA)
        ),
      },
    ],
  };
});
