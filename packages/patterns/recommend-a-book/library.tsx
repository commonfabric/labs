/** A personal reading shelf that publishes a reviewed invitation in a new space. */

import {
  type BuiltInAgentState,
  type Cell,
  computed,
  handler,
  type JSXElement,
  NAME,
  navigateTo,
  pattern,
  type PerUser,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { type Book, type LibrarySeed, SeedLibrary } from "./agents.tsx";
import Invitation, { type InvitationOutput } from "./main.tsx";
import { type ReaderPrivate } from "./privacy.tsx";
import { LibraryView, type Profile } from "./views.tsx";

/** The shelf combines agent suggestions with the reader's own additions. */
export interface LibraryOutput {
  [NAME]: string;
  [UI]: VNode;
  reading: PerUser<LibrarySeed>;
  seeding: PerUser<BuiltInAgentState<LibrarySeed>>;
  addedBooks: PerUser<Writable<Book[]>>;
  addedAuthors: PerUser<Writable<string[]>>;
  invitations: PerUser<Writable<InvitationOutput[]>>;
  createInvitation: Stream<void>;
  addBook: Stream<Book>;
  addAuthor: Stream<{ name: string }>;
}

/** Adds a title and author supplied by the reader. */
const addBook = handler<Book, { books: Writable<Book[]> }>(
  ({ title, author }, { books }) => {
    if (title.trim() === "") return;
    books.push({ title: title.trim(), author: author.trim() });
  },
);

/** Adds an author supplied by the reader. */
const addAuthor = handler<{ name: string }, { authors: Writable<string[]> }>(
  ({ name }, { authors }) => {
    if (name.trim() !== "") authors.push(name.trim());
  },
);

/** Creates an invitation with a fresh anonymous space identity. */
const createInvitation = handler<void, {
  profile: Cell<Profile> | undefined;
  invitations: Writable<InvitationOutput[]>;
  active: PerUser<Writable<InvitationOutput | undefined>>;
}>((_, { profile, invitations, active }) => {
  if (profile === undefined || profile.get() === undefined) return;
  const invitation = Invitation.inSpace()({
    originatorProfile: profile.resolveAsCell(),
  });
  invitations.push(invitation);
  active.set(invitation);
});

/** Opens an invitation that the reader can share through the space controls. */
const openInvitation = handler<void, { invitation: InvitationOutput }>(
  (_, { invitation }) => navigateTo(invitation),
);

export default pattern<Record<string, never>, LibraryOutput>(() => {
  const profile = wish<Cell<Profile>>({ query: "#profile" });
  const seed = SeedLibrary.asScope("user")({});
  const addedBooks = new Writable.perUser<ReaderPrivate<Book[]>>([]);
  const addedAuthors = new Writable.perUser<ReaderPrivate<string[]>>([]);
  const invitations = new Writable.perUser<InvitationOutput[]>([]);
  const active = new Writable.perUser<InvitationOutput | undefined>(
    undefined,
  );
  const reading = computed((): LibrarySeed => ({
    books: [...(seed.state.result?.books ?? []), ...addedBooks.get()],
    favoriteAuthors: [
      ...new Set([
        ...(seed.state.result?.favoriteAuthors ?? []),
        ...addedAuthors.get(),
      ]),
    ],
  }));
  const create = createInvitation({
    profile: profile.result,
    invitations,
    active,
  });
  const appendBook = addBook({ books: addedBooks });
  const appendAuthor = addAuthor({ authors: addedAuthors });
  const view = LibraryView({
    profile: profile.result!,
    books: reading.books,
    favoriteAuthors: reading.favoriteAuthors,
    agentStatus: computed(() =>
      seed.state.pending ? "Finding books and authors you may enjoy…" : ""
    ),
    agentError: computed(() => seed.state.error ?? ""),
    addBook: appendBook,
    addAuthor: appendAuthor,
    createInvitation: create,
    canCreateInvitation: computed(() => profile.result?.get() !== undefined),
  });
  const sharing = computed((): PerUser<{ view: JSXElement | null }> => {
    if (active.get() === undefined) return { view: null };
    const invitation = active.resolveAsCell();
    const reviewed = invitation.key("reviewedLibrary").get();
    return {
      view: (
        <cf-share-snapshot
          $source={reading}
          $recipient={invitation}
          audience-kind="space"
          $result={reviewed.key("value")}
          oncf-shared={invitation.key("publishReviewed").get()}
        />
      ),
    };
  });
  return {
    [NAME]: "My reading shelf",
    [UI]: (
      <cf-vstack>
        {profile[UI]}
        {view}
        {sharing.view}
        {invitations.map((invitation) => (
          <cf-button onClick={openInvitation({ invitation })}>
            Open recommendation invitation
          </cf-button>
        ))}
      </cf-vstack>
    ),
    reading,
    seeding: seed.state,
    addedBooks,
    addedAuthors,
    invitations,
    createInvitation: create,
    addBook: appendBook,
    addAuthor: appendAuthor,
  };
});
