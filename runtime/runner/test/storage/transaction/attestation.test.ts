import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { MemorySpace } from "../../../src/storage/interface.ts";
import {
  InvalidDataURIError,
  StateInconsistency,
  UnsupportedMediaTypeError,
} from "../../../src/storage/transaction/attestation.ts";

const space: MemorySpace = "did:key:z6Mk-attestation";

describe("attestation", () => {
  describe("InvalidDataURIError()", () => {
    it("returns an error whose `from()` returns the error itself, the space being absent from its message", () => {
      const error = InvalidDataURIError("bad payload");
      expect(error.from(space)).toBe(error);
      expect(error.message).toBe("bad payload");
    });
  });

  describe("UnsupportedMediaTypeError()", () => {
    it("returns an error whose `from()` returns the error itself, the space being absent from its message", () => {
      const error = UnsupportedMediaTypeError("text/plain is unsupported");
      expect(error.from(space)).toBe(error);
      expect(error.message).toBe("text/plain is unsupported");
    });
  });

  describe("StateInconsistency()", () => {
    it("returns an error whose `from()` names the space in the message and keeps the rest", () => {
      const address = {
        id: "of:doc",
        type: "application/json",
        path: ["value", "n"],
      } as const;
      const error = StateInconsistency({ address, expected: 1, actual: 2 });
      expect(error.message).not.toContain(space);

      const located = error.from(space);
      expect(located.name).toBe("StorageTransactionInconsistent");
      expect(located.address).toBe(address);
      expect(located.message).toBe(
        error.message.replace(
          `at "value.n"`,
          `at "value.n" in space "${space}"`,
        ),
      );
    });
  });
});
