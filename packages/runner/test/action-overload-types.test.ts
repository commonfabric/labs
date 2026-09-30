/**
 * Type-level tests pinning `action()`'s overload resolution — the BUILDER half.
 *
 * If any type assertion is wrong, this file fails to compile.
 *
 * This file cannot see the surface a pattern compiles against. A pattern
 * resolves `commonfabric` to `api/index.ts` and type-checks against
 * `ActionFunction` there, which is a separate hand-maintained declaration of
 * these same signatures. An overload present here and missing there is
 * invisible to every pattern while this file stays green — which is exactly
 * how the declared-result overload first shipped unreachable. The matching
 * half is `packages/api/test/action-function-surface.test.ts`; a change to the
 * overloads below belongs in both.
 *
 * The ordering of `action`'s overloads is load-bearing and a comment cannot
 * fail a build. Overload 2 (`(event: E) => void`) absorbs every callback,
 * because any return type is assignable to a void-returning signature — that
 * is what keeps an incidental return from being read as a declared verb
 * result. Reorder the overloads, or delete overload 2, and inference starts
 * picking those returns up silently. These assertions fail if that happens.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Cell, Stream } from "@commonfabric/api";
import type { MustBeTrue, Same } from "@commonfabric/utils/types";
import { action } from "../src/builder/module.ts";

interface AddTopic {
  title: string;
}

interface TopicRef {
  id: string;
}

declare const selected: Cell<string>;

/**
 * `action()` throws unless the CTS transform is enabled, so the call
 * expressions live in a function that is never invoked. Overload resolution
 * happens at compile time regardless; nothing here runs.
 */
export function _actionOverloadTypeProbe() {
  // The hazard case. `Cell.set` returns the cell, not void (api `ISettable`),
  // so this concise arrow body's completion value is a `Cell<string>`. It must
  // still resolve to a result-less stream: nobody wrote a verb result here.
  const concise = action((id: string) => selected.set(id));
  type _ConciseHasNoResult = MustBeTrue<Same<typeof concise, Stream<string>>>;

  // A result is opt-in, and only by naming both type arguments.
  const declared = action<AddTopic, TopicRef>((_event) => ({ id: "topic-1" }));
  type _DeclaredCarriesResult = MustBeTrue<
    Same<typeof declared, Stream<AddTopic, TopicRef>>
  >;

  // A declared result is not interchangeable with a result-less stream, so a
  // dropped declaration is a compile error at the assignment rather than a
  // silent erasure.
  type _DeclaredIsNotResultLess = MustBeTrue<
    Same<typeof declared, Stream<AddTopic>> extends true ? false : true
  >;

  // Zero-parameter callbacks keep overload 1.
  const noEvent = action(() => {});
  type _NoEventHasNoResult = MustBeTrue<Same<typeof noEvent, Stream<void>>>;

  return { concise, declared, noEvent };
}

describe("action overload resolution", () => {
  it("is pinned by the type assertions in this file", () => {
    // The assertions above are compile-time. This keeps the module a test file
    // so it stays type-checked by the suite.
    expect(typeof _actionOverloadTypeProbe).toBe("function");
  });
});
