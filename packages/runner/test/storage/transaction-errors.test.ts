import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  TransactionAborted,
  transactionFailureMessage,
} from "../../src/storage/transaction-errors.ts";

describe("transaction-errors", () => {
  describe("transactionFailureMessage()", () => {
    it("returns the message of the reason an aborted transaction carries", () => {
      expect(
        transactionFailureMessage(TransactionAborted(new Error("thrown"))),
      ).toBe("thrown");
    });

    it("returns the reason of a reason that is itself an aborted transaction's error", () => {
      expect(
        transactionFailureMessage(
          TransactionAborted(TransactionAborted(new Error("nested"))),
        ),
      ).toBe("nested");
    });

    it("returns a reason that is a string as it is", () => {
      expect(transactionFailureMessage(TransactionAborted("refused"))).toBe(
        "refused",
      );
    });

    it("returns a message that names its cause, whatever reason the error carries", () => {
      expect(transactionFailureMessage({
        name: "StorageTransactionAborted",
        message: "event abandoned before it committed: refused",
        reason: new Error("refused"),
      })).toBe("event abandoned before it committed: refused");
    });

    it("returns an aborted transaction's own message when it carries no reason", () => {
      expect(transactionFailureMessage(TransactionAborted())).toBe(
        "Transaction was aborted",
      );
    });

    it("returns a rendering of an error with neither message nor reason", () => {
      expect(transactionFailureMessage({ name: "Opaque" })).toContain(
        "Opaque",
      );
    });
  });
});
