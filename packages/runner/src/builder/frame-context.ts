/**
 * The builder's frame stacks, one per action and one shared root, carried per
 * async context so that work interleaving across an `await` never reads
 * another action's frame.
 *
 * Every runtime in a process shares this module. A handler that awaits with
 * its frame pushed would otherwise leave that frame on top of a stack that
 * every other runtime reads: a module evaluated meanwhile would bind the cells
 * its pattern body mints into the handler's space, and another runtime's
 * handler resuming after its own `await` would find this one's frame on top.
 * `runInFrameContext` gives an action a stack of its own, which its
 * continuations keep across their awaits; code outside any action reads the
 * root stack.
 *
 * The context rides `AsyncLocalStorage` where the host provides it (Deno). A
 * browser has none, and the promise-aware fallback keeps an action's context
 * current from its start until its promise settles. That is sound only while
 * one action runs at a time in the realm, which holds for a browser worker: it
 * hosts one runtime, whose scheduler awaits an action's whole promise before
 * starting the next.
 *
 * This module is a leaf apart from type imports: the top-level `await` that
 * picks the store would stall module evaluation inside an import cycle.
 */

import { isDeno } from "@commonfabric/utils/env";
import {
  type AsyncLocalStore,
  FallbackAsyncLocalStore,
} from "@commonfabric/utils/async-local-store";

import type { Frame } from "./types.ts";

// Deno/Node `AsyncLocalStorage` when available, the promise-aware fallback
// otherwise. The `await import` stays here (not in the shared utils module): a
// top-level await in widely-imported utils stalls Deno module evaluation.
const FrameContextStorage = (isDeno()
  // deno-lint-ignore cf-imports/no-inline-module-import
  ? (await import("node:async_hooks")).AsyncLocalStorage
  : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;

/** The frame stack of one async context, and its action-execution depth. */
type FrameContext = {
  /** Frames pushed in this context, innermost last. */
  readonly frames: Frame[];

  /**
   * How many `runInActionExecution` calls in this context have not yet
   * finished; above zero, minting a builder artifact is refused.
   */
  actionDepth: number;
};

/**
 * The context in effect wherever no action's context is: module-level code,
 * runtime construction, and anything a host calls outside an action.
 */
const rootContext: FrameContext = { frames: [], actionDepth: 0 };

const contexts = new FrameContextStorage<FrameContext>();

/** Returns the context the current code runs in. */
function currentContext(): FrameContext {
  return contexts.getStore() ?? rootContext;
}

/**
 * Runs `fn` in a fresh frame context with an empty stack, and returns what it
 * returns. Frames `fn` pushes, including ones it pops only after an `await`,
 * are seen by `fn` and its continuations and by nothing else. While the stack
 * is empty, `topFrame()` returns the root stack's top.
 */
export function runInFrameContext<R>(fn: () => R): R {
  return contexts.run({ frames: [], actionDepth: 0 }, fn);
}

/** Pushes `frame` onto the current context's stack. */
export function pushOntoFrameStack(frame: Frame): void {
  currentContext().frames.push(frame);
}

/**
 * Pushes `frame` onto the root stack, which every context falls back to while
 * its own stack is empty.
 */
export function pushOntoRootFrameStack(frame: Frame): void {
  rootContext.frames.push(frame);
}

/**
 * Removes `frame` from the current context's stack or, failing that, from the
 * root stack, wherever on the stack it sits: disposing one runtime while
 * another has pushed a frame over it removes one from the middle. A frame on
 * neither stack is left alone.
 */
export function removeFromFrameStack(frame: Frame): void {
  for (const context of [currentContext(), rootContext]) {
    const index = context.frames.indexOf(frame);
    if (index !== -1) {
      context.frames.splice(index, 1);
      return;
    }
  }
}

/**
 * Returns the innermost frame of the current context, or of the root stack
 * when the current context has none.
 */
export function topFrame(): Frame | undefined {
  const { frames } = currentContext();
  if (frames.length > 0) return frames[frames.length - 1];
  const root = rootContext.frames;
  return root.length > 0 ? root[root.length - 1] : undefined;
}

/**
 * Runs `fn` as an action's user code, returning what it returns, and marks the
 * current context as executing an action until `fn` returns or, for a promise,
 * settles. Called outside any frame context, it opens one of its own, so the
 * mark cannot reach the root context.
 *
 * While the mark is set, minting a builder artifact is refused
 * (`assertNotInActionExecution`). Builder artifacts must be module-scope
 * declarations: the builder-call-hoisting transformer moves every authored
 * builder call to module scope, the SES verifier enforces that shape, and
 * content-addressed identity (`{ identity, symbol }`) only exists for
 * module-scope artifacts. An artifact minted inside a running action would have
 * no identity, no provenance, and (closure-bearing) no serializable body, so
 * nothing could rehydrate it.
 *
 * The mark lives on the action's context, so an async action's continuations
 * stay covered past its awaits, and a module evaluated on another context is
 * not covered. A module evaluated inside the action's own context pushes a
 * frame marked `moduleEvaluation` and is fully synchronous, so the guard
 * admits mints made while such a frame is on top.
 */
export function runInActionExecution<R>(fn: () => R): R {
  const context = contexts.getStore();
  if (context === undefined) {
    return runInFrameContext(() => runInActionExecution(fn));
  }
  context.actionDepth++;
  let result: R;
  try {
    result = fn();
  } catch (error) {
    context.actionDepth--;
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      context.actionDepth--;
    }) as R;
  }
  context.actionDepth--;
  return result;
}

/** Returns whether the current context is executing an action's user code. */
export function inActionExecution(): boolean {
  return currentContext().actionDepth > 0;
}
