import {
  computed,
  Default,
  pattern,
  type PerSession,
  type PerUser,
  Writable,
} from "commonfabric";

interface Counters {
  nextSeq: number;
  expiredThrough: number;
}

const ANNOTATED: Counters = { nextSeq: 1, expiredThrough: 0 };
const SATISFYING = { nextSeq: 1, expiredThrough: 0 } satisfies Counters;

type AnnotatedCell = Writable<Counters | Default<typeof ANNOTATED>>;
type SatisfyingCell = Writable<Counters | Default<typeof SATISFYING>>;

interface Input {
  annotated: PerSession<AnnotatedCell>;
  satisfying: PerUser<SatisfyingCell>;
}

// FIXTURE: computed-scoped-cell-alias-default
// Verifies: a destructured input declared as a scope wrapper around an alias of
//   a cell, `PerSession<AnnotatedCell>` with
//   `type AnnotatedCell = Writable<Counters | Default<typeof ANNOTATED>>`, keeps
//   the authored `Default<typeof ANNOTATED>` in the capture type of a computed
//   that reads it, and so keeps the default in the lift's argument schema.
//   The alias inside the scope wrapper is read through, as it is inside
//   `Writable`.
// Context: `ANNOTATED` is annotated with an interface and `SATISFYING` is
//   checked with `satisfies`, so neither const's type is literal: a capture type
//   printed from the checker's type holds `Counters` or a widened object type
//   where the default was, with no value to recover.
export default pattern<Input>(({ annotated, satisfying }) => {
  const next = computed(() => annotated.get().nextSeq);
  const expired = computed(() => satisfying.get().expiredThrough);
  return { next, expired };
});
