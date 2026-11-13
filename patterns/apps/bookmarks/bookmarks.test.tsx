/**
 * Test Pattern: Bookmarks
 *
 * Adds bookmarks through the URL input, searches them by URL, title, and
 * description through the search input, and removes them with each card's
 * remove button, including while a search hides some of them.
 *
 * Run: deno task cf test patterns/apps/bookmarks/bookmarks.test.tsx --verbose
 */
import {
  action,
  assert,
  type Cell,
  handler,
  NAME,
  pattern,
  TESTS,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  countElements,
  findElement,
  findNodeByProp,
  fireClick,
  fireEvent,
  innermostNode,
  readValue,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import Bookmarks from "./bookmarks.tsx";

interface Bookmark {
  url: string;
  title: string;
  description: string;
}

const REMOVE = "Remove bookmark";

/** Types `text` into the input with this placeholder, writing through the
 * cell its `$value` binds, as typing does. A handler's view of the tree keeps
 * that binding a cell; a plain read resolves it to its text. */
const typeText = handler<
  void,
  { ui: Cell<VNode>; placeholder: string; text: string }
>((_event, { ui, placeholder, text }) => typeInto(ui, placeholder, text));

/** Whether the grid shows exactly the previews of `urls`. */
function showsExactly(ui: unknown, urls: string[]): boolean {
  const view = readValue(ui);
  return countElements(view, "cf-link-preview") === urls.length &&
    urls.every((url) => findNodeByProp(view, "url", url) !== undefined);
}

/** Clicks the remove button on the card previewing `url`. */
function removeCard(ui: unknown, url: string): void {
  const card = innermostNode(
    ui,
    (node) =>
      findNodeByProp(node, "url", url) !== undefined &&
      findNodeByProp(node, "title", REMOVE) !== undefined,
  );
  fireClick(
    findNodeByProp(card, "title", REMOVE),
    `the remove button on ${url}`,
  );
}

/** Sends `message` from the URL input, as pressing Add does. */
function submitUrl(ui: unknown, message: string): void {
  fireEvent(findElement(ui, "cf-message-input"), "oncf-send", {
    detail: { message },
  });
}

const urlsOf = (bookmarks: readonly Bookmark[]) =>
  bookmarks.map((bookmark) => bookmark.url).join(",");

export default pattern(() => {
  const bookmarks = new Writable<Bookmark[]>([
    {
      url: "https://alpha.example",
      title: "Alpha",
      description: "Recipes I like",
    },
  ]);
  const board = Bookmarks({ bookmarks });

  const assert_starts_with_seed = assert(() =>
    board[NAME] === "🔖 Bookmarks (1)" &&
    board.count === 1 &&
    showsExactly(board[UI], ["https://alpha.example"])
  );

  const action_add_blank = action(() => {
    submitUrl(board[UI], "   ");
    submitUrl(board[UI], "");
  });
  const assert_blank_ignored = assert(() => board.count === 1);
  const action_add_beta = action(() =>
    submitUrl(board[UI], "  https://beta.example  ")
  );
  const action_add_gamma = action(() =>
    submitUrl(board[UI], "https://gamma.example")
  );
  const assert_urls_added = assert(() =>
    urlsOf(board.bookmarks) ===
      "https://alpha.example,https://beta.example,https://gamma.example" &&
    board.bookmarks[1].title === "" &&
    board[NAME] === "🔖 Bookmarks (3)" &&
    showsExactly(board[UI], [
      "https://alpha.example",
      "https://beta.example",
      "https://gamma.example",
    ])
  );

  const action_search_by_title = typeText({
    ui: board[UI],
    placeholder: "Search bookmarks...",
    text: "ALPHA",
  });
  const assert_title_match = assert(() =>
    showsExactly(board[UI], ["https://alpha.example"])
  );
  const action_search_by_description = typeText({
    ui: board[UI],
    placeholder: "Search bookmarks...",
    text: "recipes",
  });
  const assert_description_match = assert(() =>
    showsExactly(board[UI], ["https://alpha.example"])
  );
  const action_search_by_url = typeText({
    ui: board[UI],
    placeholder: "Search bookmarks...",
    text: "example",
  });
  const assert_url_match = assert(() =>
    showsExactly(board[UI], [
      "https://alpha.example",
      "https://beta.example",
      "https://gamma.example",
    ])
  );

  // The search hides the first two bookmarks, so the only card shown is the
  // third; its remove button removes that one and no other.
  const action_search_gamma = typeText({
    ui: board[UI],
    placeholder: "Search bookmarks...",
    text: "gamma",
  });
  const action_remove_filtered = action(() =>
    removeCard(board[UI], "https://gamma.example")
  );
  const assert_filtered_removed = assert(() =>
    urlsOf(board.bookmarks) === "https://alpha.example,https://beta.example" &&
    showsExactly(board[UI], [])
  );

  const action_clear_search = typeText({
    ui: board[UI],
    placeholder: "Search bookmarks...",
    text: "",
  });
  const action_remove_seeded = action(() =>
    removeCard(board[UI], "https://alpha.example")
  );
  const assert_seeded_removed = assert(() =>
    urlsOf(board.bookmarks) === "https://beta.example" &&
    showsExactly(board[UI], ["https://beta.example"]) &&
    board[NAME] === "🔖 Bookmarks (1)"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_with_seed },
      { action: action_add_blank },
      { assertion: assert_blank_ignored },
      { action: action_add_beta },
      { action: action_add_gamma },
      { assertion: assert_urls_added },
      { action: action_search_by_title },
      { assertion: assert_title_match },
      { action: action_search_by_description },
      { assertion: assert_description_match },
      { action: action_search_by_url },
      { assertion: assert_url_match },
      { action: action_search_gamma },
      { action: action_remove_filtered },
      { assertion: assert_filtered_removed },
      { action: action_clear_search },
      { action: action_remove_seeded },
      { assertion: assert_seeded_removed },
    ],
    board,
  };
});
