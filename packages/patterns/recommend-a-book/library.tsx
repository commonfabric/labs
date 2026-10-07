/** A personal reading shelf that publishes a reviewed invitation. */

import {
  type BuiltInAgentState,
  type Cell,
  computed,
  handler,
  hasError,
  isPending,
  isSyncing,
  NAME,
  navigateTo,
  pattern,
  type PerUser,
  resultOf,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { type Book, type LibrarySeed, SeedLibrary } from "./agents.tsx";
import type { InvitationOutput as PreviousInvitationOutput } from "./main.tsx";
import Invitation, {
  type LibrarySlot,
  type SharedInvitationOutput,
} from "./shared-invitation.tsx";
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
  invitations: PerUser<Writable<PreviousInvitationOutput[]>>;
  invitation: SharedInvitationOutput;
  publishedLibrary: Writable<LibrarySlot>;
  invitationReady: PerUser<Writable<boolean>>;
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

/** Makes the shelf's invitation available after its profile resolves. */
const createInvitation = handler<void, {
  profile: Profile | undefined;
  ready: Writable<boolean>;
}>((_, { profile, ready }) => {
  if (profile === undefined) return;
  ready.set(true);
});

/** Opens an invitation that the reader can share through the space controls. */
const openInvitation = handler<void, { invitation: SharedInvitationOutput }>(
  (_, { invitation }) => navigateTo(invitation),
);

export default pattern<Record<string, never>, LibraryOutput>(() => {
  const profile = wish<Cell<Profile>>({ query: "#profile" });
  const resolvedProfile = resultOf(profile.result);
  const optionalProfile = computed(() =>
    hasError(profile.result) ? undefined : resolvedProfile
  );
  const invitationProfile = computed(() =>
    hasError(profile.result) ? undefined : resolvedProfile.get()
  );
  const seed = SeedLibrary.asScope("user")({});
  const addedBooks = new Writable.perUser<ReaderPrivate<Book[]>>([]);
  const addedAuthors = new Writable.perUser<ReaderPrivate<string[]>>([]);
  const invitations = new Writable.perUser<PreviousInvitationOutput[]>([]);
  const invitationReady = new Writable.perUser(false);
  const publishedLibrary = new Writable.perSpace<LibrarySlot>({});
  const reading = computed((): LibrarySeed => ({
    books: [...(seed.state.result?.books ?? []), ...addedBooks.get()],
    favoriteAuthors: [
      ...new Set([
        ...(seed.state.result?.favoriteAuthors ?? []),
        ...addedAuthors.get(),
      ]),
    ],
  }));
  const invitation = Invitation({
    originatorProfile: resolvedProfile,
    library: publishedLibrary,
  });
  const create = createInvitation({
    profile: invitationProfile,
    ready: invitationReady,
  });
  const appendBook = addBook({ books: addedBooks });
  const appendAuthor = addAuthor({ authors: addedAuthors });
  const view = LibraryView({
    profile: optionalProfile,
    books: reading.books,
    favoriteAuthors: reading.favoriteAuthors,
    agentStatus: computed(() =>
      seed.state.pending ? "Finding books and authors you may enjoy…" : ""
    ),
    agentError: computed(() => seed.state.error ?? ""),
    addBook: appendBook,
    addAuthor: appendAuthor,
    createInvitation: create,
    canCreateInvitation: computed(() => {
      if (
        isPending(profile.result) || isSyncing(profile.result) ||
        hasError(profile.result)
      ) return false;
      return resultOf(profile.result).get() !== undefined;
    }),
  });
  return {
    [NAME]: "My reading shelf",
    [UI]: (
      <cf-vstack>
        {profile[UI]}
        {view}
        {invitationReady.get()
          ? (
            <cf-vstack>
              <cf-share-snapshot
                $source={reading}
                $recipient={invitation}
                audienceKind="space"
                $result={publishedLibrary.key("value")}
              />
              <cf-button onClick={openInvitation({ invitation })}>
                Open recommendation invitation
              </cf-button>
            </cf-vstack>
          )
          : null}
      </cf-vstack>
    ),
    reading,
    seeding: seed.state,
    addedBooks,
    addedAuthors,
    invitations,
    invitation,
    publishedLibrary,
    invitationReady,
    createInvitation: create,
    addBook: appendBook,
    addAuthor: appendAuthor,
  };
});
