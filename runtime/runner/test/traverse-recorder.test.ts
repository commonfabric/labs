/**
 * The recorder behind traverse capture.
 *
 * It exists to turn a run's traversals into a replayable fixture, so what it
 * owes is a faithful record: every invocation in order, each doc snapshotted
 * once, repeated selectors and links shared rather than copied, and a bound on
 * how much one run may accumulate.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";

import {
  fixtureDocKey,
  TraverseCaptureRecorder,
} from "../src/traverse-recorder.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import type { SchemaPathSelector } from "../src/traverse.ts";

const SPACE = "did:key:zTraverse" as IMemorySpaceAddress["space"];

function address(
  id: string,
  path: string[] = [],
  extra: { type?: string; scope?: string } = {},
): IMemorySpaceAddress {
  return {
    space: SPACE,
    id: id as IMemorySpaceAddress["id"],
    path,
    ...extra,
  } as IMemorySpaceAddress;
}

const selector = (path: string[]): SchemaPathSelector =>
  ({ path, schemaContext: undefined }) as unknown as SchemaPathSelector;

describe("traverse-recorder", () => {
  describe("fixtureDocKey", () => {
    it("fills in the default scope and type", () => {
      expect(fixtureDocKey({ space: "s", id: "of:x" })).toBe(
        "s|space|of:x|application/json",
      );
    });

    it("keeps a scope and type the address carries", () => {
      expect(
        fixtureDocKey({
          space: "s",
          id: "of:x",
          scope: "user",
          type: "text/plain",
        }),
      ).toBe("s|user|of:x|text/plain");
    });

    it("separates two docs that differ only in scope", () => {
      const a = fixtureDocKey({ space: "s", id: "of:x", scope: "space" });
      const b = fixtureDocKey({ space: "s", id: "of:x", scope: "user" });
      expect(a).not.toBe(b);
    });
  });

  describe("recordInvocation", () => {
    it("records an invocation with its address, selector and `traverseCells` flag", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:doc", ["a"]) },
        selector(["a"]),
        undefined,
        { traverseCells: true },
        undefined,
      );

      const fixture = recorder.toFixture("name", "source");
      expect(fixture.invocations.length).toBe(1);
      const only = fixture.invocations[0];
      expect(only.address.id).toBe("of:doc");
      expect(only.address.path).toEqual(["a"]);
      expect(only.address.type).toBe("application/json");
      expect(only.traverseCells).toBe(true);
    });

    it("records `inlineArrayItemsInPlace` for a context that sets it", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:doc", ["a"]) },
        selector(["a"]),
        undefined,
        { traverseCells: true, inlineArrayItemsInPlace: true },
        undefined,
      );

      const [only] = recorder.toFixture("name", "source").invocations;
      expect(only.inlineArrayItemsInPlace).toBe(true);
    });

    it("leaves `inlineArrayItemsInPlace` out for a context that does not set it", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:doc", ["a"]) },
        selector(["a"]),
        undefined,
        { traverseCells: true, inlineArrayItemsInPlace: false },
        undefined,
      );

      const [only] = recorder.toFixture("name", "source").invocations;
      expect("inlineArrayItemsInPlace" in only).toBe(false);
    });

    it("copies the address path rather than aliasing the caller's", () => {
      const recorder = new TraverseCaptureRecorder();
      const path = ["a"];
      recorder.recordInvocation(
        { address: address("of:doc", path) },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );
      path.push("mutated");

      expect(recorder.toFixture("n", "s").invocations[0].address.path).toEqual(
        ["a"],
      );
    });

    it("gives one context object one id across invocations", () => {
      const recorder = new TraverseCaptureRecorder();
      const context = { traverseCells: false };
      for (let i = 0; i < 3; i++) {
        recorder.recordInvocation(
          { address: address(`of:doc${i}`) },
          selector(["a"]),
          undefined,
          context,
          undefined,
        );
      }

      const ids = recorder.toFixture("n", "s").invocations.map((i) =>
        i.context
      );
      expect(new Set(ids).size).toBe(1);
    });

    it("gives distinct context objects distinct ids", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:a") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );
      recorder.recordInvocation(
        { address: address("of:b") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );

      const ids = recorder.toFixture("n", "s").invocations.map((i) =>
        i.context
      );
      expect(new Set(ids).size).toBe(2);
    });

    it("records a memo only when the traversal had one", () => {
      const recorder = new TraverseCaptureRecorder();
      recorder.recordInvocation(
        { address: address("of:with") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        {},
      );
      recorder.recordInvocation(
        { address: address("of:without") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );

      const [withMemo, withoutMemo] = recorder.toFixture("n", "s").invocations;
      expect(withMemo.memo).not.toBe(undefined);
      expect("memo" in withoutMemo).toBe(false);
    });

    it("records a link only when the traversal followed one", () => {
      const recorder = new TraverseCaptureRecorder();
      const link = {
        space: SPACE,
        id: "of:target",
        path: [],
      } as unknown as NormalizedFullLink;
      recorder.recordInvocation(
        { address: address("of:doc") },
        selector(["a"]),
        link,
        { traverseCells: false },
        undefined,
      );
      recorder.recordInvocation(
        { address: address("of:doc2") },
        selector(["a"]),
        undefined,
        { traverseCells: false },
        undefined,
      );

      const [followed, plain] = recorder.toFixture("n", "s").invocations;
      expect(followed.link).not.toBe(undefined);
      expect("link" in plain).toBe(false);
    });

    it("stops recording at the cap and keeps what it already had", () => {
      const recorder = new TraverseCaptureRecorder(2);
      for (let i = 0; i < 5; i++) {
        recorder.recordInvocation(
          { address: address(`of:doc${i}`) },
          selector(["a"]),
          undefined,
          { traverseCells: false },
          undefined,
        );
      }

      const fixture = recorder.toFixture("n", "s");
      expect(fixture.invocations.length).toBe(2);
      expect(fixture.invocations.map((i) => i.address.id)).toEqual([
        "of:doc0",
        "of:doc1",
      ]);
    });
  });

  describe("toFixture", () => {
    it("carries the name and source it is given, and when it captured", () => {
      const fixture = new TraverseCaptureRecorder().toFixture("fx", "src.ts");
      expect(fixture.meta.name).toBe("fx");
      expect(fixture.meta.source).toBe("src.ts");
      expect(typeof fixture.meta.capturedAt).toBe("string");
      expect(fixture.version).toBe(2);
    });

    it("describes a run that traversed nothing", () => {
      const fixture = new TraverseCaptureRecorder().toFixture("fx", "src.ts");
      expect(fixture.invocations).toEqual([]);
    });
  });
});
