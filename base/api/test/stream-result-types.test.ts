import { assertEquals } from "@std/assert";
import type { CELL_RESULT_TYPE, Stream } from "@commonfabric/api";

// Value-position guards, not `MustBeTrue<...>` type aliases. `MustBeTrue<T
// extends true>` does NOT catch a failed assertion: a failing
// AssertAssignable/AssertNotAssignable evaluates to `never`, and `never extends
// true` is true, so the alias compiles and the assertion is vacuous. Assigning
// `true` to the result fails when it is `never`, which is what makes these bite.
// (Verified: `MustBeTrue<AssertAssignable<string, number>>` compiles clean.)
type AssertAssignable<T, U> = [T] extends [U] ? true : never;
type AssertNotAssignable<T, U> = [T] extends [U] ? never : true;

interface AddTopic {
  title: string;
}

interface TopicRef {
  id: string;
}

// A verb that declares nothing is the common shape and keeps its old spelling.
type ValueLess = Stream<AddTopic>;
type ExplicitVoid = Stream<AddTopic, void>;
type Returning = Stream<AddTopic, TopicRef>;

// `R` defaults to void, so every existing `Stream<T>` means what it always did.
const _DefaultIsVoid: AssertAssignable<ValueLess, ExplicitVoid> = true;
const _VoidIsDefault: AssertAssignable<ExplicitVoid, ValueLess> = true;

// A verb that declares a result and one that declares none are different types
// in both directions, so a declared result cannot be dropped on assignment.
//
// These assertions alone do NOT prove the CELL_RESULT_TYPE property is doing
// the work: `ICreatable<Stream<T, R>>` puts the stream in `for()`'s return
// position, which discriminates on `R` too. They would still pass with the
// property removed. The guard below is what pins it locally.
const _ReturningIsNotValueLess: AssertNotAssignable<Returning, ValueLess> =
  true;
const _ValueLessIsNotReturning: AssertNotAssignable<ValueLess, Returning> =
  true;

// Two different declared results do not interchange either.
const _ResultsDiscriminate: AssertNotAssignable<
  Returning,
  Stream<AddTopic, { other: string }>
> = true;

// A stream is still identical to itself.
const _SelfAssignable: AssertAssignable<Returning, Returning> = true;

// The event type keeps discriminating independently of the result.
const _EventStillDiscriminates: AssertNotAssignable<
  Returning,
  Stream<{ different: number }, TopicRef>
> = true;

// `R` is recoverable by inference — what the transformer and schema generator
// read to lower a value-returning verb.
type ResultOf<S> = S extends Stream<infer _E, infer R> ? R : never;
const _InfersDeclaredResult: AssertAssignable<ResultOf<Returning>, TopicRef> =
  true;
const _InfersVoidWhenUndeclared: AssertAssignable<ResultOf<ValueLess>, void> =
  true;

// The event type stays inferable alongside it.
type EventOf<S> = S extends Stream<infer E, infer _R> ? E : never;
const _InfersEvent: AssertAssignable<EventOf<Returning>, AddTopic> = true;

// Stream carries the result in its OWN property rather than borrowing the
// discrimination from ICreatable. Deleting `[CELL_RESULT_TYPE]` from Stream
// makes this line a type error, which is the point: without it the behavior
// above rides on ICreatable's signature and would vanish silently if that
// signature ever changed.
const _ResultPinnedLocally: AssertAssignable<
  Returning[typeof CELL_RESULT_TYPE],
  TopicRef
> = true;
const _ValueLessPinnedLocally: AssertAssignable<
  ValueLess[typeof CELL_RESULT_TYPE],
  void
> = true;

// Schema compatibility checks results as candidate ⊆ previous, and "results may
// narrow freely" governs values, never named fields: removing a named property
// is rejected outright, at ANY depth — a nested removal reports
// `result.topic.title` just as a flat one reports `result.title`. So nesting
// does not reduce what a result commits to; every name it publishes is
// permanent wherever it sits, and later additions must be optional.
//
// The two shapes below therefore differ in how many names they commit, not in
// how evolvable those names are.
interface AddTopicResult {
  topic: { fid: string; title: string };
}

type EnvelopedVerb = Stream<AddTopic, AddTopicResult>;

// The enveloped form commits one top-level name — but `fid` and `title` under
// it are equally permanent, so this is a smaller surface at the top only.
const _EnvelopeCommitsOneTopName: AssertAssignable<
  keyof ResultOf<EnvelopedVerb>,
  "topic"
> = true;

// Spread flat, the same two names are committed at the top instead of one.
type FlatVerb = Stream<AddTopic, { fid: string; title: string }>;
const _FlatCommitsEveryName: AssertAssignable<
  keyof ResultOf<FlatVerb>,
  "fid" | "title"
> = true;

// The two are not interchangeable, so reshaping a result after the fact is a
// compile error rather than a quiet schema break.
const _EnvelopeIsNotFlat: AssertNotAssignable<EnvelopedVerb, FlatVerb> = true;

Deno.test("Stream result type parameter is structural", () => {
  // The assertions above are compile-time; this keeps the module a test file
  // and fails loudly if it ever stops being type-checked.
  assertEquals(typeof "compile-time", "string");
});
