import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";

import { isExactModulePolicyRef } from "../../src/cfc/policy.ts";

const FIELDS = {
  type: CFC_ATOM_TYPE.Policy,
  policyRefKind: "module",
  moduleIdentity: "sha256:module",
  symbol: "releaseRules",
  policyDigest: "sha256:digest",
  subject: "did:key:z6MkSubject",
};

describe("isExactModulePolicyRef()", () => {
  // Each refused atom has six own keys, as many as an exact reference, with
  // one field inherited in place of an own one.

  it("returns `false` for an inherited field beside an unknown own key", () => {
    const { subject, ...rest } = FIELDS;
    expect(isExactModulePolicyRef({ ...FIELDS })).toBe(true);
    expect(
      isExactModulePolicyRef(
        Object.assign(Object.create({ subject }), rest, { extra: 1 }),
      ),
    ).toBe(false);
  });

  it("returns `false` for an inherited field beside a symbol-keyed own property", () => {
    const { subject, ...rest } = FIELDS;
    expect(
      isExactModulePolicyRef(
        Object.assign(Object.create({ subject }), rest, {
          [Symbol("extra")]: 1,
        }),
      ),
    ).toBe(false);
  });
});
