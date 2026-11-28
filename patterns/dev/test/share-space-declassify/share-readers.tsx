// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The labeled form of the share: it publishes the window into `readers`, a
 * store under the share space's own policy (`share-policy.tsx`), so the window
 * stays readable by the share space's readers alone rather than by anyone it
 * reaches.
 */
import {
  computed,
  handler,
  lift,
  NAME,
  pattern,
  spaceOf,
  Stream,
  Writable,
} from "commonfabric";
import { type Fix, fixesWithin, recentFixes } from "./policy.tsx";
import { type ShareSpaceReaders } from "./share-policy.tsx";

export interface ShareReadersInput {
  /** The owner's fixes, a link into the owner's space. */
  fixes: Fix[];
  /** The instant the window ends at. */
  now: number;
}

export interface ShareReadersOutput {
  [NAME]: string;
  /** The last five minutes, labeled for the share space's readers. */
  readers: ShareSpaceReaders<Fix[]>;
  /** The DID of the space the share was placed in. */
  space: string | undefined;
  /** Copies the window `recentFixes` computed into `readers`. */
  publish: Stream<void>;
  /** Copies the same window, computed by a function no rule names. */
  publishPlain: Stream<void>;
}

const publishToReaders = handler<
  void,
  { window: Fix[]; readers: Writable<ShareSpaceReaders<Fix[]>> }
>((_, { window, readers }) => {
  readers.set(window as ShareSpaceReaders<Fix[]>);
});

/** The same window as `recentFixes`, from a function no rule names. */
const plainRecentFixes = lift(
  ({ fixes, now }: { fixes: Fix[]; now: number }): Fix[] =>
    fixesWithin(fixes ?? [], now ?? 0),
);

const ShareReaders = pattern<ShareReadersInput, ShareReadersOutput>(
  ({ fixes, now }) => {
    const readers = new Writable<ShareSpaceReaders<Fix[]>>().for("readers");
    const marker = new Writable<string>("").for("marker");
    const blessed = recentFixes({ fixes, now });
    const plain = plainRecentFixes({ fixes, now });
    return {
      [NAME]: "Shared location for the share space's readers",
      readers,
      space: computed(() => spaceOf(marker)),
      publish: publishToReaders({ window: blessed, readers }),
      publishPlain: publishToReaders({ window: plain, readers }),
    };
  },
);

export default ShareReaders;
