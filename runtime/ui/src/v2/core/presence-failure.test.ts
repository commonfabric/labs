import { expect } from "@std/expect";

import {
  isPresenceRefusal,
  presenceFailureCategory,
} from "./presence-failure.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("presence-failure", () => {
  describe("presenceFailureCategory()", () => {
    it("maps a relay refusal, an unsupported server, and anything else", () => {
      const refused = new Error("Presence name is empty");
      refused.name = "PresenceError";
      const unsupported = new Error("memory server does not support presence");
      unsupported.name = "ProtocolError";
      expect(presenceFailureCategory(refused)).toBe("protocol");
      expect(presenceFailureCategory(unsupported)).toBe("configuration");
      expect(
        presenceFailureCategory(
          new Error("runtime storage does not support presence"),
        ),
      ).toBe("configuration");
      expect(presenceFailureCategory(new Error("memory session closed"))).toBe(
        "connection",
      );
      const restoring = new Error("session restore was refused");
      restoring.name = "ProtocolError";
      expect(presenceFailureCategory(restoring)).toBe("connection");
      expect(presenceFailureCategory("nope")).toBe("connection");
    });
  });

  describe("isPresenceRefusal()", () => {
    it("returns `true` for a relay's refusal and `false` for anything else", () => {
      const refused = new Error("Presence name is empty");
      refused.name = "PresenceError";
      expect(isPresenceRefusal(refused)).toBe(true);
      const unsupported = new Error("memory server does not support presence");
      unsupported.name = "ProtocolError";
      expect(isPresenceRefusal(unsupported)).toBe(false);
      expect(isPresenceRefusal(new Error("memory session closed"))).toBe(false);
      expect(
        isPresenceRefusal({ name: "PresenceError", message: "not an Error" }),
      ).toBe(false);
    });
  });
});
