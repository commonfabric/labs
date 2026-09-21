/** Reading shelf and recommendation invitation displays with session-local drafts. */

import {
  action,
  computed,
  type Default,
  handler,
  pattern,
  type ReadonlyCell,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** A title and author selected for a reader. */
export interface Book {
  title: string;
  author: string;
}

/** The display reads a person's identity through their live profile cell. */
export interface Profile {
  name?: string;
}

/** A submitted book with an optional live participant profile. */
export interface Recommendation extends Book {
  recommender?: ReadonlyCell<Profile>;
}

/** The library supplies authorized data and durable actions to its display. */
export interface LibraryViewInput {
  profile: ReadonlyCell<Profile>;
  books: Book[];
  favoriteAuthors: string[];
  agentStatus: string;
  agentError: string;
  addBook: Stream<Book>;
  addAuthor: Stream<{ name: string }>;
  createInvitation: Stream<void>;
  canCreateInvitation?: boolean | Default<true>;
}

/** The invitation supplies only the data this viewer may read. */
export interface InvitationViewInput {
  originator: ReadonlyCell<Profile>;
  isOwner: boolean;
  originatorBooks: Book[];
  favoriteAuthors: string[];
  candidates: Book[];
  agentStatus: string;
  agentError: string;
  receivedRecommendations: Recommendation[];
  myRecommendations: Recommendation[];
  recommend: Stream<{ books: Book[] }>;
}

/** Presentational patterns expose their rendered surface. */
export interface ViewOutput {
  [UI]: VNode;
}

const readingTheme = {
  fontFamily: "'Georgia', 'Times New Roman', serif",
  borderRadius: "12px",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#345548",
    primaryForeground: "#fffdf7",
    background: "#faf7ef",
    surface: "#fffdf7",
    text: "#292e27",
    textMuted: "#676d61",
    border: "#d9d8c8",
    accent: "#a25c32",
    accentForeground: "#fffdf7",
  },
};

const toggleCandidate = handler<
  void,
  { book: Book; selected: Writable<Book[]> }
>(
  (_, { book, selected }) => {
    const current = selected.get();
    const matches = (item: Book) =>
      item.title === book.title && item.author === book.author;
    selected.set(
      current.some(matches)
        ? current.filter((item) => !matches(item))
        : [...current, { title: book.title, author: book.author }],
    );
  },
);

/** Shows a reader's books and lets them invite recommendations. */
export const LibraryView = pattern<LibraryViewInput, ViewOutput>(
  (
    {
      profile,
      books,
      favoriteAuthors,
      agentStatus,
      agentError,
      addBook,
      addAuthor,
      createInvitation,
      canCreateInvitation,
    },
  ) => {
    const title = new Writable.perSession("");
    const author = new Writable.perSession("");
    const favoriteAuthor = new Writable.perSession("");
    const submitBook = action(() => {
      const bookTitle = title.get().trim();
      if (!bookTitle) return;
      addBook.send({ title: bookTitle, author: author.get().trim() });
      title.set("");
      author.set("");
    });
    const submitAuthor = action(() => {
      const name = favoriteAuthor.get().trim();
      if (!name) return;
      addAuthor.send({ name });
      favoriteAuthor.set("");
    });
    return {
      [UI]: (
        <cf-theme theme={readingTheme}>
          <cf-screen>
            <cf-vstack slot="header" gap="2" padding="4">
              <cf-profile-badge $profile={profile} size="sm" />
              <cf-heading level={1}>Your reading shelf</cf-heading>
              <p>
                A little of what you have read. A starting point for what comes
                next.
              </p>
            </cf-vstack>
            <cf-vstack gap="5" padding="4">
              {agentStatus ? <p role="status">{agentStatus}</p> : null}
              {agentError ? <p role="alert">{agentError}</p> : null}
              <cf-card>
                <cf-vstack gap="3">
                  <cf-heading level={2}>Books you have read</cf-heading>
                  <p>
                    Personalized suggestions are a starting point. Add the books
                    you want people to know about.
                  </p>
                  {books.length === 0
                    ? <p>Your shelf is waiting for its first book.</p>
                    : null}
                  {books.map((book) => (
                    <cf-vstack gap="1">
                      <strong>{book.title}</strong>
                      <span>{book.author}</span>
                    </cf-vstack>
                  ))}
                  <cf-input
                    id="library-title"
                    aria-label="Book title"
                    placeholder="Book title"
                    $value={title}
                  />
                  <cf-input
                    id="library-author"
                    aria-label="Book author"
                    placeholder="Author"
                    $value={author}
                  />
                  <cf-button
                    onClick={submitBook}
                    disabled={computed(() => title.get().trim() === "")}
                  >
                    Add book
                  </cf-button>
                </cf-vstack>
              </cf-card>
              <cf-card>
                <cf-vstack gap="3">
                  <cf-heading level={2}>Favorite authors</cf-heading>
                  <cf-hstack gap="2" wrap>
                    {favoriteAuthors.map((name) => <cf-chip>{name}</cf-chip>)}
                  </cf-hstack>
                  <cf-input
                    id="favorite-author"
                    aria-label="Favorite author"
                    placeholder="An author you enjoy"
                    $value={favoriteAuthor}
                  />
                  <cf-button
                    onClick={submitAuthor}
                    disabled={computed(() =>
                      favoriteAuthor.get().trim() === ""
                    )}
                  >
                    Add author
                  </cf-button>
                </cf-vstack>
              </cf-card>
              <cf-card>
                <cf-vstack gap="3">
                  <cf-heading level={2}>What should you read next?</cf-heading>
                  <p>
                    Create an invitation in a new space, then share that space
                    with people whose taste you trust.
                  </p>
                  <cf-button
                    onClick={createInvitation}
                    disabled={!canCreateInvitation}
                  >
                    Ask for recommendations
                  </cf-button>
                </cf-vstack>
              </cf-card>
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
    };
  },
);

/** Shows the invitation's owner or visitor surface from authorized inputs. */
export const InvitationView = pattern<InvitationViewInput, ViewOutput>(
  (
    {
      originator,
      isOwner,
      originatorBooks,
      favoriteAuthors,
      candidates,
      agentStatus,
      agentError,
      receivedRecommendations,
      myRecommendations,
      recommend,
    },
  ) => {
    const expanded = new Writable.perSession(false);
    const selected = new Writable.perSession<Book[]>([]);
    const title = new Writable.perSession("");
    const author = new Writable.perSession("");
    const toggleBooks = action(() => expanded.set(!expanded.get()));
    const submitSelected = action(() => {
      const books = selected.get().map((book) => ({
        title: book.title,
        author: book.author,
      }));
      if (books.length === 0) return;
      recommend.send({ books });
      selected.set([]);
    });
    const submitManual = action(() => {
      const bookTitle = title.get().trim();
      if (!bookTitle) return;
      recommend.send({
        books: [{ title: bookTitle, author: author.get().trim() }],
      });
      title.set("");
      author.set("");
    });
    return {
      [UI]: (
        <cf-theme theme={readingTheme}>
          <cf-screen>
            <cf-vstack slot="header" gap="2" padding="4">
              <cf-heading level={1}>
                {isOwner ? "Your next chapter" : "Recommend me a book"}
              </cf-heading>
              <cf-profile-badge $profile={originator} size="sm" />
            </cf-vstack>
            {isOwner
              ? (
                <cf-vstack gap="4" padding="4">
                  <p>
                    Recommendations sent to you. Each is visible only to you and
                    the person who sent it.
                  </p>
                  <cf-heading level={2}>Your recommendations</cf-heading>
                  {receivedRecommendations.length === 0
                    ? (
                      <p>
                        No recommendations yet. Share this space to invite a
                        few.
                      </p>
                    )
                    : null}
                  {receivedRecommendations.map((book) => (
                    <cf-card>
                      <cf-vstack gap="2">
                        <strong>{book.title}</strong>
                        <span>{book.author}</span>
                        {book.recommender
                          ? (
                            <cf-profile-badge
                              $profile={book.recommender}
                              size="sm"
                            />
                          )
                          : null}
                      </cf-vstack>
                    </cf-card>
                  ))}
                </cf-vstack>
              )
              : (
                <cf-vstack gap="5" padding="4">
                  <cf-card>
                    <cf-vstack gap="3">
                      <cf-heading level={2}>A sense of their taste</cf-heading>
                      <cf-hstack gap="2" wrap>
                        {favoriteAuthors.slice(0, 3).map((name) => (
                          <cf-chip>{name}</cf-chip>
                        ))}
                      </cf-hstack>
                      <cf-button onClick={toggleBooks} aria-expanded={expanded}>
                        {expanded ? "Hide books" : "Show all books"}
                      </cf-button>
                      {expanded
                        ? (
                          <cf-vstack gap="2">
                            {originatorBooks.map((book) => (
                              <div>
                                <strong>{book.title}</strong>
                                <span>— {book.author}</span>
                              </div>
                            ))}
                          </cf-vstack>
                        )
                        : null}
                    </cf-vstack>
                  </cf-card>
                  <cf-card>
                    <cf-vstack gap="3">
                      <cf-heading level={2}>From your reading life</cf-heading>
                      <p>
                        Only you can see these suggestions. Choose books you
                        would recommend.
                      </p>
                      {agentStatus ? <p role="status">{agentStatus}</p> : null}
                      {agentError ? <p role="alert">{agentError}</p> : null}
                      {candidates.length === 0
                        ? (
                          <p>
                            You can recommend a book below while suggestions are
                            being prepared.
                          </p>
                        )
                        : null}
                      {candidates.map((book) => (
                        <cf-hstack gap="3" align="center">
                          <cf-vstack gap="1" style={{ flex: "1" }}>
                            <strong>{book.title}</strong>
                            <span>{book.author}</span>
                          </cf-vstack>
                          <cf-button
                            aria-pressed={computed(() =>
                              selected.get().some((item) =>
                                item.title === book.title &&
                                item.author === book.author
                              )
                            )}
                            onClick={toggleCandidate({ book, selected })}
                          >
                            {computed(() =>
                              selected.get().some((item) =>
                                  item.title === book.title &&
                                  item.author === book.author
                                )
                                ? "Selected"
                                : "Select"
                            )}
                          </cf-button>
                        </cf-hstack>
                      ))}
                      <p>
                        Review your selection, then share it with the reader who
                        invited you. Only you and that reader can see the
                        recommendations you share.
                      </p>
                      <cf-button
                        id="recommend-selected"
                        onClick={submitSelected}
                        disabled={computed(() => selected.get().length === 0)}
                      >
                        Review selected recommendations
                      </cf-button>
                    </cf-vstack>
                  </cf-card>
                  <cf-card>
                    <cf-vstack gap="3">
                      <cf-heading level={2}>
                        Have another book in mind?
                      </cf-heading>
                      <cf-input
                        id="recommend-title"
                        aria-label="Book title"
                        placeholder="Book title"
                        $value={title}
                      />
                      <cf-input
                        id="recommend-author"
                        aria-label="Book author"
                        placeholder="Author"
                        $value={author}
                      />
                      <cf-button
                        onClick={submitManual}
                        disabled={computed(() => title.get().trim() === "")}
                      >
                        Review recommendation
                      </cf-button>
                    </cf-vstack>
                  </cf-card>
                  <cf-vstack gap="3">
                    <cf-heading level={2}>
                      Books you have recommended
                    </cf-heading>
                    {myRecommendations.length === 0
                      ? <p>You have not sent a recommendation yet.</p>
                      : null}
                    {myRecommendations.map((book) => (
                      <div>
                        <strong>{book.title}</strong>
                        <span>— {book.author}</span>
                      </div>
                    ))}
                  </cf-vstack>
                </cf-vstack>
              )}
          </cf-screen>
        </cf-theme>
      ),
    };
  },
);
