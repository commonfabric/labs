/**
 * The two questions a byte holder has to answer before it can promise
 * anything about the bytes it was handed: whether the buffer underneath has
 * been detached, and how to obtain an array it is allowed to rely on.
 *
 * `toOwnedUint8Array()` is where the promise is actually made, so its cases
 * are about what a caller may still do to the source afterwards. A holder
 * that skips it is holding a view someone else can mutate or transfer away.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isDetached, toOwnedUint8Array } from "@commonfabric/utils/buffers";

describe("buffers", () => {
  describe("isDetached()", () => {
    it("returns `false` for a live buffer", () => {
      expect(isDetached(new ArrayBuffer(8))).toBe(false);
    });

    it("returns `false` for a view onto a live buffer", () => {
      const buffer = new ArrayBuffer(8);
      expect(isDetached(new Uint8Array(buffer))).toBe(false);
      expect(isDetached(new Uint8Array(buffer, 2, 3))).toBe(false);
      expect(isDetached(new DataView(buffer))).toBe(false);
    });

    it("returns `true` for a detached buffer", () => {
      const buffer = new ArrayBuffer(8);
      buffer.transfer();
      expect(isDetached(buffer)).toBe(true);
    });

    it("returns `true` for a view onto a detached buffer", () => {
      const buffer = new ArrayBuffer(8);
      const view = new Uint8Array(buffer);
      buffer.transfer();
      expect(isDetached(view)).toBe(true);
    });

    it("returns `false` for a `SharedArrayBuffer`, which cannot detach", () => {
      // The direct `.detached` read is `undefined` here, not `false`, so this
      // pins the coercion rather than leaving it to luck.
      const buffer = new SharedArrayBuffer(8);
      expect(isDetached(buffer)).toBe(false);
      expect(isDetached(new Uint8Array(buffer))).toBe(false);
    });
  });

  describe("toOwnedUint8Array()", () => {
    it("returns an array with the same contents, without `transfer`", () => {
      const source = new Uint8Array([1, 2, 3]);
      expect(toOwnedUint8Array(source, false)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("returns an array with the same contents, with `transfer`", () => {
      const source = new Uint8Array([1, 2, 3]);
      expect(toOwnedUint8Array(source, true)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("returns an exact-sized buffer, whichever path it takes", () => {
      // Load-bearing beyond sole ownership: a caller reaching past the view
      // to the buffer -- to transfer it, say -- must get exactly these bytes.
      // Both a window onto a larger buffer (copied) and a whole-buffer source
      // (taken over) have to come back exact-sized.
      const window = new Uint8Array(new ArrayBuffer(16), 4, 3);
      window.set([1, 2, 3]);

      for (
        const [label, source, transfer] of [
          ["window, copied", window, false],
          ["window, transfer requested", window, true],
          ["whole buffer, copied", new Uint8Array([1, 2, 3]), false],
          ["whole buffer, taken over", new Uint8Array([1, 2, 3]), true],
        ] as [string, Uint8Array, boolean][]
      ) {
        const result = toOwnedUint8Array(source, transfer);

        expect(`${label}: ${result.byteOffset}`).toBe(`${label}: 0`);
        expect(`${label}: ${result.buffer.byteLength}`).toBe(`${label}: 3`);
      }
    });

    it("returns an empty array for an empty source", () => {
      expect(toOwnedUint8Array(new Uint8Array(), true).length).toBe(0);
      expect(toOwnedUint8Array(new Uint8Array(), false).length).toBe(0);
    });

    it("leaves the source usable, without `transfer`", () => {
      const source = new Uint8Array([1, 2, 3]);
      const result = toOwnedUint8Array(source, false);

      expect(isDetached(source)).toBe(false);
      source[0] = 99;
      expect(result[0]).toBe(1);
    });

    it("detaches the source buffer, with `transfer` on a whole-buffer view", () => {
      const source = new Uint8Array([1, 2, 3]);
      const result = toOwnedUint8Array(source, true);

      expect(isDetached(source)).toBe(true);
      expect(source.length).toBe(0);
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(isDetached(result)).toBe(false);
    });

    it("copies rather than detaching, for a source that is a partial view", () => {
      const buffer = new ArrayBuffer(8);
      const whole = new Uint8Array(buffer);
      whole.set([1, 2, 3, 4, 5, 6, 7, 8]);
      const source = new Uint8Array(buffer, 2, 3);

      const result = toOwnedUint8Array(source, true);

      expect(result).toEqual(new Uint8Array([3, 4, 5]));
      expect(buffer.detached).toBe(false);
      // The bytes outside the source's window are still readable.
      expect(whole[0]).toBe(1);
      expect(whole[7]).toBe(8);
      // And the result no longer shares storage with them.
      whole[2] = 99;
      expect(result[0]).toBe(3);
    });

    it("copies rather than detaching, for a source whose view starts at `0` but is short", () => {
      const buffer = new ArrayBuffer(8);
      const source = new Uint8Array(buffer, 0, 3);
      source.set([1, 2, 3]);

      const result = toOwnedUint8Array(source, true);

      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(buffer.detached).toBe(false);
    });

    it("copies rather than detaching, for a `SharedArrayBuffer`-backed source", () => {
      const buffer = new SharedArrayBuffer(3);
      const source = new Uint8Array(buffer);
      source.set([1, 2, 3]);

      const result = toOwnedUint8Array(source, true);

      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(result.buffer).not.toBe(buffer);
      // The result no longer shares storage with the original.
      source[0] = 99;
      expect(result[0]).toBe(1);
    });

    it("throws for an already-detached source", () => {
      const source = new Uint8Array([1, 2, 3]);
      (source.buffer as ArrayBuffer).transfer();

      expect(() => toOwnedUint8Array(source, true)).toThrow(TypeError);
      expect(() => toOwnedUint8Array(source, false)).toThrow(TypeError);
    });

    it("returns an array with the same contents, for a buffer source", () => {
      const source = Uint8Array.from([1, 2, 3]).buffer;

      expect(toOwnedUint8Array(source, false)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("leaves a buffer source usable, without `transfer`", () => {
      const source = Uint8Array.from([1, 2, 3]).buffer;
      const result = toOwnedUint8Array(source, false);

      expect(isDetached(source)).toBe(false);
      new Uint8Array(source)[0] = 99;
      expect(result[0]).toBe(1);
    });

    it("detaches a buffer source, with `transfer`", () => {
      const source = Uint8Array.from([1, 2, 3]).buffer;
      const result = toOwnedUint8Array(source, true);

      expect(isDetached(source)).toBe(true);
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(isDetached(result)).toBe(false);
    });

    it("copies rather than detaching, for a `SharedArrayBuffer` source", () => {
      const source = new SharedArrayBuffer(3);
      new Uint8Array(source).set([1, 2, 3]);

      const result = toOwnedUint8Array(source, true);

      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(result.buffer).not.toBe(source);
      new Uint8Array(source)[0] = 99;
      expect(result[0]).toBe(1);
    });

    it("throws for a ceded buffer that holds a detach key", () => {
      // A `WebAssembly.Memory` buffer is live, undetached, and covers itself
      // whole, so it reaches the take-over and `transfer()` refuses it. There
      // is no readable property that tells it from a plain `ArrayBuffer`,
      // which is why this surfaces rather than falling back to a copy.
      const source = new WebAssembly.Memory({ initial: 1 }).buffer;

      expect(isDetached(source)).toBe(false);
      expect(() => toOwnedUint8Array(source, true)).toThrow(TypeError);
    });

    it("copies a buffer that holds a detach key, without `transfer`", () => {
      const source = new WebAssembly.Memory({ initial: 1 }).buffer;
      new Uint8Array(source)[0] = 7;

      const result = toOwnedUint8Array(source, false);

      expect(result.byteLength).toBe(source.byteLength);
      expect(result[0]).toBe(7);
      expect(result.buffer).not.toBe(source);
    });

    it("throws for an already-detached buffer source", () => {
      const source = new ArrayBuffer(3);
      source.transfer();

      expect(() => toOwnedUint8Array(source, true)).toThrow(TypeError);
      expect(() => toOwnedUint8Array(source, false)).toThrow(TypeError);
    });
  });
});
