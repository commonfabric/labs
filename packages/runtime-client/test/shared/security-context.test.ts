import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import type { CfcConfClause } from "@commonfabric/runner/cfc";

import type { RuntimeSecurityContext } from "@/protocol/mod.ts";
import {
  normalizeOrigin,
  normalizeSpaceHostMap,
  securityContextDifferences,
} from "@/shared/security-context.ts";

const signerDid = "did:key:z6Mk-security-context-signer" as DID;

describe("securityContextDifferences()", () => {
  // A runtime is one signer under one enforcement configuration, and an
  // attach states which it believes it is joining. What this returns is
  // what an attach is refused by name for.

  const running: RuntimeSecurityContext = {
    identity: signerDid,
    spaceDid: signerDid,
    apiUrl: "http://runtime.test/",
    spaceHostMap: { [signerDid]: "http://memory.test/" },
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
    cfcReadMaxConfidentiality: [signerDid, { anyOf: ["a", "b"] }],
    cfcReadOnExceed: "skip",
    renderDeclassificationPolicy: "deny",
    renderConfidentialityCeiling: { atoms: [], caveatKinds: ["influence"] },
    trustSnapshot: { id: `principal:${signerDid}` },
  };

  it("returns an empty list for the same context", () => {
    expect(securityContextDifferences({ ...running }, running)).toEqual([]);
  });

  it("returns an empty list when a field is absent on one side and `undefined` on the other", () => {
    // The two contexts are built in different documents and one of them
    // crossed an encoding, so these are the same posture.
    const asserted = { ...running, experimental: undefined };
    expect(securityContextDifferences(asserted, running)).toEqual([]);
  });

  it("reads the same read ceiling with its alternatives reordered as the same posture", () => {
    // Two documents spelling one ceiling: the clause order and the order
    // of an `anyOf`'s alternatives are not posture, so an attach that
    // respells them is not refused.
    const asserted = {
      ...running,
      cfcReadMaxConfidentiality: [{ anyOf: ["b", "a"] }, signerDid],
    };
    expect(securityContextDifferences(asserted, running)).toEqual([]);
  });

  it("keeps a malformed OR-shaped object opaque, as the runner does", () => {
    // `{ anyOf: [A], extra: 1 }` is not an OR clause to the runner; it is an
    // opaque atom, so it is not the same posture as `[A]`.
    const asserted = {
      ...running,
      cfcReadMaxConfidentiality: [
        signerDid,
        { anyOf: ["a", "b"], extra: 1 } as unknown as CfcConfClause,
      ],
    };
    expect(securityContextDifferences(asserted, running)).toEqual([
      "cfcReadMaxConfidentiality",
    ]);
  });

  it("names the read ceiling when an alternative differs", () => {
    const asserted = {
      ...running,
      cfcReadMaxConfidentiality: [signerDid, { anyOf: ["a", "c"] }],
    };
    expect(securityContextDifferences(asserted, running)).toEqual([
      "cfcReadMaxConfidentiality",
    ]);
  });

  it("names the backend when it differs", () => {
    expect(
      securityContextDifferences(
        { ...running, apiUrl: "http://elsewhere.test/" },
        running,
      ),
    ).toEqual(["apiUrl"]);
  });

  it("names the per-space host map when it differs", () => {
    expect(
      securityContextDifferences(
        { ...running, spaceHostMap: { [signerDid]: "http://o.test/" } },
        running,
      ),
    ).toEqual(["spaceHostMap"]);
  });

  it("names the acting principal when it differs", () => {
    expect(
      securityContextDifferences(
        { ...running, identity: "did:key:z6Mk-someone-else" as DID },
        running,
      ),
    ).toEqual(["identity"]);
  });

  it("names the trust configuration when it differs", () => {
    // A runtime evaluates concept guards under one trust configuration, so a
    // document believing another would read a trusted declassifier as trusted
    // where the runtime does not, or the reverse.
    expect(
      securityContextDifferences(
        {
          ...running,
          cfcTrustConfig: {
            delegations: [{
              delegator: "*",
              verifier: "did:web:review.example",
              concepts: ["https://commonfabric.org/cfc/concepts/example"],
            }],
          },
        },
        running,
      ),
    ).toEqual(["cfcTrustConfig"]);
  });

  it("reads one trust configuration spelled two ways as the same posture", () => {
    // The runtime holds the configuration it normalized, so key order, a key
    // spelled out as `undefined`, and an empty list written out or left out
    // are not posture.
    const delegation = {
      delegator: "*",
      verifier: "did:web:review.example",
      concepts: ["https://commonfabric.org/cfc/concepts/example"],
    };
    const statement = {
      concrete: { type: "Policy", policyDigest: "sha256:example" },
      implements: "https://commonfabric.org/cfc/concepts/example",
      verifier: "did:web:review.example",
    };
    expect(
      securityContextDifferences(
        {
          ...running,
          cfcTrustConfig: {
            delegations: [{
              concepts: delegation.concepts,
              verifier: delegation.verifier,
              delegator: delegation.delegator,
            }],
            statements: [{
              verifier: statement.verifier,
              implements: statement.implements,
              concrete: {
                policyDigest: statement.concrete.policyDigest,
                type: statement.concrete.type,
              },
            }],
            conceptEdges: undefined,
          },
        },
        {
          ...running,
          cfcTrustConfig: {
            statements: [statement],
            delegations: [delegation],
            conceptEdges: [],
          },
        },
      ),
    ).toEqual([]);
  });

  it("names the trust configuration when one statement differs", () => {
    const config = (verifier: string) => ({
      statements: [{
        concrete: { type: "Policy", policyDigest: "sha256:example" },
        implements: "https://commonfabric.org/cfc/concepts/example",
        verifier,
      }],
    });
    expect(
      securityContextDifferences(
        { ...running, cfcTrustConfig: config("did:web:other.example") },
        { ...running, cfcTrustConfig: config("did:web:review.example") },
      ),
    ).toEqual(["cfcTrustConfig"]);
  });

  it("names a trust configuration the runtime could not have booted with", () => {
    // A malformed configuration normalizes to nothing, and it is not the
    // posture of a runtime that booted, whatever that runtime holds.
    expect(
      securityContextDifferences(
        {
          ...running,
          cfcTrustConfig: { statements: "all" } as never,
        },
        running,
      ),
    ).toEqual(["cfcTrustConfig"]);
  });

  it("names the enforcement mode when it differs", () => {
    expect(
      securityContextDifferences(
        { ...running, cfcEnforcementMode: "observe" },
        running,
      ),
    ).toEqual(["cfcEnforcementMode"]);
  });

  it("names a ceiling that differs deep inside", () => {
    expect(
      securityContextDifferences(
        {
          ...running,
          renderConfidentialityCeiling: {
            atoms: [],
            caveatKinds: ["influence", "and-one-more"],
          },
        },
        running,
      ),
    ).toEqual(["renderConfidentialityCeiling"]);
  });

  it("names a read ceiling that differs by one clause", () => {
    expect(
      securityContextDifferences(
        { ...running, cfcReadMaxConfidentiality: [signerDid] },
        running,
      ),
    ).toEqual(["cfcReadMaxConfidentiality"]);
  });

  it("names an absent field the running context declares", () => {
    const { trustSnapshot: _dropped, ...asserted } = running;
    expect(securityContextDifferences(asserted, running)).toEqual([
      "trustSnapshot",
    ]);
  });

  it("names every differing field, in a fixed order", () => {
    expect(
      securityContextDifferences({
        ...running,
        identity: "did:key:z6Mk-someone-else" as DID,
        cfcFlowLabels: "off",
      }, running),
    ).toEqual(["cfcFlowLabels", "identity"]);
  });
});

describe("normalizeOrigin()", () => {
  it("returns one spelling for an origin written two ways", () => {
    expect(normalizeOrigin("http://memory.test")).toBe(
      normalizeOrigin("http://memory.test/"),
    );
  });

  it("returns one spelling for a default port written out", () => {
    expect(normalizeOrigin("http://memory.test:80/")).toBe(
      normalizeOrigin("http://memory.test/"),
    );
  });

  it("returns an unparseable value unchanged", () => {
    expect(normalizeOrigin("not a url")).toBe("not a url");
  });
});

describe("normalizeSpaceHostMap()", () => {
  it("returns `undefined` for an absent map", () => {
    expect(normalizeSpaceHostMap(undefined)).toBeUndefined();
  });

  it("returns `undefined` for an empty map, which is the same posture", () => {
    expect(normalizeSpaceHostMap({})).toBeUndefined();
  });

  it("returns one spelling for each origin it holds", () => {
    expect(normalizeSpaceHostMap({ [signerDid]: "http://memory.test" }))
      .toEqual(normalizeSpaceHostMap({ [signerDid]: "http://memory.test/" }));
  });
});

describe("a context normalized on both sides", () => {
  // The spurious refusal this exists to prevent: one document builds its
  // context from a `URL` and the other from the string an initialization
  // carried, and the two spell one backend differently.

  it("agrees when one side wrote the backend without a trailing slash", () => {
    const asserted: RuntimeSecurityContext = {
      identity: signerDid,
      spaceDid: signerDid,
      apiUrl: normalizeOrigin(new URL("http://backend.test").toString()),
    };
    const running: RuntimeSecurityContext = {
      identity: signerDid,
      spaceDid: signerDid,
      apiUrl: normalizeOrigin("http://backend.test"),
    };
    expect(securityContextDifferences(asserted, running)).toEqual([]);
  });

  it("agrees when one side carries no host map and the other an empty one", () => {
    const base: RuntimeSecurityContext = {
      identity: signerDid,
      spaceDid: signerDid,
      apiUrl: normalizeOrigin("http://backend.test"),
    };
    expect(securityContextDifferences(
      { ...base, spaceHostMap: normalizeSpaceHostMap({}) },
      { ...base, spaceHostMap: normalizeSpaceHostMap(undefined) },
    )).toEqual([]);
  });
});
