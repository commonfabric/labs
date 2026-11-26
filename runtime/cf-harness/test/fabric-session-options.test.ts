import { expect } from "@std/expect";

import { resolveHarnessFabricSessionConfig } from "../src/fabric-session-options.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("fabric-session-options", () => {
  describe("resolveHarnessFabricSessionConfig()", () => {
    it("throws for a session flag given only whitespace", () => {
      expect(() =>
        resolveHarnessFabricSessionConfig({ "fabric-space": "  " }, {}, "/")
      ).toThrow("--fabric-space requires a non-empty value");
    });

    it("returns no session when the matching environment variable is only whitespace", () => {
      // A blank environment default reads as unset rather than as an empty
      // value, so it neither configures a session nor throws.
      expect(
        resolveHarnessFabricSessionConfig(
          {},
          { CF_HARNESS_FABRIC_SPACE: "  " },
          "/",
        ),
      ).toBeUndefined();
    });
  });
});
