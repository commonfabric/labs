import { assertEquals } from "@std/assert";
import type {
  AnyStream,
  AsCell,
  HandlerState,
  KeyResultType,
  Stream,
  StreamEventOf,
  StreamResultOf,
  StripCell,
  StripDefaultBrand,
  WrapOrPreserve,
} from "@commonfabric/api";
import type { Same } from "@commonfabric/utils/types";

/**
 * The api's own type utilities, applied to a stream that DECLARES A RESULT.
 *
 * `stream-result-types.test.ts` covers direct assignability; this file covers
 * the plumbing a pattern actually flows through. The distinction matters: a
 * guard spelled `[T] extends [Stream<any>]` means `Stream<any, void>`, which a
 * returning verb does not satisfy — so every such guard silently stopped
 * matching when the result parameter arrived, while nothing in the workspace
 * declared a result and every suite stayed green. The break was latent until
 * the first `action<E, R>` user.
 *
 * Detection is therefore brand-based (`AnyStream`), matching what the other
 * two layers already do — the runtime reads the cell kind (`Cell.isStream`)
 * and the schema generator reads `CELL_BRAND`, which is exactly why neither
 * broke. Only the type layer matched the full generic instantiation, and only
 * the type layer broke.
 *
 * Assertions are value-position guards, not `MustBeTrue<...>`: a failing
 * conditional evaluates to `never`, and `never extends true` is true, so the
 * alias form would compile and assert nothing.
 */

type AssertAssignable<T, U> = [T] extends [U] ? true : never;

interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

type Returning = Stream<AddTopic, TopicRef>;
type ValueLess = Stream<AddTopic>;

// Detection must not depend on how many parameters Stream currently has.
const _returningIsAStream: AssertAssignable<Returning, AnyStream> = true;
const _valueLessIsAStream: AssertAssignable<ValueLess, AnyStream> = true;

// Both halves are recoverable.
const _eventOf: Same<StreamEventOf<Returning>, AddTopic> = true;
const _resultOf: Same<StreamResultOf<Returning>, TopicRef> = true;
const _resultOfValueLess: Same<StreamResultOf<ValueLess>, void> = true;

// Pass-through guards must preserve a returning stream IDENTICALLY — not
// merely leave it assignable to something. A guard that falls through to the
// `AnyBrandedCell<infer U>` branch silently strips the stream to its event
// payload, which is the failure mode with no symptom.
const _stripCellPreserves: Same<StripCell<Returning>, Returning> = true;
const _stripCellPreservesValueLess: Same<StripCell<ValueLess>, ValueLess> =
  true;

const _handlerStatePreserves: Same<
  HandlerState<{ verb: Returning }>,
  HandlerState<{ verb: Returning }>
> = true;

const _wrapOrPreservePreserves: Same<
  WrapOrPreserve<Returning, AsCell>,
  Returning
> = true;

const _keyResultPreserves: Same<
  KeyResultType<{ verb: Returning }, ["verb"], AsCell>,
  Returning
> = true;

// Rebuild guards must round-trip both arities: `Stream<E>` keeps R exactly
// `void`, and `Stream<E, R>` keeps R.
const _stripDefaultRoundTripsReturning: Same<
  StripDefaultBrand<Returning>,
  Returning
> = true;
const _stripDefaultRoundTripsValueLess: Same<
  StripDefaultBrand<ValueLess>,
  ValueLess
> = true;

Deno.test("api utilities carry a declared result through", () => {
  // Compile-time assertions above; this keeps the module a test file.
  assertEquals(typeof _returningIsAStream, "boolean");
});
