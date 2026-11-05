/** Element-level render contexts supplied through the standard protocol. */

import type { CellHandle } from "@commonfabric/runtime-client";

export const SPACE_CONTEXT_KEY = "space";
const PIECE_BOUNDARY_CONTEXT_KEY = Symbol("commonfabric-piece-boundary");

export interface PieceBoundaryContext {
  cell: CellHandle;
  element: Element;
}

type ContextRequestEvent = Event & {
  context: unknown;
  callback: (value: unknown, unsubscribe?: () => void) => void;
  subscribe?: boolean;
  accept?: (value: PieceBoundaryContext) => boolean;
};

interface ElementContextState {
  space?: string;
  piece?: PieceBoundaryContext;
  pieceChanges?: EventTarget;
}

const elementContexts = new WeakMap<EventTarget, ElementContextState>();

function ensureElementContext(element: EventTarget): ElementContextState {
  const existing = elementContexts.get(element);
  if (existing) return existing;

  const state: ElementContextState = {};
  elementContexts.set(element, state);
  element.addEventListener("context-request", (event) => {
    const request = event as ContextRequestEvent;
    if (typeof request.callback !== "function") return;

    if (request.context === SPACE_CONTEXT_KEY && state.space !== undefined) {
      event.stopPropagation();
      request.callback(state.space, () => {});
      return;
    }

    if (
      request.context !== PIECE_BOUNDARY_CONTEXT_KEY || !state.piece ||
      (request.accept && !request.accept(state.piece))
    ) return;
    event.stopPropagation();
    if (request.subscribe) {
      const changes = state.pieceChanges ??= new EventTarget();
      const notify = () => request.callback(state.piece);
      changes.addEventListener("change", notify);
      request.callback(
        state.piece,
        () => changes.removeEventListener("change", notify),
      );
    } else {
      request.callback(state.piece);
    }
  });
  return state;
}

/**
 * Provide the producing space at a render boundary. The string key matches
 * `createContext("space")` consumers without a shared import.
 */
export function provideElementSpace(element: EventTarget, space: string) {
  ensureElementContext(element).space = space;
}

/** Provide the piece whose UI begins at an existing render root element. */
export function providePieceBoundary(element: Element, cell: CellHandle): void {
  const state = ensureElementContext(element);
  if (state.piece?.cell.equals(cell)) return;
  state.piece = { cell, element };
  state.pieceChanges?.dispatchEvent(new Event("change"));
}

/** Clear a piece boundary while leaving other element contexts intact. */
export function clearPieceBoundary(element: Element): void {
  const state = elementContexts.get(element);
  if (!state?.piece) return;
  state.piece = undefined;
  state.pieceChanges?.dispatchEvent(new Event("change"));
}

function dispatchPieceBoundaryRequest(
  target: unknown,
  callback: ContextRequestEvent["callback"],
  subscribe = false,
  accept?: ContextRequestEvent["accept"],
): void {
  if (
    !target || typeof target !== "object" || !("dispatchEvent" in target) ||
    typeof target.dispatchEvent !== "function"
  ) return;
  const event = Object.assign(
    new Event("context-request", { bubbles: true, composed: true }),
    { context: PIECE_BOUNDARY_CONTEXT_KEY, callback, subscribe, accept },
  );
  target.dispatchEvent(event);
}

/** Get the nearest piece boundary provided by an element or its ancestors. */
export function getPieceBoundary(
  target: unknown,
  accept?: (piece: PieceBoundaryContext) => boolean,
): PieceBoundaryContext | undefined {
  let result: PieceBoundaryContext | undefined;
  dispatchPieceBoundaryRequest(
    target,
    (value) => {
      result = value as PieceBoundaryContext;
    },
    false,
    accept,
  );
  return result;
}

/** Subscribe to changes from the nearest current piece boundary. */
export function subscribePieceBoundary(
  target: unknown,
  callback: (piece: PieceBoundaryContext | undefined) => void,
): () => void {
  let unsubscribe = () => {};
  dispatchPieceBoundaryRequest(
    target,
    (value, dispose) => {
      if (dispose) unsubscribe = dispose;
      callback(value as PieceBoundaryContext | undefined);
    },
    true,
  );
  return () => unsubscribe();
}
