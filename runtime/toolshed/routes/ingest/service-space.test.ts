import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { serviceSpaceFrom } from "./service-space.ts";

const configured = (await Identity.fromPassphrase("service-space configured"))
  .did();
const fallback = (await Identity.fromPassphrase("service-space fallback"))
  .did();

describe("service-space", () => {
  describe("serviceSpaceFrom()", () => {
    it("returns the fallback for a blank setting", () => {
      expect(serviceSpaceFrom("", fallback)).toBe(fallback);
      expect(serviceSpaceFrom("  ", fallback)).toBe(fallback);
    });

    it("returns the configured space DID, trimmed", () => {
      expect(serviceSpaceFrom(` ${configured}\n`, fallback)).toBe(configured);
    });

    it("throws for a setting that is not a space DID", () => {
      expect(() => serviceSpaceFrom("not-a-did", fallback)).toThrow(
        "`INGEST_SERVICE_SPACE` is not a space DID.",
      );
    });
  });
});
