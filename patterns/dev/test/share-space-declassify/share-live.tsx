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

const ShareLive = pattern<ShareLiveInput, ShareLiveOutput>(
  ({ fixes, now }) => {
    const shared = new Writable<OwnerOrShareReaders<Fix[]>>(
      [] as OwnerOrShareReaders<Fix[]>,
    ).for("shared");
    const window = sharedWindow({ fixes, now });
    return {
      [NAME]: "Shared location, last five minutes, live",
      space: computed(() => spaceOf(shared)),
      window,
      shared,
      publish: publishWindow({ window, shared }),
    };
  },
);

export default ShareLive;
