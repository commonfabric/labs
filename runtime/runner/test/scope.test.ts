import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { resolveLinkScope } from "../src/scope.ts";

describe("scope", () => {
  describe("resolveLinkScope()", () => {
    it("returns the scope a link names", () => {
      expect(resolveLinkScope("user", "session")).toBe("user");
      expect(resolveLinkScope("space", "session")).toBe("space");
    });

    it("returns the containing scope for a link that inherits or names none", () => {
      expect(resolveLinkScope("inherit", "session")).toBe("session");
      expect(resolveLinkScope(undefined, "user")).toBe("user");
      expect(resolveLinkScope("inherit", undefined)).toBe("space");
    });
  });
});
