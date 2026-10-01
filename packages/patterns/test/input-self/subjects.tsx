// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * Patterns that name their own result as `input[SELF]`, each in one of the
 * forms a pattern body can take, beside the destructured `[SELF]` form they
 * are measured against. `main.test.tsx` checks that every one of them reaches
 * the result rather than an empty cell.
 */

import {
  computed,
  type Default,
  handler,
  pattern,
  SELF,
  type Stream,
  Writable,
} from "commonfabric";

interface In {
  title: Default<string, "hello">;
}

/** What a pattern under test publishes. */
export interface Out {
  title: string;

  /** The pattern's own result, as `SELF` named it. */
  other: { title: string } | undefined;
}

/** The pattern's own `title`, read through `SELF`. */
export interface TitleOut {
  title: string;
  otherTitle: string;
}

/** Destructures `[SELF]` in the parameter. The form the others match. */
export const Destructured = pattern<In, Out>(({ title, [SELF]: self }) => ({
  title,
  other: self,
}));

/** Reads `input[SELF]` in the pattern body. */
export const Indexed = pattern<In, Out>((input) => ({
  title: input.title,
  other: input[SELF],
}));

/** Binds `input[SELF]` to a local before publishing it. */
export const Aliased = pattern<In, Out>((input) => {
  const self = input[SELF];
  return { title: input.title, other: self };
});

/** Reads a property of the result through `input[SELF]`. */
export const IndexedTitle = pattern<In, TitleOut>((input) => ({
  title: input.title,
  otherTitle: input[SELF].title,
}));

interface ListIn {
  items: Default<string[], ["a", "b"]>;
}

/** What a pattern over a list publishes about itself. */
export interface ListOut {
  items: string[];
  echoed: string[];
  kept: string[];
}

/** Maps and filters a list read through `input[SELF]`. */
export const OverOwnList = pattern<ListIn, ListOut>((input) => ({
  items: input.items,
  echoed: input[SELF].items.map((item) => item + "!"),
  kept: input[SELF].items.filter((item) => item !== "b"),
}));

/** Destructures `[SELF]` off the input in the pattern body. */
export const DestructuredInBody = pattern<In, Out>((input) => {
  const { [SELF]: self } = input;
  return { title: input.title, other: self };
});

/** What a pattern publishes from its own result through callbacks. */
export interface CapturedOut {
  title: string;
  items: string[];
  shouted: string;
  computedTitle: string;
  mappedTitles: string[];
}

/**
 * Reads `input[SELF]` into a local in the pattern body and captures that local
 * in `computed()` and in a reactive `.map()`, and calls a method through
 * `input[SELF]`.
 */
export const CapturedAlias = pattern<
  In & { items: Default<string[], ["a", "b"]> },
  CapturedOut
>((input) => {
  const self = input[SELF];
  return {
    title: input.title,
    items: input.items,
    shouted: input[SELF].title.toUpperCase(),
    computedTitle: computed(() => self.title),
    mappedTitles: input.items.map(() => self.title),
  };
});

/** A child that republishes the title of the `room` it is handed. */
export const Child = pattern<
  { room: { title: string } },
  { roomTitle: string }
>(({ room }) => ({ roomTitle: room.title }));

/** Hands `input[SELF]` to a child pattern. */
export const HandedToChild = pattern<
  In,
  { title: string; child: { roomTitle: string } }
>((input) => ({
  title: input.title,
  child: Child({ room: input[SELF] }),
}));

const copyTitle = handler<
  void,
  { room: { title: string }; seen: Writable<string> }
>((_, { room, seen }) => {
  seen.set(room.title);
});

/** Binds `input[SELF]` as a handler's state. */
export const HandlerBound = pattern<
  In & { seen: Writable<Default<string, "">> },
  { title: string; seen: string; copy: Stream<void> }
>((input) => ({
  title: input.title,
  seen: input.seen,
  copy: copyTitle({ room: input[SELF], seen: input.seen }),
}));
