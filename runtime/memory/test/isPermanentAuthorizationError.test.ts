import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isPermanentAuthorizationError } from "../v2/client.ts";

/** An error named `name`, carrying `fields` besides. */
function named(name: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("refused"), { name, ...fields });
}

describe("isPermanentAuthorizationError()", () => {
  it("returns `true` for an `AuthorizationError` with no `retriable` mark", () => {
    expect(isPermanentAuthorizationError(named("AuthorizationError"))).toBe(
      true,
    );
  });

  it("returns `false` for an `AuthorizationError` marked `retriable`", () => {
    expect(
      isPermanentAuthorizationError(
        named("AuthorizationError", { retriable: true }),
      ),
    ).toBe(false);
  });

  it("returns `false` for an error of another name", () => {
    expect(isPermanentAuthorizationError(named("ConnectionError"))).toBe(
      false,
    );
  });

  it("returns `false` for a non-`Error` carrying the name", () => {
    expect(isPermanentAuthorizationError({ name: "AuthorizationError" }))
      .toBe(false);
  });
});
