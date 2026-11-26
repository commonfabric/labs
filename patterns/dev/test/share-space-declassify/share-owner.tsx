// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The owner's side of the two-browser share test
 * (`patterns/integration/share-space-reclassify-two-browsers.test.ts`). The
 * owner's fixes carry the connector's `User{owner}` label. "Share" places
 * `share-live.tsx` in a new space that grants `reader` READ, and "Record
 * fixes" fills the source afterwards: one commit that both writes a labeled
 * value and creates a store with a ceiling is refused (README, "Runtime
 * behavior found along the way").
 */
import {
  computed,
  type DID,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { type Fix, type OwnerOnly } from "./policy.tsx";
import ShareLive, { type ShareLiveOutput } from "./share-live.tsx";

/** The instant the window ends at, as in `main.test.tsx`. */
export const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;

/** Two fixes inside the window, one before it. */
export const FIXES: Fix[] = [
  { lat: 37.0, lon: -122.0, at: NOW - 20 * MINUTE },
  { lat: 37.1, lon: -122.1, at: NOW - 4 * MINUTE },
  { lat: 37.2, lon: -122.2, at: NOW - 1 * MINUTE },
];

export interface ShareOwnerInput {
  /** The DID the share's space grants READ. */
  reader: string;
}

/** The share the owner placed, held so it can be reached. */
export interface ShareSlot {
  live?: ShareLiveOutput;
}

export interface ShareOwnerOutput {
  [NAME]: string;
  [UI]: VNode;
  fixes: OwnerOnly<Fix[]>;
  share: ShareSlot;
  createShare: Stream<void>;
  recordFixes: Stream<void>;
}

const createShare = handler<
  void,
  {
    reader: string;
    fixes: Writable<OwnerOnly<Fix[]>>;
    share: Writable<ShareSlot>;
  }
>((_, { reader, fixes, share }) => {
  if (share.get().live) return;
  share.set({
    live: ShareLive.inSpace(undefined, {
      grants: { [reader as DID]: "READ" },
    })({ fixes, now: NOW }),
  });
});

const recordFixes = handler<void, { fixes: Writable<OwnerOnly<Fix[]>> }>(
  (_, { fixes }) => {
    fixes.set(FIXES as OwnerOnly<Fix[]>);
  },
);

const ShareOwner = pattern<ShareOwnerInput, ShareOwnerOutput>(
  ({ reader }) => {
    const fixes = new Writable<OwnerOnly<Fix[]>>().for("fixes");
    const share = new Writable<ShareSlot>({}).for("share");
    const status = computed(() => share.get().live ? "shared" : "not shared");
    const count = computed(() => `${(fixes.get() ?? []).length} fixes`);
    const create = createShare({ reader, fixes, share });
    const record = recordFixes({ fixes });
    return {
      [NAME]: "Share owner",
      [UI]: (
        <div>
          <p>
            Share: <span id="owner-share-status">{status}</span>
          </p>
          <p>
            Source: <span id="owner-fix-count">{count}</span>
          </p>
          <cf-button id="owner-share-button" onClick={create}>
            Share
          </cf-button>
          <cf-button id="owner-record-button" onClick={record}>
            Record fixes
          </cf-button>
        </div>
      ),
      fixes,
      share,
      createShare: create,
      recordFixes: record,
    };
  },
);

export default ShareOwner;
