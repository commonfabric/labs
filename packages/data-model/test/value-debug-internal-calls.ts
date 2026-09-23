/**
 * The calls the late-binding tests make of each debug renderer, written once
 * so that the worker, which calls the forwarders, and the test, which calls the
 * renderers themselves, make the same ones.
 *
 * Not a `*.test.ts` file, so the runner does not pick it up as a suite.
 */

import type { DebugRenderers } from "@/value-debug-internal.ts";

/** Returns one call of each of `renderers`, by the renderer's name. */
export function rendererCalls(
  renderers: DebugRenderers,
): Readonly<Record<keyof DebugRenderers, () => unknown>> {
  return {
    debugStr: () => renderers.debugStr`a value: $quote${[1, 2]}`,
    toCompactDebugString: () => renderers.toCompactDebugString({ a: 1 }),
    toDebugKindString: () => renderers.toDebugKindString([1]),
    toIndentedDebugString: () => renderers.toIndentedDebugString({ a: [1] }),
    toLongQuotedDebugString: () => renderers.toLongQuotedDebugString("x"),
    toShortQuotedDebugString: () => renderers.toShortQuotedDebugString("x"),
    toStructuredDebugValue: () => renderers.toStructuredDebugValue(new Map()),
  };
}
