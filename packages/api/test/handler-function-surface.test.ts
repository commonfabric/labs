/**
 * `HandlerFunction` is the `handler` a PATTERN sees — the same hand-maintained
 * mirror situation as `ActionFunction` (see `action-function-surface.test.ts`):
 * an overload added to `builder/module.ts` but not here is unreachable from
 * every pattern while the builder's own tests stay green. These assertions are
 * the pattern-facing half of the declared-result overloads;
 * `packages/runner/test/handler-overload-types.test.ts` covers the builder
 * half. Both must hold.
 */

import { assertEquals } from "@std/assert";
import type {
  HandlerFactory,
  HandlerFunction,
  Stream,
} from "@commonfabric/api";
import type { MustBeTrue, Same } from "@commonfabric/utils/types";

interface AddTopic {
  title: string;
}

interface TopicRef {
  topic: { fid: string };
}

interface BoundState {
  count: number;
}

declare const handler: HandlerFunction;
declare const someCell: { set(v: string): { cell: true } };

/** Never invoked; the assertions are resolved at compile time. */
export function _handlerFunctionSurfaceProbe() {
  // The hazard: a concise body whose completion value is a `Cell`, not void.
  // The `=> any` forms must absorb it, leaving the result void.
  const concise = handler(
    (id: string, _props: BoundState) => someCell.set(id),
  );
  type _ConciseHasNoResult = MustBeTrue<
    Same<typeof concise, HandlerFactory<string, BoundState>>
  >;

  // A result is reachable from a pattern, and only by naming all three type
  // arguments — on each of the call forms.
  const declared = handler<AddTopic, BoundState, TopicRef>(
    (_event, _props) => ({ topic: { fid: "topic-1" } }),
  );
  type _DeclaredCarriesResult = MustBeTrue<
    Same<typeof declared, HandlerFactory<AddTopic, BoundState, TopicRef>>
  >;

  const declaredWithSchemas = handler<AddTopic, BoundState, TopicRef>(
    { type: "object" },
    { type: "object" },
    (_event, _props) => ({ topic: { fid: "topic-1" } }),
  );
  type _SchemaFormCarriesResult = MustBeTrue<
    Same<
      typeof declaredWithSchemas,
      HandlerFactory<AddTopic, BoundState, TopicRef>
    >
  >;

  // The factory's produced stream carries the declared result — what an
  // Output interface declares and the schema layer reads.
  type _StreamCarriesResult = MustBeTrue<
    Same<ReturnType<typeof declared>, Stream<AddTopic, TopicRef>>
  >;

  // What a pattern actually writes: the produced verb satisfies an Output
  // interface declaring the result. If the surfaces drift again, this stops
  // assigning.
  interface Output {
    addTopic: Stream<AddTopic, TopicRef>;
  }
  const output: Output = { addTopic: declared({ count: 0 }) };

  return { concise, declared, declaredWithSchemas, output };
}

Deno.test("HandlerFunction exposes the declared-result overloads to patterns", () => {
  assertEquals(typeof _handlerFunctionSurfaceProbe, "function");
});
