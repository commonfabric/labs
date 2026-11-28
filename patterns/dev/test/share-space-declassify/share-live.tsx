// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The live share: the owner's own pattern, placed in a share space, computes
 * the last five minutes of the owner's fixes and reclassifies them under the
 * share space's policy (`share-policy.tsx`), so that the window is the
 * owner's or the share space's readers' to see. `publish` copies it into
 * `shared`, a store whose ceiling admits exactly that audience, so a window
 * that is still the owner's alone is refused there.
 */
import {
  type AnyOf,
  computed,
  type CurrentPrincipal,
  handler,
  lift,
  type MaxConfidentiality,
  NAME,
  pattern,
  type Reclassified,
  spaceOf,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { type Fix, fixesWithin, type RecentInput } from "./policy.tsx";
import { shareSpaceRules } from "./share-policy.tsx";

/** The owner, or a reader of the space the value is labeled in. */
export type OwnerOrShareReaders<T> = MaxConfidentiality<
  T,
  readonly [
    AnyOf<
      readonly [
        {
          type: "https://commonfabric.org/cfc/atom/User";
          subject: CurrentPrincipal;
        },
        PolicyOf<typeof shareSpaceRules>,
      ]
    >,
  ]
>;

export interface ShareLiveInput {
  /** The owner's fixes, a link into the owner's space. */
  fixes: Fix[];
  /** The instant the window ends at. */
  now: number;
}

export interface ShareLiveOutput {
  [NAME]: string;
  [UI]: VNode;
  /** The DID of the space the share was placed in. */
  space: string | undefined;
  /** The last five minutes, reclassified for the share space's readers. */
  window: Reclassified<Fix[], typeof shareSpaceRules>;
  /** The window as published to the share space. */
  shared: OwnerOrShareReaders<Fix[]>;
  /** Copies `window` into `shared`. */
  publish: Stream<void>;
}

/** The last five minutes, the owner's or the share space's readers'. */
const sharedWindow = lift((
  { fixes, now }: RecentInput,
): Reclassified<Fix[], typeof shareSpaceRules> =>
  fixesWithin(fixes ?? [], now ?? 0)
);

const publishWindow = handler<
  void,
  { window: Fix[]; shared: Writable<OwnerOrShareReaders<Fix[]>> }
>((_, { window, shared }) => {
  shared.set(window as OwnerOrShareReaders<Fix[]>);
});

/** The latitudes of `fixes`, comma-separated, or "none". */
const latitudes = (fixes: readonly Fix[] | undefined): string => {
  const lats = (fixes ?? []).map((fix) => fix?.lat);
  return lats.length === 0 ? "none" : lats.join(", ");
};

const ShareLive = pattern<ShareLiveInput, ShareLiveOutput>(
  ({ fixes, now }) => {
    const shared = new Writable<OwnerOrShareReaders<Fix[]>>(
      [] as OwnerOrShareReaders<Fix[]>,
    ).for("shared");
    const window = sharedWindow({ fixes, now });
    // Each line is its own derived document, so each carries the label of
    // what it reads: the window's, the published copy's, and the source's,
    // which stays the owner's alone. A reader's display decides each apart.
    const windowText = computed(() => latitudes(window));
    const sharedText = computed(() => latitudes(shared.get()));
    const sourceText = computed(() => latitudes(fixes));
    const publish = publishWindow({ window, shared });
    return {
      [NAME]: "Shared location, last five minutes, live",
      [UI]: (
        <div>
          <h2 id="share-heading">Shared location, last five minutes</h2>
          <p>
            Window: <span id="share-window">{windowText}</span>
          </p>
          <p>
            Published: <span id="share-shared">{sharedText}</span>
          </p>
          <p>
            Source: <span id="share-source">{sourceText}</span>
          </p>
          <cf-button id="share-publish-button" onClick={publish}>
            Publish
          </cf-button>
        </div>
      ),
      space: computed(() => spaceOf(shared)),
      window,
      shared,
      publish,
    };
  },
);

export default ShareLive;
