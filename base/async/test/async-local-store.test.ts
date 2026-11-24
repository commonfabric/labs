import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FallbackAsyncLocalStore } from "@commonfabric/async/async-local-store";

describe("FallbackAsyncLocalStore", () => {
  describe("instance members", () => {
    describe("getStore()", () => {
      it("returns `undefined` outside any `run()`", () => {
        expect(new FallbackAsyncLocalStore<string>().getStore())
          .toBeUndefined();
      });
    });

    describe("run()", () => {
      it("binds the value for a synchronous call, returns its result, and restores the previous value", () => {
        const store = new FallbackAsyncLocalStore<string>();
        const result = store.run("outer", () => {
          const inner = store.run("inner", () => store.getStore());
          return [inner, store.getStore()];
        });

        expect(result).toEqual(["inner", "outer"]);
        expect(store.getStore()).toBeUndefined();
      });

      it("restores the previous value when the call throws, and rethrows", () => {
        const store = new FallbackAsyncLocalStore<string>();
        const failure = new Error("boom");

        expect(() =>
          store.run("value", () => {
            throw failure;
          })
        ).toThrow(failure);
        expect(store.getStore()).toBeUndefined();
      });

      it("keeps the value bound until a returned promise settles, then restores it", async () => {
        const store = new FallbackAsyncLocalStore<string>();
        const { promise, resolve } = Promise.withResolvers<string>();

        const result = store.run("pending", () => promise);
        expect(store.getStore()).toBe("pending");

        resolve("done");
        expect(await result).toBe("done");
        expect(store.getStore()).toBeUndefined();
      });

      it("restores the previous value when a returned promise rejects", async () => {
        const store = new FallbackAsyncLocalStore<string>();
        const failure = new Error("boom");

        await expect(
          store.run("pending", () => Promise.reject(failure)),
        ).rejects.toBe(failure);
        expect(store.getStore()).toBeUndefined();
      });
    });
  });
});
