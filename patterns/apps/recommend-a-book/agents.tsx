/** Personalized library seeding and private suggestions for a visiting reader. */

import {
  agent,
  type BuiltInAgentState,
  pattern,
  type ReadonlyCell,
} from "commonfabric";

/** Book details that a reader may explicitly choose to share. */
export interface Book {
  title: string;
  author: string;
}

/** Inferred reading history and tastes, awaiting the reader's review. */
export interface LibrarySeed {
  books: Book[];
  favoriteAuthors: string[];
}

/** Private suggestions; the explanation is not part of a submitted book. */
export interface CandidateBooks {
  books: (Book & { reason: string })[];
}

/** Keeps candidate order within each preference group after shelf filtering. */
export function prioritizeCandidateBooks(
  candidates: CandidateBooks["books"],
  library: LibrarySeed | undefined,
): CandidateBooks["books"] {
  const normalized = (value: string) => value.trim().toLowerCase();
  const bookKey = (book: Book) =>
    `${normalized(book.title)}\u0000${normalized(book.author)}`;
  const seen = new Set((library?.books ?? []).map(bookKey));
  const favoriteAuthors = new Set(
    (library?.favoriteAuthors ?? []).map(normalized),
  );
  const preferred: CandidateBooks["books"] = [];
  const others: CandidateBooks["books"] = [];
  for (const candidate of candidates) {
    const key = bookKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    (favoriteAuthors.has(normalized(candidate.author)) ? preferred : others)
      .push(candidate);
  }
  return [...preferred, ...others];
}

/** Agent state belongs to the reader who requested the inference. */
export interface LibraryAgentOutput {
  state: BuiltInAgentState<LibrarySeed>;
}

/** Agent state belongs to the visitor considering a recommendation. */
export interface CandidateAgentOutput {
  state: BuiltInAgentState<CandidateBooks>;
}

/** Published tastes of the person asking for recommendations. */
export interface CandidateAgentInput {
  books: ReadonlyCell<Book[]>;
  favoriteAuthors: ReadonlyCell<string[]>;
}

/** Requests likely reading history from the authenticated reader's own context. */
export const SeedLibrary = pattern<Record<string, never>, LibraryAgentOutput>(
  () => ({
    state: agent<LibrarySeed>({
      task:
        "Help this reader prepare their reading shelf. Search their own Loom context for books they likely already read and authors they likely enjoy. Return a concise list of books (title and author) and favoriteAuthors. These are suggestions for the reader to review, not verified facts. Do not include excerpts, private reasons, messages, or unrelated personal details. Use submit_result.",
      inputs: {},
      tools: ["loom_search", "loom_page_read"],
      resultSchema: {
        type: "object",
        properties: {
          books: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", minLength: 1 },
                author: { type: "string", minLength: 1 },
              },
              required: ["title", "author"],
              additionalProperties: false,
            },
          },
          favoriteAuthors: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["books", "favoriteAuthors"],
        additionalProperties: false,
      },
    }),
  }),
);

/** Finds books the visitor likely read that suit the originator's tastes. */
export const SuggestBooks = pattern<CandidateAgentInput, CandidateAgentOutput>(
  ({ books, favoriteAuthors }) => ({
    state: agent<CandidateBooks>({
      task:
        "You are helping the visiting reader recommend a book to someone else. The linked books and favoriteAuthors describe the originator asking for recommendations, not the visitor. Search the authenticated visitor's own Loom context for books the visitor likely read and might recommend to the originator. Exclude books already on the originator's list. Return a few books with title, author, and a brief private reason. Do not send any recommendation: the visitor chooses what to share. Use submit_result.",
      inputs: { books, favoriteAuthors },
      tools: ["loom_search", "loom_page_read"],
      resultSchema: {
        type: "object",
        properties: {
          books: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", minLength: 1 },
                author: { type: "string", minLength: 1 },
                reason: { type: "string" },
              },
              required: ["title", "author", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["books"],
        additionalProperties: false,
      },
    }),
  }),
);
