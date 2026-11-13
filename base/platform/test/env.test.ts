import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ensureNotRenderThread,
  isBrowser,
  isDeno,
  isWorkerThread,
} from "@commonfabric/platform/env";

// Each scope holds only the globals the predicates feature-test for.
const noop = () => {};
const denoMain = { Deno: { build: {} } };
const denoWorker = { Deno: { build: {} }, close: noop };
const browserMain = { fetch: noop };
const browserWorker = { fetch: noop, importScripts: noop };
// What a browser running `deno-web-test` looks like: a `Deno` shim without
// `Deno.build`.
const browserWithShim = { Deno: {}, fetch: noop };

describe("env", () => {
  describe("isDeno()", () => {
    it("returns `true` for a scope whose `Deno` carries `build`", () => {
      expect(isDeno(denoMain)).toBe(true);
      expect(isDeno(denoWorker)).toBe(true);
    });

    it("returns `false` for a scope without `Deno`, or with a shim lacking `build`", () => {
      expect(isDeno(browserMain)).toBe(false);
      expect(isDeno(browserWithShim)).toBe(false);
    });

    it("returns `true` for the scope these tests run in", () => {
      expect(isDeno()).toBe(true);
    });
  });

  describe("isBrowser()", () => {
    it("returns `true` for a non-Deno scope with `fetch`", () => {
      expect(isBrowser(browserMain)).toBe(true);
      expect(isBrowser(browserWorker)).toBe(true);
      expect(isBrowser(browserWithShim)).toBe(true);
    });

    it("returns `false` for Deno, and for a scope without `fetch`", () => {
      expect(isBrowser(denoMain)).toBe(false);
      expect(isBrowser({})).toBe(false);
      expect(isBrowser()).toBe(false);
    });
  });

  describe("isWorkerThread()", () => {
    it("returns `true` for a Deno worker and for a browser worker", () => {
      expect(isWorkerThread(denoWorker)).toBe(true);
      expect(isWorkerThread(browserWorker)).toBe(true);
    });

    it("returns `false` for either host's main thread", () => {
      expect(isWorkerThread(denoMain)).toBe(false);
      expect(isWorkerThread(browserMain)).toBe(false);
    });
  });

  describe("ensureNotRenderThread()", () => {
    it("throws on a browser's main thread", () => {
      expect(() => ensureNotRenderThread(browserMain)).toThrow(
        "must not run in the browser's main thread",
      );
    });

    it("returns on a browser worker and in Deno", () => {
      expect(() => ensureNotRenderThread(browserWorker)).not.toThrow();
      expect(() => ensureNotRenderThread(denoMain)).not.toThrow();
      expect(() => ensureNotRenderThread()).not.toThrow();
    });
  });
});
