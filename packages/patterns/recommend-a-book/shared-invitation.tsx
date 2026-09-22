/** A shared invitation with private visitor drafts and an originator-only inbox. */

import {
  computed,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  type ReadonlyCell,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type Book,
  type CandidateAgentOutput,
  type CandidateBooks,
  type LibrarySeed,
  prioritizeCandidateBooks,
  SuggestBooks,
} from "./agents.tsx";
import { type OriginatorIdentity, type ReaderPrivate } from "./privacy.tsx";
import { InvitationView, type Profile } from "./views.tsx";

/** The invitation reads a published shelf in its containing space. */
export interface InvitationInput {
  originatorProfile: ReadonlyCell<Profile>;
  library: ReadonlyCell<LibrarySlot>;
}

/** A title and author snapshot chosen by the visitor for explicit sharing. */
export interface SelectedBooks {
  books: Book[];
}

/** A shelf snapshot released for readers in the invitation's space. */
export interface LibrarySlot {
  value?: LibrarySeed;
}

/** Private state is scoped independently from the shared invitation. */
export interface SharedInvitationOutput {
  [NAME]: string;
  [UI]: PerUser<VNode>;
  originator: OriginatorIdentity;
  originatorProfile: ReadonlyCell<Profile>;
  library: ReadonlyCell<LibrarySlot>;
  received: PerSpace<Writable<ReadonlyCell<Book>[]>>;
  recommended: PerUser<Writable<ReadonlyCell<Book>[]>>;
  selected: PerUser<Writable<SelectedBooks>>;
  review: Stream<SelectedBooks>;
  clearSelection: Stream<void>;
}

/** Stages only the book fields the visitor has chosen to review. */
const reviewSelection = handler<SelectedBooks, {
  selected: PerUser<Writable<SelectedBooks>>;
}>(({ books }, { selected }) => {
  selected.set({
    books: books.map(({ title, author }) => ({
      title: title.trim(),
      author: author.trim(),
    })).filter((book) => book.title !== ""),
  });
});

/** Clears the visitor's draft after the host commits its reviewed copy. */
const clearSelection = handler<void, {
  selected: PerUser<Writable<SelectedBooks>>;
}>((_, { selected }) => {
  selected.set({ books: [] });
});

/** Per-reader computations and UI cannot share their derived private values. */
const ReaderInvitation = pattern<
  {
    originatorProfile: PerUser<ReadonlyCell<Profile>>;
    originator: PerUser<ReadonlyCell<Record<string, never>>>;
    libraryCell: PerUser<ReadonlyCell<LibrarySlot>>;
    received: PerUser<Writable<ReadonlyCell<Book>[]>>;
    recommended: PerUser<Writable<ReadonlyCell<Book>[]>>;
    selected: PerUser<Writable<SelectedBooks>>;
    review: PerUser<Stream<SelectedBooks>>;
    clearSelection: PerUser<Stream<void>>;
  },
  Pick<SharedInvitationOutput, typeof UI>
>(
  (
    {
      originatorProfile,
      originator,
      libraryCell,
      received,
      recommended,
      selected,
      review,
      clearSelection,
    },
  ) => {
    const ownerState = new Writable.perUser<boolean | null>(null);
    const isOwner: PerUser<boolean> | null = computed(
      (): PerUser<boolean> | null => ownerState.get(),
    );
    const reading = computed((): PerUser<{ value?: LibrarySeed }> => ({
      value: libraryCell.key("value").get(),
    }));
    const suggestions = computed(
      (): PerUser<{ value?: CandidateAgentOutput }> => {
        const published = libraryCell.key("value").get();
        if (!published || isOwner !== false) return {};
        return {
          value: SuggestBooks.asScope("user")({
            books: libraryCell.key("value", "books"),
            favoriteAuthors: libraryCell.key("value", "favoriteAuthors"),
          }),
        };
      },
    );
    const hasSelected: PerUser<boolean> = computed((): PerUser<boolean> =>
      (selected.get()?.books?.length ?? 0) > 0
    );
    const view = InvitationView.asScope("user")({
      originator: originatorProfile,
      isOwner,
      originatorBooks: computed((): PerUser<Book[]> =>
        reading.value?.books ?? []
      ),
      favoriteAuthors: computed((): PerUser<string[]> =>
        reading.value?.favoriteAuthors ?? []
      ),
      candidates: computed((): PerUser<CandidateBooks["books"]> =>
        prioritizeCandidateBooks(
          suggestions.value?.state.result?.books ?? [],
          reading.value,
        )
      ),
      agentStatus: computed((): PerUser<string> =>
        suggestions.value?.state.pending
          ? "Finding books you might recommend…"
          : ""
      ),
      agentError: computed((): PerUser<string> =>
        suggestions.value?.state.error ?? ""
      ),
      receivedRecommendations: computed((): PerUser<Book[]> => {
        if (isOwner !== true) return [];
        return received.get().map((book) => book.get());
      }),
      myRecommendations: computed((): PerUser<Book[]> =>
        (recommended.get() ?? []).map((book) => book.get())
      ),
      recommend: review,
    });
    return {
      [UI]: (
        <cf-vstack>
          <cf-owner-view $originator={originator} $result={ownerState} />
          {view}
          {hasSelected
            ? (
              <cf-share-snapshot
                $source={selected}
                $recipient={originator}
                audience-kind="user"
                $recommended={recommended}
                $received={received}
                oncf-shared={clearSelection}
              />
            )
            : null}
        </cf-vstack>
      ),
    };
  },
);

export default pattern<InvitationInput, SharedInvitationOutput>(
  ({ originatorProfile, library }) => {
    const originator = new Writable.perSpace<OriginatorIdentity>({});
    const received = new Writable.perSpace<ReaderPrivate<ReadonlyCell<Book>[]>>(
      [],
    );
    const recommended = new Writable.perUser<
      ReaderPrivate<ReadonlyCell<Book>[]>
    >([]);
    const selected = new Writable.perUser<ReaderPrivate<SelectedBooks>>({
      books: [],
    });
    const review = reviewSelection({ selected });
    const clear = clearSelection({ selected });
    const reader = ReaderInvitation.asScope("user")({
      originatorProfile,
      originator,
      libraryCell: library,
      received,
      recommended,
      selected,
      review,
      clearSelection: clear,
    });
    return {
      [NAME]: "Recommend me a book",
      [UI]: reader[UI],
      originator,
      originatorProfile,
      library,
      received,
      recommended,
      selected,
      review,
      clearSelection: clear,
    };
  },
);
