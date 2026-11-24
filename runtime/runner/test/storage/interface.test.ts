import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  hasSessionReportStorageCapability,
  type ReplicaLoadFailure,
  ReplicaLoadFailureError,
} from "../../src/storage/interface.ts";

const failure: ReplicaLoadFailure = {
  failureClass: "connection",
  recoveryEpoch: "load:1",
  permanentEvidence: false,
};

describe("interface", () => {
  describe("ReplicaLoadFailureError", () => {
    it("takes its message from a plain-object cause's own message", () => {
      // The memory client reports a failed pull as a result object rather than
      // an `Error`, and that object is the cause a failed load hands its
      // waiters.

      const cause = {
        name: "ConnectionError",
        message: "memory client closed",
      };
      const error = new ReplicaLoadFailureError(failure, cause);

      expect(error.message).toBe("memory client closed");
      expect(error.cause).toBe(cause);
    });

    it("takes its message from an `Error` cause", () => {
      const error = new ReplicaLoadFailureError(failure, new Error("refused"));

      expect(error.message).toBe("refused");
    });

    it("returns a cause with no string message as a string", () => {
      expect(new ReplicaLoadFailureError(failure, "refused").message)
        .toBe("refused");
      expect(new ReplicaLoadFailureError(failure, undefined).message)
        .toBe("undefined");
    });
  });

  describe("hasSessionReportStorageCapability()", () => {
    it("returns `true` for a provider with a `sendReport()` method", () => {
      expect(hasSessionReportStorageCapability({ sendReport() {} })).toBe(true);
    });

    it("returns `false` for a provider without a `sendReport()` method", () => {
      expect(hasSessionReportStorageCapability({})).toBe(false);
      expect(hasSessionReportStorageCapability({ sendReport: "report" }))
        .toBe(false);
    });

    it("returns `false` for `null` and `undefined`", () => {
      expect(hasSessionReportStorageCapability(null)).toBe(false);
      expect(hasSessionReportStorageCapability(undefined)).toBe(false);
    });
  });
});
