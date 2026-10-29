/**
 * This file covers the one-shot `sha256()` entry point, across every
 * implementation and over the same fixtures the incremental hasher tests use.
 * Sharing the corpus is the point: a divergence between the one-shot and
 * incremental paths, or between two implementations, surfaces as a failing
 * fixture rather than as a hash nobody can reproduce.
 */

import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/utils/base64url";
import { sha256 } from "@commonfabric/content-hash";
import { sha256Deno } from "@/sha256-deno.ts";
import { sha256Noble } from "@/sha256-noble.ts";
import { initWasm, sha256Wasm } from "@/sha256-wasm.ts";
import { FIXTURES } from "./fixtures.ts";

const sha256Funcs = [
  sha256Deno,
  sha256Noble,
  sha256Wasm,
] as const;

beforeAll(async () => {
  if (!await initWasm()) {
    throw new Error("`sha256-wasm` not available!");
  }
});

describe("sha256()", () => {
  it("is one of the implementation functions", () => {
    const found = sha256Funcs.indexOf(sha256);
    expect(found).not.toBe(-1);
  });
});

for (const shaFunc of sha256Funcs) {
  describe(`${shaFunc.name}()`, () => {
    let i = 1;
    for (const { bytes, sha256: hashStr } of FIXTURES) {
      const hashMsg = `\`${hashStr.slice(0, 8)}...\``;
      const hashBytes = fromBase64url(hashStr);
      it(`produces the expected byte-array hash #${i++}: ${hashMsg}`, () => {
        const got = shaFunc(bytes);
        expect(got).toEqual(hashBytes);
      });
    }
  });
}
