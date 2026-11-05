import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Address from "../src/storage/transaction/address.ts";

// The identity address strings resolve scoped addresses against
// (key-vocabulary.md §1 site 8). Space-scoped addresses ignore it.
const TEST_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

describe("Address Module", () => {
  describe("toString function", () => {
    it("should convert address with empty path to string", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const result = Address.toString(address, TEST_IDENTITY);

      expect(result).toBe("/space/user:1/[]");
    });

    it("should convert address with single path element to string", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const result = Address.toString(address, TEST_IDENTITY);

      expect(result).toBe('/space/user:1/["profile"]');
    });

    it("should convert address with nested path to string", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const result = Address.toString(address, TEST_IDENTITY);

      expect(result).toBe(
        '/space/user:1/["profile","settings","theme"]',
      );
    });

    it("should handle address with numeric path elements", () => {
      const address = {
        id: "array:1",
        type: "application/json",
        path: ["items", "0", "name"],
      } as const;

      const result = Address.toString(address, TEST_IDENTITY);

      expect(result).toBe('/space/array:1/["items","0","name"]');
    });

    it("should handle address with special characters in id", () => {
      const address = {
        id: "user:special-chars_123",
        type: "application/json",
        path: ["data"],
      } as const;

      const result = Address.toString(address, TEST_IDENTITY);

      expect(result).toBe(
        '/space/user:special-chars_123/["data"]',
      );
    });

    it("should ignore type when stringifying document addresses", () => {
      const address = {
        id: "document:1",
        type: "text/plain",
        path: ["metadata", "title"],
      } as const;

      const result = Address.toString(address, TEST_IDENTITY);

      expect(result).toBe('/space/document:1/["metadata","title"]');
    });

    it("keys scoped addresses per INSTANCE via the shared scope_key vocabulary (stage E)", () => {
      // key-vocabulary.md §1 site 8: the scope segment is the scope_key
      // resolved against the acting identity — never the scope NAME.
      const userAddress = {
        id: "user:1",
        type: "application/json",
        scope: "user",
        path: [],
      } as const;
      const sessionAddress = {
        id: "user:1",
        type: "application/json",
        scope: "session",
        path: [],
      } as const;

      expect(Address.toString(userAddress, TEST_IDENTITY)).toBe(
        "/user:did%3Atest%3Aalice/user:1/[]",
      );
      expect(Address.toString(sessionAddress, TEST_IDENTITY)).toBe(
        "/session:did%3Atest%3Aalice:session-1/user:1/[]",
      );
      // Two identities' instances of one address never collapse.
      expect(Address.toString(userAddress, TEST_IDENTITY)).not.toBe(
        Address.toString(userAddress, {
          principal: "did:test:bob",
          sessionId: "session-2",
        }),
      );
    });
  });

  describe("includes function", () => {
    it("should return true when source includes candidate (source is parent)", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(true);
    });

    it("should return true when source includes candidate (partial path)", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(true);
    });

    it("should return true when candidate is same as source", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.includes(address, address);

      expect(result).toBe(true);
    });

    it("should return false when source does not include candidate", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when addresses have different ids", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:2",
        type: "application/json",
        path: ["profile"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should ignore type when checking inclusion", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "text/plain",
        path: ["profile", "name"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(true);
    });

    it("should return false when paths are completely different", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["settings"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when paths share prefix but are not parent-child", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "email"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should handle array index paths correctly", () => {
      const source = {
        id: "list:1",
        type: "application/json",
        path: ["items", "0"],
      } as const;

      const candidate = {
        id: "list:1",
        type: "application/json",
        path: ["items", "0", "name"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(true);
    });

    it("should handle numeric path prefix matching", () => {
      const source = {
        id: "list:1",
        type: "application/json",
        path: ["items", "1"],
      } as const;

      const candidate = {
        id: "list:1",
        type: "application/json",
        path: ["items", "10"],
      } as const;

      const result = Address.includes(source, candidate);

      // "items/10" starts with "items/1", but they are not really the same!
      expect(result).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle addresses with empty paths consistently", () => {
      const address1 = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const address2 = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      expect(Address.toString(address1, TEST_IDENTITY)).toBe(
        "/space/user:1/[]",
      );
      expect(Address.includes(address1, address2)).toBe(true);
    });

    it("should handle addresses with complex ids", () => {
      const address = {
        id: "namespace:complex-id-with-dashes_and_underscores.123",
        type: "application/vnd.api+json",
        path: ["data", "attributes", "nested-property"],
      } as const;

      const result = Address.toString(address, TEST_IDENTITY);

      expect(result).toBe(
        '/space/namespace:complex-id-with-dashes_and_underscores.123/["data","attributes","nested-property"]',
      );
    });

    it("should handle path elements that could confuse string operations", () => {
      const source = {
        id: "test:1",
        type: "application/json",
        path: ["path"],
      } as const;

      const candidate = {
        id: "test:1",
        type: "application/json",
        path: ["path", "path/with/slashes"],
      } as const;

      // Even though the path element contains slashes, the function should work correctly
      expect(Address.includes(source, candidate)).toBe(true);
    });

    it("should handle numeric strings in paths with prefix matching", () => {
      const source = {
        id: "test:1",
        type: "application/json",
        path: ["items", "12"],
      } as const;

      const candidate = {
        id: "test:1",
        type: "application/json",
        path: ["items", "123"],
      } as const;

      // "items/123" starts with "items/12", but they are not really the same!
      expect(Address.includes(source, candidate)).toBe(false);
    });
  });
});
