// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * A private field that one handler may write, and only from a trusted click
 * on the pin surface. The pattern's other handlers declare the field's label
 * in their own types, which is what a writer holding the field ordinarily
 * does; declaring it grants nothing the field's contract withholds.
 */
import {
  type Confidential,
  type CurrentPrincipal,
  handler,
  pattern,
  Stream,
  type TrustedActionUiContract,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";

/** Readable only by the user whose transaction creates the store. */
export type OnlyMe<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

export const PIN_SURFACE = "PinnedNoteSurface";
export const PIN_ACTION = "PinNote";

type PinClick = TrustedActionUiContract<
  string,
  typeof PIN_ACTION,
  typeof PIN_SURFACE
>;

const pinDraft = handler<
  void,
  { draft: Writable<string>; pinned: Writable<OnlyMe<PinClick>> }
>((_, { draft, pinned }) => {
  pinned.set(draft.get());
});

// Restates the contract, so a trusted click satisfies it, but the field
// names `pinDraft` as its only writer.
const repin = handler<void, { pinned: Writable<OnlyMe<PinClick>> }>(
  (_, { pinned }) => {
    pinned.set("repinned");
  },
);

// Restates the label and neither the contract nor the writer.
const overwrite = handler<void, { pinned: Writable<OnlyMe<string>> }>(
  (_, { pinned }) => {
    pinned.set("overwritten");
  },
);

export type PinnedNote = OnlyMe<
  TrustedActionWrite<
    string,
    typeof pinDraft,
    typeof PIN_ACTION,
    typeof PIN_SURFACE
  >
>;

export interface PinnedNoteOutput {
  pinned: PinnedNote;
  pin: Stream<void>;
  repin: Stream<void>;
  overwrite: Stream<void>;
}

export default pattern<Record<string, never>, PinnedNoteOutput>(() => {
  const draft = new Writable("call the pharmacy");
  const pinned = new Writable<PinnedNote>("");
  return {
    pinned,
    pin: pinDraft({ draft, pinned }),
    repin: repin({ pinned }),
    overwrite: overwrite({ pinned }),
  };
});
