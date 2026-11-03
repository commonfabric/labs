import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { describeFailure } from "@commonfabric/js-values/describe-failure";

const UNDESCRIBABLE = "error could not be converted to text";

describe("describe-failure", () => {
  describe("describeFailure()", () => {
    it("returns an `Error`'s message", () => {
      expect(describeFailure(new Error("boom"))).toBe("boom");
      expect(describeFailure(new TypeError("bad type"))).toBe("bad type");
    });

    it("returns the message of a plain record that carries one", () => {
      expect(describeFailure({
        name: "AuthorizationError",
        message: "session refused by the memory server",
      })).toBe("session refused by the memory server");
    });

    it("returns the message of a function that carries one", () => {
      const thrown = Object.assign(() => {}, { message: "callable refusal" });
      expect(describeFailure(thrown)).toBe("callable refusal");
    });

    it("returns the text of a value that has no `message`", () => {
      expect(describeFailure("plain")).toBe("plain");
      expect(describeFailure(42)).toBe("42");
      expect(describeFailure(undefined)).toBe("undefined");
      expect(describeFailure(null)).toBe("null");
      expect(describeFailure({ toString: () => "custom" })).toBe("custom");
    });

    it("returns the fixed sentence for a value that refuses conversion", () => {
      // `String()` reaches for `toString` and `valueOf`; an object made with
      // `Object.create(null)` has neither to find.

      expect(describeFailure(Object.create(null))).toBe(UNDESCRIBABLE);
      expect(describeFailure({
        toString: () => {
          throw new Error("no");
        },
      })).toBe(UNDESCRIBABLE);
    });

    it("returns the fixed sentence when reading the message throws", () => {
      const hostile = new Error("unreachable");
      Object.defineProperty(hostile, "message", {
        get() {
          throw new Error("no message for you");
        },
      });
      expect(describeFailure(hostile)).toBe(UNDESCRIBABLE);
    });

    it("returns the fixed sentence for a proxy that throws when read", () => {
      expect(describeFailure(
        new Proxy({}, {
          has() {
            throw new Error("no");
          },
        }),
      )).toBe(UNDESCRIBABLE);
    });

    it("returns the fixed sentence for a `message` that is not a string", () => {
      expect(describeFailure(
        Object.assign(new Error("x"), { message: { not: "a string" } }),
      )).toBe(UNDESCRIBABLE);
      expect(describeFailure({ message: 7 })).toBe(UNDESCRIBABLE);
    });
  });
});
