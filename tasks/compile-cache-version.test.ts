import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  bakeVersionModule,
  VERSION_MODULE_PATH,
} from "./compile-cache-version.ts";
import {
  renderVersionModule,
  VERSION_NAMESPACE,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

describe("compile-cache-version", () => {
  describe("bakeVersionModule()", () => {
    let root: string;

    beforeEach(async () => {
      root = await Deno.makeTempDir({ prefix: "compile-cache-bake-" });
      await Deno.mkdir(join(root, VERSION_MODULE_PATH, ".."), {
        recursive: true,
      });
    });

    afterEach(async () => {
      await Deno.remove(root, { recursive: true });
    });

    it("writes the version module a binary build writes for that version", async () => {
      const version = `${VERSION_NAMESPACE}/baked-output`;

      await bakeVersionModule(root, version);

      expect(await Deno.readTextFile(join(root, VERSION_MODULE_PATH))).toBe(
        renderVersionModule(version),
      );
    });
  });
});
