import { expect } from "@std/expect";
import { createHasher, sha256 } from "@commonfabric/content-hash";
import { describe, it } from "@commonfabric/test-support/test";
import { chooseImplementation } from "@/implementation.ts";
import { denoImplementation } from "@/sha256-deno.ts";
import { createHasherNoble, sha256Noble } from "@/sha256-noble.ts";
import { createHasherWasm, sha256Wasm } from "@/sha256-wasm.ts";

describe("chooseImplementation()", () => {
  const never = () => Promise.reject(new Error("`initWasm()` was called"));

  it("returns the Deno implementation where it is usable, without starting WASM", async () => {
    const deno = { sha256: sha256Noble, createHasher: createHasherNoble };
    expect(await chooseImplementation(deno, never)).toBe(deno);
  });

  it("returns the WASM implementation where Deno's is unusable and WASM starts", async () => {
    expect(
      await chooseImplementation(null, () => Promise.resolve(true)),
    ).toEqual({ sha256: sha256Wasm, createHasher: createHasherWasm });
  });

  it("returns the Noble implementation where neither of the others is available", async () => {
    expect(
      await chooseImplementation(null, () => Promise.resolve(false)),
    ).toEqual({ sha256: sha256Noble, createHasher: createHasherNoble });
  });

  it("is what the package root exports, given this environment", () => {
    expect({ sha256, createHasher }).toEqual(denoImplementation);
  });
});
