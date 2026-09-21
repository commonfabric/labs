/** A shared invitation with private visitor drafts and an originator-only inbox. */

import {
  type Cfc,
  computed,
  type CurrentPrincipal,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  type ReadonlyCell,
  type RepresentsCurrentUser,
  type Stream,
  UI,
  type VNode,
  Writable,
  type WriteAuthorizedBy,
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

/** Published library and creator profile carried into the invitation. */
export interface InvitationInput {
  originatorProfile: ReadonlyCell<Profile>;
}

/** A title and author snapshot chosen by the visitor for explicit sharing. */
export interface SelectedBooks {
  books: Book[];
}

/** Published library pointer; the creator alone may replace it. */
export interface LibrarySlot {
  value?: ReadonlyCell<LibrarySeed>;
}

/** Binds a host-approved library snapshot to this invitation. */
export const publishLibrary = handler<{ library: ReadonlyCell<LibrarySeed> }, {
  library: Writable<LibrarySlot>;
}>((event, { library }) => library.set({ value: event.library }));

/** Library pointer whose authenticated creator alone may publish a snapshot. */
export type PublishedLibrary = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<LibrarySlot, typeof publishLibrary>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

/** Private state is scoped independently from the shared invitation. */
export interface InvitationOutput {
  [NAME]: string;
  [UI]: PerUser<VNode>;
  originator: OriginatorIdentity;
  originatorProfile: ReadonlyCell<Profile>;
  library: PublishedLibrary;
  publish: Stream<{ library: ReadonlyCell<LibrarySeed> }>;
  reviewedLibrary: PerUser<Writable<LibrarySlot>>;
  publishReviewed: Stream<void>;
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

/** Publishes a reviewed shelf within the invitation's transaction space. */
const publishReviewedLibrary = handler<void, {
  reviewedLibrary: PerUser<Writable<LibrarySlot>>;
  publish: Stream<{ library: ReadonlyCell<LibrarySeed> }>;
}>((_, { reviewedLibrary, publish }) => {
  if (!reviewedLibrary.get()?.value) return;
  publish.send({ library: reviewedLibrary.get().value! });
  reviewedLibrary.set({});
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
    library: PerUser<Writable<LibrarySlot>>;
    received: PerUser<Writable<ReadonlyCell<Book>[]>>;
    recommended: PerUser<Writable<ReadonlyCell<Book>[]>>;
    selected: PerUser<Writable<SelectedBooks>>;
    review: PerUser<Stream<SelectedBooks>>;
    clearSelection: PerUser<Stream<void>>;
  },
  Pick<InvitationOutput, typeof UI>
>(
  (
    {
      originatorProfile,
      originator,
      library,
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
      value: library.get().value?.get(),
    }));
    const suggestions = computed(
      (): PerUser<{ value?: CandidateAgentOutput }> => {
        const published = library.get().value;
        if (!published || isOwner !== false) return {};
        return {
          value: SuggestBooks.asScope("user")({
            books: published.key("books"),
            favoriteAuthors: published.key("favoriteAuthors"),
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

export default pattern<InvitationInput, InvitationOutput>(
  ({ originatorProfile }) => {
    const originator = new Writable.perSpace<OriginatorIdentity>({});
    const library = new Writable.perSpace<PublishedLibrary>({});
    const received = new Writable.perSpace<ReaderPrivate<ReadonlyCell<Book>[]>>(
      [],
    );
    const reviewedLibrary = new Writable.perUser<
      LibrarySlot
    >({});
    const recommended = new Writable.perUser<
      ReaderPrivate<ReadonlyCell<Book>[]>
    >([]);
    const selected = new Writable.perUser<ReaderPrivate<SelectedBooks>>({
      books: [],
    });
    const publish = publishLibrary({ library });
    const review = reviewSelection({ selected });
    const clear = clearSelection({ selected });
    const publishReviewed = publishReviewedLibrary({
      reviewedLibrary,
      publish,
    });
    const reader = ReaderInvitation.asScope("user")({
      originatorProfile,
      originator,
      library,
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
      publish,
      reviewedLibrary,
      publishReviewed,
      received,
      recommended,
      selected,
      review,
      clearSelection: clear,
    };
  },
);
