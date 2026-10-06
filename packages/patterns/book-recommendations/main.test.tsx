import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import BookRecommendations, { RECOMMENDATION_SCHEMA } from "./main.tsx";
import { hasText } from "../test/vnode-helpers.ts";
import RecommendationView, {
  type Book,
  type RecommendationState,
} from "./view.tsx";

export default pattern(() => {
  const book = new Writable<Book>({
    title: "The Dispossessed",
    author: "Ursula K. Le Guin",
  });
  const secondBook = new Writable<Book>({
    title: "Parable of the Sower",
    author: "Octavia E. Butler",
  });
  const thirdBook = new Writable<Book>({
    title: "The Fifth Season",
    author: "N. K. Jemisin",
  });
  const fourthBook = new Writable<Book>({
    title: "A Psalm for the Wild-Built",
    author: "Becky Chambers",
  });
  const fifthBook = new Writable<Book>({
    title: "Babel",
    author: "R. F. Kuang",
  });
  const shelf = BookRecommendations({});
  const assert_top_level_view = assert(() =>
    hasText(shelf[UI], "Five books for you")
  );
  const seed_reader = action(() => {
    shelf.finishedBooks.push(book);
    shelf.favoriteAuthors.push("Ursula K. Le Guin");
  });
  const assert_reader_cells = assert(() =>
    shelf.finishedBooks.get().length === 1 &&
    shelf.finishedBooks.get()[0].equals(book) &&
    shelf.favoriteAuthors.get()[0] === "Ursula K. Le Guin"
  );
  const assert_five_link_schema = assert(() =>
    RECOMMENDATION_SCHEMA.properties.picks.minItems === 5 &&
    RECOMMENDATION_SCHEMA.properties.picks.maxItems === 5 &&
    RECOMMENDATION_SCHEMA.properties.picks.items.properties.book.asCell[0] ===
      "readonly" &&
    RECOMMENDATION_SCHEMA.properties.sources.items.asCell[0] === "readonly"
  );
  const state = new Writable<RecommendationState>({ pending: true });
  const view = RecommendationView({ state });
  const assert_pending = assert(() =>
    hasText(view[UI], "Finding five books") &&
    hasText(view[UI], "Usage unavailable")
  );
  const complete = action(() =>
    state.set({
      pending: false,
      result: {
        sources: [book],
        picks: [
          { book, why: "An imaginative society." },
          { book: secondBook, why: "A different perspective." },
          { book: thirdBook, why: "Thoughtful worldbuilding." },
          { book: fourthBook, why: "A compelling journey." },
          { book: fifthBook, why: "A favorite author." },
        ],
      },
      run: {
        usage: { totalTokens: 42, costUsd: 0.01, estimatedCostUsd: 0.02 },
      },
    })
  );
  const assert_completed = assert(() =>
    hasText(view[UI], "The Dispossessed") &&
    hasText(view[UI], "Ursula K. Le Guin") &&
    hasText(view[UI], "An imaginative society.") &&
    hasText(view[UI], "Parable of the Sower") &&
    hasText(view[UI], "Octavia E. Butler") &&
    hasText(view[UI], "A different perspective.") &&
    hasText(view[UI], "The Fifth Season") &&
    hasText(view[UI], "N. K. Jemisin") &&
    hasText(view[UI], "Thoughtful worldbuilding.") &&
    hasText(view[UI], "A Psalm for the Wild-Built") &&
    hasText(view[UI], "Becky Chambers") &&
    hasText(view[UI], "A compelling journey.") &&
    hasText(view[UI], "Babel") &&
    hasText(view[UI], "R. F. Kuang") &&
    hasText(view[UI], "A favorite author.") &&
    hasText(view[UI], "42 tokens") &&
    hasText(view[UI], "Reported cost: $0.010000") &&
    hasText(view[UI], "Estimated cost: $0.020000") &&
    !hasText(view[UI], "Finding five books")
  );
  const assert_result_links = assert(() =>
    view.state.result?.picks.length === 5 &&
    view.state.result?.picks[0].book.equals(book) === true &&
    view.state.result?.picks[1].book.equals(secondBook) === true &&
    view.state.result?.picks[2].book.equals(thirdBook) === true &&
    view.state.result?.picks[3].book.equals(fourthBook) === true &&
    view.state.result?.picks[4].book.equals(fifthBook) === true &&
    view.state.result?.sources?.[0].equals(book) === true
  );
  const report_zero = action(() =>
    state.key("run").set({
      usage: {
        totalTokens: 0,
        costUsd: 0,
        estimateWithheldReason: "rate_missing",
      },
    })
  );
  const assert_zero = assert(() =>
    hasText(view[UI], "0 tokens") &&
    hasText(view[UI], "Reported cost: $0.000000") &&
    hasText(view[UI], "Estimate withheld: rate_missing") &&
    !hasText(view[UI], "Estimated cost:")
  );
  const empty_usage = action(() => state.key("run").set({ usage: {} }));
  const assert_empty_usage = assert(() =>
    hasText(view[UI], "Usage unavailable")
  );
  const rename = action(() =>
    book.key("title").set("The Left Hand of Darkness")
  );
  const assert_live_book = assert(() =>
    hasText(view[UI], "The Left Hand of Darkness") &&
    !hasText(view[UI], "The Dispossessed")
  );
  const fail = action(() =>
    state.set({ pending: false, error: "RUNNER_LOST" })
  );
  const assert_failed = assert(() =>
    hasText(view[UI], "RUNNER_LOST") &&
    !hasText(view[UI], "The Left Hand of Darkness")
  );
  return {
    [TESTS]: [
      { assertion: assert_top_level_view },
      { action: seed_reader },
      { assertion: assert_reader_cells },
      { assertion: assert_five_link_schema },
      { assertion: assert_pending },
      { action: complete },
      { assertion: assert_completed },
      { assertion: assert_result_links },
      { action: report_zero },
      { assertion: assert_zero },
      { action: empty_usage },
      { assertion: assert_empty_usage },
      { action: rename },
      { assertion: assert_live_book },
      { action: fail },
      { assertion: assert_failed },
    ],
  };
});
