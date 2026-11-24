import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer } from "@commonfabric/async/defer";

describe("defer()", () => {
  it("returns a promise that `resolve()` fulfills with its value", async () => {
    const deferred = defer<number>();
    deferred.resolve(7);

    expect(await deferred.promise).toBe(7);
  });

  it("returns a promise that `reject()` rejects with its value", async () => {
    const deferred = defer<number>();
    const failure = new Error("boom");
    deferred.reject(failure);

    await expect(deferred.promise).rejects.toBe(failure);
  });

  it("returns a promise that stays pending until settled", async () => {
    const deferred = defer<string>();
    const settled = await Promise.race([
      deferred.promise,
      Promise.resolve("still pending"),
    ]);

    expect(settled).toBe("still pending");
  });
});
