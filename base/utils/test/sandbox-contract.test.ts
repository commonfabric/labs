import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isTrustedBuilder,
  isTrustedDataHelper,
  TRUSTED_BUILDERS,
  TRUSTED_DATA_HELPERS,
} from "@commonfabric/utils/sandbox-contract";

describe("sandbox-contract", () => {
  it("exports the shared trusted builder names", () => {
    expect([...TRUSTED_BUILDERS]).toEqual([
      "action",
      "computed",
      "derive",
      "handler",
      "lift",
      "multiUserTest",
      "pattern",
    ]);
  });

  it("freezes the public trusted builder list", () => {
    expect(Object.isFrozen(TRUSTED_BUILDERS)).toBe(true);
    expect(() => {
      (TRUSTED_BUILDERS as unknown as string[]).push("unsafeBuilder");
    }).toThrow(TypeError);
  });

  it("matches trusted builders through a predicate helper", () => {
    expect(isTrustedBuilder("handler")).toBe(true);
    expect(isTrustedBuilder("unsafeBuilder")).toBe(false);
  });

  it("exports the shared trusted data helper names", () => {
    expect([...TRUSTED_DATA_HELPERS]).toEqual([
      "schema",
      "__cf_data",
    ]);
  });

  it("freezes the public trusted data helper list", () => {
    expect(Object.isFrozen(TRUSTED_DATA_HELPERS)).toBe(true);
    expect(() => {
      (TRUSTED_DATA_HELPERS as unknown as string[]).push("unsafeHelper");
    }).toThrow(TypeError);
  });

  it("matches trusted data helpers through a predicate helper", () => {
    expect(isTrustedDataHelper("__cf_data")).toBe(true);
    expect(isTrustedDataHelper("unsafeHelper")).toBe(false);
  });
});
