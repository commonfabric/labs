/**
 * `ActionFunction` is the `action` a PATTERN sees: `commonfabric` resolves to
 * `api/index.ts`, so this type — not `builder/module.ts`'s implementation
 * overloads — is what a pattern type-checks against.
 *
 * The two are maintained by hand and drift silently in one direction that no
 * other test notices: an overload added to the builder but not here is
 * invisible to every pattern, while the builder's own tests keep passing. That
 * is how the result overload was first shipped unreachable — `action<E, R>(…)`
 * in a pattern failed with "Expected 1 type arguments, but got 2" while
 * `packages/runner`'s overload guard was green.
 *
 * These assertions are the pattern-facing half. `packages/runner`'s
 * `action-overload-types.test.ts` covers the builder half; both must hold.
 */

import { assertEquals } from "@std/assert";
import type { ActionFunction, Stream } from "@commonfabric/api";
import type { MustBeTrue, Same } from "@commonfabric/utils/types";

interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

declare const action: ActionFunction;
declare const someCell: { set(v: string): { cell: true } };

/** Never invoked; the assertions are resolved at compile time. */
export function _actionFunctionSurfaceProbe() {
  // A zero-parameter callback keeps overload 1.
  const noEvent = action(() => {});
  type _NoEvent = MustBeTrue<Same<typeof noEvent, Stream<void>>>;

  // The hazard: a concise body whose completion value is a `Cell`, not void.
  // Overload 2 must absorb it, leaving the result void.
  const concise = action((id: string) => someCell.set(id));
  type _ConciseHasNoResult = MustBeTrue<Same<typeof concise, Stream<string>>>;

  // A result is reachable from a pattern, and only by naming both arguments.
  // This is the assertion whose absence let the unreachable surface ship.
  const declared = action<AddTopic, TopicRef>((_event) => ({
    topic: { fid: "topic-1" },
  }));
  type _DeclaredCarriesResult = MustBeTrue<
    Same<typeof declared, Stream<AddTopic, TopicRef>>
  >;

  // What a pattern actually writes: the verb satisfies an Output interface that
  // declares the result. If the surfaces drift again, this stops assigning.
  interface Output {
    addTopic: Stream<AddTopic, TopicRef>;
  }
  const output: Output = { addTopic: declared };

  return { noEvent, concise, declared, output };
}

Deno.test("ActionFunction exposes the declared-result overload to patterns", () => {
  assertEquals(typeof _actionFunctionSurfaceProbe, "function");
});
