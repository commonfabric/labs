import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElementByExactText,
  findNodeById,
  hasText,
  propsOf,
  propValue,
} from "../test/vnode-helpers.ts";
import { type Book, InvitationView, LibraryView } from "./views.tsx";

/** Writes through the same cell binding used by the rendered input. */
function fillInput(ui: unknown, id: string, value: string): void {
  const binding = propsOf(findNodeById(ui, id))?.["$value"];
  if (!binding || typeof binding !== "object" || !("set" in binding)) {
    throw new Error(`Missing input binding: ${id}`);
  }
  (binding as { set(value: string): void }).set(value);
}

const captureRecommendations = handler<
  { books: Book[] },
  { sent: Writable<Book[]> }
>(({ books }, { sent }) => sent.push(...books));
const captureBook = handler<Book, { libraryBooks: Writable<Book[]> }>((
  book,
  { libraryBooks },
) => libraryBooks.push(book));
const captureAuthor = handler<
  { name: string },
  { authors: Writable<string[]> }
>(({ name }, { authors }) => authors.push(name));

export default pattern(() => {
  const profile = new Writable({ name: "Reader" });
  const sent = new Writable<Book[]>([]);
  const libraryBooks = new Writable<Book[]>([{
    title: "Origin book",
    author: "A",
  }]);
  const authors = new Writable<string[]>([
    "A",
    "B",
    "C",
    "Hidden fourth author",
  ]);
  const candidates = new Writable<Book[]>([
    { title: "Solaris", author: "Stanisław Lem" },
    { title: "Kindred", author: "Octavia Butler" },
  ]);
  const agentError = new Writable("");
  const invitations = new Writable(0);
  const recommend = captureRecommendations({ sent });
  const addBook = captureBook({ libraryBooks });
  const addAuthor = captureAuthor({ authors });
  const createInvitation = action(() => invitations.set(invitations.get() + 1));
  const library = LibraryView({
    profile,
    books: libraryBooks,
    favoriteAuthors: authors,
    agentStatus: "Finding your books…",
    agentError: "",
    addBook,
    addAuthor,
    createInvitation,
  });
  const canCreateInvitation = new Writable(false);
  const waitingForProfile = LibraryView({
    profile,
    books: [],
    favoriteAuthors: [],
    agentStatus: "",
    agentError: "",
    addBook,
    addAuthor,
    createInvitation,
    canCreateInvitation,
  });
  const action_profile_ready = action(() => canCreateInvitation.set(true));
  const visitor = InvitationView({
    originator: profile,
    isOwner: false,
    originatorBooks: libraryBooks,
    favoriteAuthors: authors,
    candidates,
    agentStatus: "Finding suggestions…",
    agentError,
    receivedRecommendations: [],
    myRecommendations: [],
    recommend,
  });
  const pending = InvitationView({
    originator: profile,
    isOwner: null,
    originatorBooks: libraryBooks,
    favoriteAuthors: authors,
    candidates,
    agentStatus: "",
    agentError: "",
    receivedRecommendations: [],
    myRecommendations: [],
    recommend,
  });
  const owner = InvitationView({
    originator: profile,
    isOwner: true,
    originatorBooks: [],
    favoriteAuthors: [],
    candidates: [],
    agentStatus: "",
    agentError: "",
    receivedRecommendations: [{
      title: "Received book",
      author: "Writer",
      recommender: profile,
    }],
    myRecommendations: [],
    recommend,
  });
  const action_expand = action(() =>
    clickButton(visitor[UI], "Show all books")
  );
  const action_choose = action(() =>
    clickInRow(visitor[UI], "Solaris", "Select")
  );
  const action_deselect = action(() =>
    clickInRow(visitor[UI], "Solaris", "Selected")
  );
  const action_reorder = action(() =>
    candidates.set([...candidates.get()].reverse())
  );
  const action_collapse = action(() => clickButton(visitor[UI], "Hide books"));
  const action_error = action(() =>
    agentError.set(
      "Suggestions are unavailable. You can still recommend a book.",
    )
  );
  const action_empty_library = action(() => {
    clickButton(library[UI], "Add book");
    clickButton(library[UI], "Add author");
  });
  const action_submit = action(() =>
    clickButton(visitor[UI], "Review selected recommendations")
  );
  const action_manual = action(() => {
    fillInput(visitor[UI], "recommend-title", "  A Wizard of Earthsea  ");
    fillInput(visitor[UI], "recommend-author", " Ursula K. Le Guin ");
  });
  const action_submit_manual = action(() =>
    clickButton(visitor[UI], "Review recommendation")
  );
  const action_blank = action(() =>
    clickButton(visitor[UI], "Review recommendation")
  );
  const action_library_draft = action(() => {
    fillInput(library[UI], "library-title", "Dune");
    fillInput(library[UI], "library-author", "Frank Herbert");
    fillInput(library[UI], "favorite-author", "Terry Pratchett");
  });
  const action_add_library = action(() => {
    clickButton(library[UI], "Add book");
    clickButton(library[UI], "Add author");
    clickButton(library[UI], "Ask for recommendations");
  });
  return {
    [TESTS]: [
      { assertion: assert(() => hasText(library[UI], "Your reading shelf")) },
      {
        assertion: assert(() =>
          propValue(
            findElementByExactText(
              waitingForProfile[UI],
              "cf-button",
              "Ask for recommendations",
            ),
            "disabled",
          ) === true
        ),
      },
      { action: action_profile_ready },
      {
        assertion: assert(() =>
          propValue(
            findElementByExactText(
              waitingForProfile[UI],
              "cf-button",
              "Ask for recommendations",
            ),
            "disabled",
          ) === false
        ),
      },
      { assertion: assert(() => !hasText(visitor[UI], "Origin book")) },
      {
        assertion: assert(() =>
          propValue(
            findElementByExactText(visitor[UI], "cf-button", "Show all books"),
            "aria-expanded",
          ) === false
        ),
      },
      {
        assertion: assert(() =>
          hasText(pending[UI], "Checking invitation") &&
          !hasText(pending[UI], "Review recommendation") &&
          !hasText(pending[UI], "Origin book")
        ),
      },
      {
        assertion: assert(() => !hasText(visitor[UI], "Hidden fourth author")),
      },
      {
        assertion: assert(() =>
          hasText(visitor[UI], "Only you can see these suggestions")
        ),
      },
      { assertion: assert(() => hasText(owner[UI], "Received book")) },
      {
        assertion: assert(() =>
          !hasText(owner[UI], "Review selected recommendations")
        ),
      },
      {
        assertion: assert(() =>
          propValue(
            findNodeById(visitor[UI], "recommend-selected"),
            "disabled",
          ) === true
        ),
      },
      { action: action_expand },
      { assertion: assert(() => hasText(visitor[UI], "Origin book")) },
      {
        assertion: assert(() =>
          propValue(
            findElementByExactText(visitor[UI], "cf-button", "Hide books"),
            "aria-expanded",
          ) === true
        ),
      },
      { action: action_choose },
      {
        assertion: assert(() =>
          propValue(
            findNodeById(visitor[UI], "recommend-selected"),
            "disabled",
          ) === false
        ),
      },
      { action: action_deselect },
      {
        assertion: assert(() =>
          propValue(
            findNodeById(visitor[UI], "recommend-selected"),
            "disabled",
          ) === true
        ),
      },
      { action: action_choose },
      { action: action_reorder },
      { action: action_submit },
      {
        assertion: assert(() =>
          sent.get().length === 1 && sent.get()[0].title === "Solaris"
        ),
      },
      {
        assertion: assert(() =>
          propValue(
            findNodeById(visitor[UI], "recommend-selected"),
            "disabled",
          ) === true
        ),
      },
      { action: action_manual },
      { action: action_submit_manual },
      {
        assertion: assert(() =>
          sent.get().length === 2 &&
          sent.get()[1].title === "A Wizard of Earthsea" &&
          sent.get()[1].author === "Ursula K. Le Guin"
        ),
      },
      { action: action_blank },
      { assertion: assert(() => sent.get().length === 2) },
      { action: action_library_draft },
      { action: action_add_library },
      {
        assertion: assert(() =>
          libraryBooks.get().length === 2 &&
          libraryBooks.get()[1].title === "Dune"
        ),
      },
      { assertion: assert(() => authors.get()[4] === "Terry Pratchett") },
      { assertion: assert(() => invitations.get() === 1) },
      {
        assertion: assert(() =>
          propValue(findNodeById(library[UI], "library-title"), "$value") === ""
        ),
      },
      { action: action_empty_library },
      {
        assertion: assert(() =>
          libraryBooks.get().length === 2 && authors.get().length === 5
        ),
      },
      { action: action_collapse },
      { assertion: assert(() => !hasText(visitor[UI], "Origin book")) },
      { action: action_error },
      {
        assertion: assert(() =>
          hasText(visitor[UI], "Suggestions are unavailable")
        ),
      },
      { assertion: assert(() => hasText(library[UI], "Finding your books…")) },
      {
        assertion: assert(() =>
          propValue(findNodeById(visitor[UI], "recommend-title"), "$value") ===
            ""
        ),
      },
    ],
    library,
    visitor,
    owner,
  };
});
