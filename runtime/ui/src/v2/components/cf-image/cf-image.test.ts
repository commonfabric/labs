/**
 * Tests for the CFImage component.
 *
 * Imported through index.ts so the guarded custom-element registration there
 * runs as well. The component renders from raw bytes by minting an object URL
 * for a Blob, so the tests drive `_coerceBytes`, the `willUpdate` object-URL
 * lifecycle, `render`, and cleanup directly.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import type { TemplateResult } from "lit";
import { CFImage } from "./index.ts";

/** Access the component's private members for white-box testing. */
interface CFImagePrivateAccess {
  _objectUrl: string | null;
  _revokeObjectUrl: () => void;
  _coerceBytes: (value: unknown) => Uint8Array | null;
}

function asPrivate(element: CFImage): CFImagePrivateAccess {
  return element as unknown as CFImagePrivateAccess;
}

describe("CFImage", () => {
  describe("component definition", () => {
    it("is defined and registered as a custom element", () => {
      expect(CFImage).toBeDefined();
      expect(customElements.get("cf-image")).toBe(CFImage);
    });

    it("creates an instance with empty defaults", () => {
      const element = new CFImage();
      expect(element).toBeInstanceOf(CFImage);
      expect(element.bytes).toBeUndefined();
      expect(element.mediaType).toBe("");
      expect(element.alt).toBe("");
    });
  });

  describe("_coerceBytes", () => {
    it("returns null for null or undefined", () => {
      const priv = asPrivate(new CFImage());
      expect(priv._coerceBytes(null)).toBeNull();
      expect(priv._coerceBytes(undefined)).toBeNull();
    });

    it("copies a Uint8Array into a fresh array", () => {
      const priv = asPrivate(new CFImage());
      const source = new Uint8Array([1, 2, 3]);
      const result = priv._coerceBytes(source);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result!)).toEqual([1, 2, 3]);
      // A copy, not the same backing buffer.
      expect(result).not.toBe(source);
    });

    it("reads a FabricBytes-like value through slice()", () => {
      const priv = asPrivate(new CFImage());
      const fabricLike = {
        slice: () => new Uint8Array([4, 5, 6, 7]),
      };
      const result = priv._coerceBytes(fabricLike);
      expect(Array.from(result!)).toEqual([4, 5, 6, 7]);
    });

    it("falls through to the array strategy when slice() throws", () => {
      const priv = asPrivate(new CFImage());
      // An array whose slice() throws: the catch falls through and the
      // Array.isArray branch reads the elements directly.
      const arr = [8, 9, 10] as unknown as {
        slice: () => unknown;
      };
      arr.slice = () => {
        throw new Error("slice unavailable");
      };
      const result = priv._coerceBytes(arr);
      expect(Array.from(result!)).toEqual([8, 9, 10]);
    });

    it("returns null when slice() throws and nothing else applies", () => {
      const priv = asPrivate(new CFImage());
      const value = {
        slice: () => {
          throw new Error("nope");
        },
      };
      expect(priv._coerceBytes(value)).toBeNull();
    });

    it("reads an array-like value via its numeric length", () => {
      const priv = asPrivate(new CFImage());
      // No slice(), not an Array, but indexable with a numeric length.
      const arrayLike = { 0: 11, 1: 12, length: 2 };
      const result = priv._coerceBytes(arrayLike);
      expect(Array.from(result!)).toEqual([11, 12]);
    });

    it("returns null when array-like reads throw", () => {
      const priv = asPrivate(new CFImage());
      const hostile = {
        length: 1,
        get 0(): number {
          throw new Error("boom");
        },
      };
      expect(priv._coerceBytes(hostile)).toBeNull();
    });

    it("returns null for a value with no usable shape", () => {
      const priv = asPrivate(new CFImage());
      expect(priv._coerceBytes({ foo: "bar" })).toBeNull();
    });
  });

  describe("willUpdate / object URL lifecycle", () => {
    it("mints an object URL when bytes change", () => {
      const element = new CFImage();
      const priv = asPrivate(element);
      element.bytes = new Uint8Array([0, 1, 2, 3]);
      element.mediaType = "image/png";

      element.willUpdate(new Map([["bytes", undefined]]));

      expect(typeof priv._objectUrl).toBe("string");
      expect(priv._objectUrl!.startsWith("blob:")).toBe(true);
    });

    it("revokes a previous object URL before minting a new one", () => {
      const element = new CFImage();
      const priv = asPrivate(element);

      element.bytes = new Uint8Array([1, 2, 3]);
      element.willUpdate(new Map([["bytes", undefined]]));
      const first = priv._objectUrl;
      expect(first).not.toBeNull();

      element.bytes = new Uint8Array([4, 5, 6, 7, 8]);
      element.willUpdate(new Map([["bytes", undefined]]));
      const second = priv._objectUrl;
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
    });

    it("clears the object URL when bytes can't be read", () => {
      const element = new CFImage();
      const priv = asPrivate(element);

      element.bytes = new Uint8Array([1, 2, 3]);
      element.willUpdate(new Map([["bytes", undefined]]));
      expect(priv._objectUrl).not.toBeNull();

      element.bytes = { not: "bytes" };
      element.willUpdate(new Map([["bytes", undefined]]));
      expect(priv._objectUrl).toBeNull();
    });

    it("ignores changes that don't touch bytes or mediaType", () => {
      const element = new CFImage();
      const priv = asPrivate(element);
      element.bytes = new Uint8Array([1, 2, 3]);

      element.willUpdate(new Map([["alt", ""]]));

      expect(priv._objectUrl).toBeNull();
    });
  });

  describe("render", () => {
    it("renders nothing without an object URL", () => {
      const element = new CFImage();
      expect(element.render()).toBeNull();
    });

    it("renders an img once an object URL exists", () => {
      const element = new CFImage();
      element.bytes = new Uint8Array([1, 2, 3]);
      element.mediaType = "image/png";
      element.willUpdate(new Map([["bytes", undefined]]));

      const result = element.render();
      expect(result).not.toBeNull();
    });
  });

  describe("disconnectedCallback", () => {
    it("revokes the object URL on disconnect", () => {
      const element = new CFImage();
      const priv = asPrivate(element);
      element.bytes = new Uint8Array([1, 2, 3]);
      element.willUpdate(new Map([["bytes", undefined]]));
      expect(priv._objectUrl).not.toBeNull();

      element.disconnectedCallback();

      expect(priv._objectUrl).toBeNull();
    });
  });

  describe("blob", () => {
    const SPACE = "did:key:z6Mk-cf-image-blob";

    /** A runtime whose `blobUrl()` answers each call with `answers`' next. */
    const runtimeAnswering = (...answers: Promise<string>[]) => {
      const calls: unknown[] = [];
      return {
        calls,
        runtime: {
          blobUrl: (options: unknown) => {
            calls.push(options);
            return answers.shift()!;
          },
        } as unknown as RuntimeClient,
      };
    };

    /** The `src` the element's render gives its image, if it renders one. */
    const srcOf = (element: CFImage): unknown => {
      const result = element.render();
      return result === null ? null : (result as TemplateResult).values[0];
    };

    it("renders the URL the runtime returns for a blob reference", async () => {
      const answer = Promise.resolve("http://host/space/blobs/abc");
      const { calls, runtime } = runtimeAnswering(answer);
      const element = new CFImage();
      element.runtime = runtime;
      element.blob = { space: SPACE, id: "fid1:abc" };

      element.willUpdate(new Map([["blob", undefined]]));
      await answer;

      expect(calls).toEqual([{ space: SPACE, id: "fid1:abc" }]);
      expect(srcOf(element)).toBe("http://host/space/blobs/abc");
    });

    it("renders the bytes rather than the blob when it has both", async () => {
      const answer = Promise.resolve("http://host/space/blobs/abc");
      const element = new CFImage();
      element.runtime = runtimeAnswering(answer).runtime;
      element.blob = { space: SPACE, id: "fid1:abc" };
      element.bytes = new Uint8Array([1, 2, 3]);

      element.willUpdate(new Map([["blob", undefined], ["bytes", undefined]]));
      await answer;

      expect(srcOf(element)).toBe(asPrivate(element)._objectUrl);
    });

    it("renders nothing for a blob reference that names no space", () => {
      const { calls, runtime } = runtimeAnswering();
      const element = new CFImage();
      element.runtime = runtime;
      element.blob = { space: "not a did", id: "fid1:abc" };

      element.willUpdate(new Map([["blob", undefined]]));

      expect(calls).toEqual([]);
      expect(element.render()).toBeNull();
    });

    it("renders the newer blob's URL when an older one's answer arrives later", async () => {
      let answerFirst!: (url: string) => void;
      const first = new Promise<string>((resolve) => answerFirst = resolve);
      const second = Promise.resolve("http://host/space/blobs/second");
      const element = new CFImage();
      element.runtime = runtimeAnswering(first, second).runtime;

      element.blob = { space: SPACE, id: "fid1:first" };
      element.willUpdate(new Map([["blob", undefined]]));
      element.blob = { space: SPACE, id: "fid1:second" };
      element.willUpdate(new Map([["blob", undefined]]));
      await second;
      answerFirst("http://host/space/blobs/first");
      await first;

      expect(srcOf(element)).toBe("http://host/space/blobs/second");
    });
  });
});
