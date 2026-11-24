import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { readEnv } from "../v2/sqlite/column-origin.ts";

describe("readEnv()", () => {
  // The read a denied `--allow-env` refuses is covered by the subprocess
  // probe in `v2-sqlite-column-origin-subprocess.test.ts`, since this
  // process holds the permission.

  it("returns the variable's value, or `undefined` when it is unset", () => {
    expect(readEnv("PATH")).toBe(Deno.env.get("PATH"));
    expect(readEnv("CF_TEST_READ_ENV_UNSET_VARIABLE")).toBeUndefined();
  });

  it("throws a failure other than a denied read", () => {
    expect(() => readEnv("A=B")).toThrow("Key contains invalid characters");
  });
});
