/**
 * This file covers what `sha256-wasm` does before and without a working
 * `hash-wasm`. Nothing here may set the module up except the one case that
 * checks the refusal and then the setup, since a test file runs in an isolate
 * of its own and the other files set the module up before their first case.
 */

import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/bytes/base64url";
import { describe, it } from "@commonfabric/test-support/test";
import {
  addHashers,
  createHasherWasm,
  createHasherWasmCollecting,
  initWasm,
  sha256Wasm,
} from "@/sha256-wasm.ts";

describe("sha256-wasm", () => {
  it("refuses to hash until it is set up, and hashes once it is", async () => {
    const notUsable = "Cannot use `sha256-wasm` in this environment.";
    expect(() => sha256Wasm(new Uint8Array())).toThrow(notUsable);
    expect(() => createHasherWasm()).toThrow(notUsable);
    expect(() => createHasherWasmCollecting()).toThrow(notUsable);

    expect(await initWasm()).toBe(true);

    const emptyHash = fromBase64url(
      "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
    expect(sha256Wasm(new Uint8Array())).toEqual(emptyHash);
    expect(createHasherWasm().digest()).toEqual(emptyHash);
    expect(createHasherWasmCollecting().digest()).toEqual(emptyHash);
  });

  describe("addHashers()", () => {
    it("adds `count` made items after those already present, and reports success", async () => {
      let made = 0;
      const hashers = ["existing"];
      expect(
        await addHashers(hashers, 2, () => Promise.resolve(`made ${++made}`)),
      ).toBe(true);
      expect(hashers).toEqual(["existing", "made 1", "made 2"]);
    });

    it("reports failure once `create` rejects, keeping what it made before", async () => {
      let made = 0;
      const hashers: string[] = [];
      const create = () =>
        ++made > 2
          ? Promise.reject(new Error("`hash-wasm` is not available"))
          : Promise.resolve(`made ${made}`);
      expect(await addHashers(hashers, 4, create)).toBe(false);
      expect(hashers).toEqual(["made 1", "made 2"]);
      expect(made).toBe(3);
    });
  });
});
