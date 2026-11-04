import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { describeThrown } from "../describe-thrown.ts";

describe("describe-thrown", () => {
  describe("describeThrown()", () => {
    it("returns the message of an `Error`", () => {
      expect(describeThrown(new Error("the key store is not open"))).toBe(
        "the key store is not open",
      );
    });

    it("returns the name of an `Error` carrying no message", () => {
      expect(describeThrown(new Error())).toBe("Error");
      expect(describeThrown(new TypeError())).toBe("TypeError");
    });

    it("returns the first line of a page exception's description", () => {
      // The shape the browser protocol reports an uncaught page exception in.
      const pageException = {
        exceptionId: 1,
        text: "Uncaught",
        exception: {
          className: "Error",
          description:
            "Error: the key store is not open\n    at globalThis.app.setIdentity (<anonymous>:3:15)",
        },
      };
      expect(describeThrown(pageException)).toBe(
        "Error: the key store is not open",
      );
    });

    it("renders a value it cannot summarize on one line", () => {
      expect(describeThrown({ exceptionId: 1, text: "Uncaught" })).toBe(
        '{ exceptionId: 1, text: "Uncaught" }',
      );
      expect(describeThrown("a bare string")).toBe('"a bare string"');
      expect(describeThrown(undefined)).toBe("undefined");
      expect(describeThrown(null)).toBe("null");
    });

    it("renders a record whose description is empty", () => {
      expect(describeThrown({ exception: { description: "" } })).toBe(
        "{ exception: [Object] }",
      );
    });

    it("keeps a deeply nested value to one line", () => {
      // A caller that reports a failure it does not own — the page probe inside
      // a state-wait report — attaches someone else's error as the cause, so a
      // summary that deferred to "the cause" would name the wrong failure.

      expect(describeThrown({ a: { b: { c: { d: 1 } } }, list: [1, 2, 3] }))
        .toBe("{ a: [Object], list: [Array] }");
    });
  });
});
