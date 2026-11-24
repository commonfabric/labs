/**
 * The element contexts a render boundary provides: the producing space, and
 * the piece whose UI begins there. A mock document's element stands in for the
 * page's, as in the applicator's tests.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  $conn,
  CellHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import {
  getPieceBoundary,
  provideElementSpace,
  providePieceBoundary,
  SPACE_CONTEXT_KEY,
  subscribePieceBoundary,
} from "../src/main/space-context.ts";
import { MockDoc } from "../src/mock-doc.ts";

const element = (): Element =>
  new MockDoc("<!DOCTYPE html><html><body></body></html>").document
    .createElement("div") as unknown as Element;

const runtime = { [$conn]: () => ({}) } as unknown as RuntimeClient;
const piece = (id: `of:${string}`) =>
  new CellHandle(runtime, {
    id,
    space: "did:key:piece",
    scope: "space",
    path: [],
  });

/** Dispatches a context request for `context` on `target`, and returns it. */
const request = (target: Element, context: unknown, callback: unknown) => {
  const event = Object.assign(
    new Event("context-request", { bubbles: true }),
    { context, callback },
  );
  target.dispatchEvent(event);
  return event;
};

describe("space-context", () => {
  describe("provideElementSpace()", () => {
    it("calls a space request's callback with the space provided", () => {
      const target = element();
      provideElementSpace(target, "did:key:space");
      const received: unknown[] = [];

      request(target, SPACE_CONTEXT_KEY, (value: unknown) => {
        received.push(value);
      });
      request(target, "something else", (value: unknown) => {
        received.push(value);
      });

      expect(received).toEqual(["did:key:space"]);
    });

    it("leaves a request that carries no callback to propagate", () => {
      // A provider stops the propagation of a request it takes, so that no
      // provider further up takes it as well. The second request is the
      // control: the same request with a callback is stopped.

      const target = element();
      provideElementSpace(target, "did:key:space");

      const ignored = request(target, SPACE_CONTEXT_KEY, "not a function");
      const taken = request(target, SPACE_CONTEXT_KEY, () => {});

      expect(ignored.cancelBubble).toBe(false);
      expect(taken.cancelBubble).toBe(true);
    });
  });

  describe("providePieceBoundary()", () => {
    it("tells subscribers of a change of piece, and not of the same piece again", () => {
      const target = element();
      providePieceBoundary(target, piece("of:first"));
      const heard: (string | undefined)[] = [];
      const unsubscribe = subscribePieceBoundary(target, (boundary) => {
        heard.push(boundary?.cell.ref().id);
      });

      providePieceBoundary(target, piece("of:first"));
      providePieceBoundary(target, piece("of:second"));
      unsubscribe();
      providePieceBoundary(target, piece("of:third"));

      expect(heard).toEqual(["of:first", "of:second"]);
      expect(getPieceBoundary(target)?.cell.ref().id).toBe("of:third");
    });
  });

  describe("getPieceBoundary()", () => {
    it("finds nothing from a value that cannot dispatch events", () => {
      expect(getPieceBoundary(null)).toBeUndefined();
      expect(getPieceBoundary("text")).toBeUndefined();
      expect(getPieceBoundary({ dispatchEvent: "not a function" }))
        .toBeUndefined();
    });

    it("finds nothing where the boundary is refused", () => {
      const target = element();
      providePieceBoundary(target, piece("of:refused"));

      expect(getPieceBoundary(target, () => false)).toBeUndefined();
      expect(getPieceBoundary(target, () => true)?.cell.ref().id).toBe(
        "of:refused",
      );
    });
  });

  describe("subscribePieceBoundary()", () => {
    it("returns an unsubscribe that does nothing where no boundary is provided", () => {
      const heard: unknown[] = [];

      const unsubscribe = subscribePieceBoundary(element(), (boundary) => {
        heard.push(boundary);
      });

      expect(() => unsubscribe()).not.toThrow();
      expect(heard).toEqual([]);
    });
  });
});
