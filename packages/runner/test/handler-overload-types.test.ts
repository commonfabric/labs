/**
 * Type-level tests pinning `handler()`'s overload resolution — the BUILDER
 * half.
 *
 * If any type assertion is wrong, this file fails to compile.
 *
 * This file cannot see the surface a pattern compiles against. A pattern
 * resolves `commonfabric` to `api/index.ts` and type-checks against
 * `HandlerFunction` there, which is a separate hand-maintained declaration of
 * these same signatures. An overload present here and missing there is
 * invisible to every pattern while this file stays green — the exact failure
 * mode `action`'s declared-result overload shipped with. The matching half is
 * `packages/api/test/handler-function-surface.test.ts`; a change to the
 * overloads below belongs in both.
 *
 * The ordering of `handler`'s overloads is load-bearing and a comment cannot
 * fail a build. The `=> any` forms absorb every inferred callback — that is
 * what keeps an incidental return from being read as a declared verb result.
 * Reorder them, or delete one, and inference starts picking those returns up
 * silently. These assertions fail if that happens.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  Cell,
  HandlerFactory,
  HandlerState,
  Stream,
} from "@commonfabric/api";
import type { Equal, MustBeTrue, Same } from "@commonfabric/utils/types";
import { handler } from "../src/builder/module.ts";

interface AddTopic {
  title: string;
}

interface TopicRef {
  id: string;
}

interface BoundState {
  selected: Cell<string>;
}

interface MixedState {
  selected: Cell<string>;
  label: string;
}

/**
 * `handler()` builds a factory without running anything; overload resolution
 * happens at compile time. Nothing here runs.
 */
export function _handlerOverloadTypeProbe() {
  // The hazard case. `Cell.set` returns the cell, not void (api `ISettable`),
  // so this concise body's completion value is a `Cell<string>`. It must
  // still resolve to a result-less factory: nobody wrote a verb result here.
  const concise = handler(
    (id: string, state: BoundState) => state.selected.set(id),
  );
  type _ConciseHasNoResult = MustBeTrue<
    Same<typeof concise, HandlerFactory<string, BoundState>>
  >;

  // A result is opt-in, and only by naming all three type arguments — on each
  // of the call forms.
  const declared = handler<AddTopic, BoundState, TopicRef>(
    (_event, _state) => ({ id: "topic-1" }),
  );
  type _DeclaredCarriesResult = MustBeTrue<
    Same<typeof declared, HandlerFactory<AddTopic, BoundState, TopicRef>>
  >;

  const declaredWithSchemas = handler<AddTopic, BoundState, TopicRef>(
    { type: "object" },
    { type: "object" },
    (_event, _state) => ({ id: "topic-1" }),
  );
  type _SchemaFormCarriesResult = MustBeTrue<
    Same<
      typeof declaredWithSchemas,
      HandlerFactory<AddTopic, BoundState, TopicRef>
    >
  >;

  // A declared result is not interchangeable with a result-less factory, so a
  // dropped declaration is a compile error at the assignment rather than a
  // silent erasure.
  type _DeclaredIsNotResultLess = MustBeTrue<
    Same<typeof declared, HandlerFactory<AddTopic, BoundState>> extends true
      ? false
      : true
  >;

  // The produced stream carries the declared result.
  type _StreamCarriesResult = MustBeTrue<
    Same<ReturnType<typeof declared>, Stream<AddTopic, TopicRef>>
  >;

  // Props parity with api's `HandlerFunction` (the other hand-maintained
  // half): a callback sees `HandlerState<T>` — non-handle members readonly,
  // cell handles passed through whole.
  const stateTyped = handler<AddTopic, MixedState>((_event, state) => {
    type _PropsAreHandlerState = MustBeTrue<
      Equal<typeof state, HandlerState<MixedState>>
    >;
    type _PlainMemberIsReadonly = MustBeTrue<
      Equal<Pick<typeof state, "label">, { readonly label: string }>
    >;
    type _CellPassesThroughWhole = MustBeTrue<
      Same<(typeof state)["selected"], Cell<string>>
    >;
    state.selected.set("writable-through-the-handle");
  });
  return {
    concise,
    declared,
    declaredWithSchemas,
    stateTyped,
  };
}

describe("handler overload resolution", () => {
  it("is pinned by the type assertions in this file", () => {
    // The assertions above are compile-time. This keeps the module a test file
    // so it stays type-checked by the suite.
    expect(typeof _handlerOverloadTypeProbe).toBe("function");
  });
});
