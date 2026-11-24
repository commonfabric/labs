import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { plaidErrorFrom } from "./plaid-oauth.error.ts";

describe("plaid-oauth.error", () => {
  describe("plaidErrorFrom()", () => {
    it("returns the error document an SDK rejection carries", () => {
      const document = {
        error_message: "the item is no longer valid",
        error_code: "ITEM_LOGIN_REQUIRED",
        error_type: "ITEM_ERROR",
        display_message: "Please sign in again",
      };

      expect(plaidErrorFrom({ response: { data: document } })).toBe(document);
    });

    it("returns `undefined` for a thrown value that is not an object", () => {
      expect(plaidErrorFrom(new Error("boom").message)).toBe(undefined);
      expect(plaidErrorFrom(undefined)).toBe(undefined);
      expect(plaidErrorFrom(null)).toBe(undefined);
    });

    it("returns `undefined` for a transport failure with no response", () => {
      expect(plaidErrorFrom(new Error("connection reset"))).toBe(undefined);
      expect(plaidErrorFrom({ response: undefined })).toBe(undefined);
    });

    it("returns `undefined` for a response carrying no document", () => {
      expect(plaidErrorFrom({ response: {} })).toBe(undefined);
      expect(plaidErrorFrom({ response: { data: null } })).toBe(undefined);
      expect(plaidErrorFrom({ response: { data: "" } })).toBe(undefined);
    });

    it("returns `undefined` for an array in either position", () => {
      expect(plaidErrorFrom([])).toBe(undefined);
      expect(plaidErrorFrom({ response: [] })).toBe(undefined);
    });
  });
});
