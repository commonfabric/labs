/** Recommends five books from live book cells and the reader's favorite authors. */
import {
  agent,
  type BuiltInAgentState,
  computed,
  type Default,
  NAME,
  pattern,
  type PerUser,
  type ReadonlyCell,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import RecommendationView, {
  type Book,
  type Recommendations,
} from "./view.tsx";

/** Reading history and preferences belong to the active reader. */
export interface BookRecommendationsInput {
  finishedBooks?: PerUser<Writable<ReadonlyCell<Book>[] | Default<[]>>>;
  favoriteAuthors?: PerUser<Writable<string[] | Default<[]>>>;
}

/** Reader-owned cells and the agent's linked result remain live outputs. */
export interface BookRecommendationsOutput {
  [NAME]: string;
  [UI]: VNode;
  finishedBooks: PerUser<Writable<ReadonlyCell<Book>[]>>;
  favoriteAuthors: PerUser<Writable<string[]>>;
  recommendation: BuiltInAgentState<Recommendations>;
}

/**
 * Each pick is a book the reader has not finished, inline; `basedOn` links the
 * finished book it builds on, where one does.
 */
export const RECOMMENDATION_SCHEMA = {
  type: "object",
  properties: {
    sources: { type: "array", items: { asCell: ["readonly"] } },
    picks: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          author: { type: "string", minLength: 1 },
          why: { type: "string" },
          basedOn: {
            type: "object",
            asCell: ["readonly"],
            properties: {
              title: { type: "string" },
              author: { type: "string" },
            },
            required: ["title", "author"],
          },
        },
        required: ["title", "author", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
} as const;

export default pattern<BookRecommendationsInput, BookRecommendationsOutput>(
  ({ finishedBooks, favoriteAuthors }) => {
    const inputs = computed((): Record<
      string,
      ReadonlyCell<unknown> | Writable<unknown>
    > => ({
      finishedBooks,
      favoriteAuthors,
      ...Object.fromEntries(
        finishedBooks.get().map((book, index) => [`book_${index}`, book]),
      ),
    }));
    const recommendation = agent<Recommendations>({
      task:
        "Recommend exactly five books the reader has not finished, drawing on their finished books and favorite authors; a finished book is never a pick. Use Loom search and page reads for supporting context. Give each pick its title and author, explain why it fits the reader, and where it builds on a finished book, link that held book handle under basedOn. Return the five picks with submit_result.",
      inputs,
      tools: ["loom_search", "loom_page_read"],
      resultSchema: RECOMMENDATION_SCHEMA,
    });
    const view = RecommendationView({ state: recommendation });
    return {
      [NAME]: "Book recommendations",
      [UI]: view[UI],
      finishedBooks,
      favoriteAuthors,
      recommendation,
    };
  },
);
