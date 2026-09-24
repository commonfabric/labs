// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * A room whose shared state only its own handlers may write: a sealed list
 * only `submit` appends to, and a sealed record only `freeze` sets. Both
 * carry a writer policy (`WriteAuthorizedBy`) and a module policy
 * (`PolicyOf`), and their entries name further types, which is the shape
 * whose stored label envelope keeps definition maps of its own. The tests
 * beside it drive that shape from one runtime and from two.
 */
import {
  type Confidential,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

/** Opens for nothing: every value in the room stays sealed. */
export const neverRelease = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: ["never-present-atom"] },
  post: { dropClause: true },
});
export const roomRules = exchangeRules([neverRelease]);

export type Sealed<T> = Confidential<T, readonly [PolicyOf<typeof roomRules>]>;

export type Rating = "great" | "ok" | "no";

export interface Stance {
  ratings?: Rating[];
}

export interface Entry {
  seat: number;
  digest: string;
  stances?: Stance[];
}

const submit = handler<
  { seat: number },
  { entries: Writable<Sealed<Entry>[]> }
>(({ seat }, { entries }) => {
  entries.push({ seat, digest: "d" + seat });
});

const freeze = handler<
  { digest: string },
  { frozen: Writable<Sealed<Entry>> }
>(({ digest }, { frozen }) => {
  frozen.set({ seat: 0, digest });
});

export type EntryList = WriteAuthorizedBy<Sealed<Entry>[], typeof submit>;
export type FrozenEntry = WriteAuthorizedBy<Sealed<Entry>, typeof freeze>;

export interface RoomInput {
  entries?: Default<EntryList, []>;
  frozen?: Default<FrozenEntry, { seat: -1; digest: "" }>;
}

export interface RoomOutput {
  [NAME]: string;
  entries: Sealed<Entry>[];
  frozen: Sealed<Entry>;
  submit: Stream<{ seat: number }>;
  freeze: Stream<{ digest: string }>;
}

export default pattern<RoomInput, RoomOutput>(({ entries, frozen }) => ({
  [NAME]: "Writer-policied room",
  entries,
  frozen,
  submit: submit({ entries }),
  freeze: freeze({ frozen }),
}));
