// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * A per-user value read by computed results whose types are inferred. Such a
 * result's schema declares no scope, since a type inferred through `??` or a
 * union keeps or drops a scope wrapper by how TypeScript reduces it. The
 * runtime stores each result at the narrowest scope its callback reads, so the
 * results are per-user all the same, which `multi-user.test.tsx` checks from
 * two users' runtimes on one shared piece.
 */
import {
  computed,
  type Default,
  handler,
  pattern,
  type PerUser,
  type Stream,
  type Writable,
} from "commonfabric";

interface Input {
  secret?: PerUser<string | Default<"">>;
  note?: PerUser<Writable<string | Default<"">>>;
}

export interface InferredResultScopeOutput {
  passThrough: string | undefined;
  shout: string;
  tagged: { who: string | undefined; n: number };
  coalesced: string;
  holder: { note: Writable<string> };
  setSecret: Stream<{ value: string }>;
  setNote: Stream<{ value: string }>;
}

/** Writes the sender's own per-user slot. */
const setSecret = handler<
  { value: string },
  { secret: Writable<string | Default<"">> }
>(({ value }, { secret }) => {
  secret.set(value);
});

/** Writes the sender's own per-user note cell. */
const setNote = handler<
  { value: string },
  { note: Writable<string | Default<"">> }
>(({ value }, { note }) => {
  note.set(value);
});

export default pattern<Input, InferredResultScopeOutput>((
  { secret, note },
) => ({
  // Inferred as the scope wrapper itself.
  passThrough: computed(() => secret),
  // Inferred as a plain string read from it.
  shout: computed(() => (secret ?? "").toUpperCase()),
  // Inferred as an object holding it.
  tagged: computed(() => ({ who: secret, n: 1 })),
  // Inferred as the wrapper beside a literal, which a declared scope could
  // only put inside an `anyOf` branch.
  coalesced: computed(() => (secret as PerUser<string> | undefined) ?? "none"),
  // Inferred as an object holding a per-user cell, whose cap it no longer
  // declares: the link it holds resolves to each reader's own cell.
  holder: computed(() => ({ note })),
  setSecret: setSecret({ secret }),
  setNote: setNote({ note }),
}));
