import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import {
  buildCfcPolicyArtifactManifest,
  type PolicyArtifactManifestV1,
} from "../src/cfc/policy.ts";
import { evaluateExchangeRules } from "../src/cfc/exchange-eval.ts";
import {
  commitCfcFieldValue,
  transformCfcLabelForCrossSpacePersist,
} from "../src/cfc/label-representation.ts";

const MODULE = "sha256:module";
const SYMBOL = "releaseRules";
const ALICE_SPACE = "did:key:alice-space";
const BOB_SPACE = "did:key:bob-space";
const REVIEWER = "did:key:reviewer";

const artifact: PolicyArtifactManifestV1 = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: MODULE,
  symbol: SYMBOL,
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseToReviewer",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: CFC_ATOM_TYPE.HasRole,
          principal: { var: "$reviewer" },
          space: { thisPolicyField: "subject" },
          role: "reader",
        }],
      },
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$reviewer" },
        }],
        integrity: [],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

const ref = (subject: string) =>
  cfcAtom.modulePolicyRef(
    MODULE,
    SYMBOL,
    artifact.policyDigest,
    subject,
  );

const resolver = () => artifact;

// A policy that blesses one function of its own defining module: the rule
// names the function by symbol and reaches the module through THIS_POLICY.
const blessingArtifact = (moduleIdentity: string) =>
  buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity,
    symbol: SYMBOL,
    template: {
      templateVersion: 1,
      exchangeRules: [{
        name: "releaseTally",
        preCondition: {
          confidentiality: [{ thisPolicy: true }],
          integrity: [{
            type: CFC_ATOM_TYPE.TransformedBy,
            identity: {
              kind: "verified",
              moduleIdentity: { thisPolicyField: "moduleIdentity" },
              symbol: "tally",
            },
          }],
        },
        postCondition: { confidentiality: [], integrity: [] },
      }],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });

const transformedBy = (moduleIdentity: string, symbol: string) => ({
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: {
    kind: "verified",
    moduleIdentity,
    symbol,
    codeHash: "fid1:code",
  },
});

describe("module-policy exchange evaluation", () => {
  it("resolves only a selected manifest and releases its home clause", () => {
    let calls = 0;
    const selected = ref(ALICE_SPACE);
    const result = evaluateExchangeRules(
      { confidentiality: [selected] },
      undefined,
      {
        modulePolicyResolver: () => {
          calls++;
          return artifact;
        },
        integrity: [cfcAtom.hasRole(REVIEWER, ALICE_SPACE, "reader")],
      },
    );
    expect(calls).toBe(1);
    expect(result.resolutionFailures).toEqual([]);
    expect(result.label.confidentiality).toEqual([{
      anyOf: [selected, cfcAtom.user(REVIEWER)],
    }]);
  });

  it("keeps wrong-subject evidence closed and sibling clauses untouched", () => {
    const aliceRef = ref(ALICE_SPACE);
    const bobRef = ref(BOB_SPACE);
    const sibling = cfcAtom.user("did:key:unrelated");
    const result = evaluateExchangeRules(
      { confidentiality: [aliceRef, bobRef, sibling] },
      undefined,
      {
        modulePolicyResolver: resolver,
        integrity: [cfcAtom.hasRole(REVIEWER, ALICE_SPACE, "reader")],
      },
    );
    expect(result.label.confidentiality).toEqual([
      { anyOf: [aliceRef, cfcAtom.user(REVIEWER)] },
      bobRef,
      sibling,
    ]);
  });

  it("matches plaintext evidence after the selected subject is committed", () => {
    const persisted = transformCfcLabelForCrossSpacePersist({
      confidentiality: [ref(ALICE_SPACE)],
    });
    const result = evaluateExchangeRules(persisted, undefined, {
      modulePolicyResolver: resolver,
      integrity: [cfcAtom.hasRole(REVIEWER, ALICE_SPACE, "reader")],
    });
    expect(result.firings).toHaveLength(1);
    expect(result.label.confidentiality?.[0]).toEqual({
      anyOf: [
        {
          ...ref(ALICE_SPACE),
          subject: commitCfcFieldValue(ALICE_SPACE),
        },
        cfcAtom.user(REVIEWER),
      ],
    });
  });

  it("fails closed on a missing resolver or missing manifest", () => {
    const label = { confidentiality: [ref(ALICE_SPACE)] };
    for (
      const context of [
        {},
        { modulePolicyResolver: () => undefined },
      ]
    ) {
      const result = evaluateExchangeRules(label, undefined, context);
      expect(result.label).toBe(label);
      expect(result.firings).toEqual([]);
      expect(result.resolutionFailures).toHaveLength(1);
    }
  });

  it("fails closed on a manifest pair or digest mismatch", () => {
    const label = { confidentiality: [ref(ALICE_SPACE)] };
    const wrongPair = buildCfcPolicyArtifactManifest({
      ...artifact.manifest,
      symbol: "otherRules",
    });
    const wrongDigest = { ...artifact, policyDigest: "sha256:wrong" };
    const resolverError = evaluateExchangeRules(label, undefined, {
      modulePolicyResolver: () => {
        throw new Error("resolver failed");
      },
    });
    expect(resolverError.resolutionFailures[0]?.reason).toBe("resolver-error");

    for (
      const [resolved, reason] of [
        [wrongPair, "reference-mismatch"],
        [wrongDigest, "invalid-manifest"],
      ] as const
    ) {
      const result = evaluateExchangeRules(label, undefined, {
        modulePolicyResolver: () => resolved,
      });
      expect(result.label).toBe(label);
      expect(result.resolutionFailures).toHaveLength(1);
      expect(result.resolutionFailures[0]?.reason).toBe(reason);
    }
  });

  it("rejects ambiguous module references that mix named fields", () => {
    const ambiguous = {
      ...ref(ALICE_SPACE),
      name: "legacy",
      hash: "sha256:legacy",
    };
    const label = { confidentiality: [ambiguous] };
    const result = evaluateExchangeRules(label, undefined, {
      modulePolicyResolver: resolver,
    });
    expect(result.label).toBe(label);
    expect(result.resolutionFailures).toHaveLength(1);
  });

  it("binds THIS_POLICY.moduleIdentity to the selected policy's module", () => {
    const blessing = blessingArtifact(MODULE);
    const selected = cfcAtom.modulePolicyRef(
      MODULE,
      SYMBOL,
      blessing.policyDigest,
      ALICE_SPACE,
    );
    const release = (evidence: ReturnType<typeof transformedBy>) =>
      evaluateExchangeRules({ confidentiality: [selected] }, undefined, {
        modulePolicyResolver: () => blessing,
        integrity: [evidence],
      });

    const released = release(transformedBy(MODULE, "tally"));
    expect(released.resolutionFailures).toEqual([]);
    expect(released.firings).toHaveLength(1);
    expect(released.label.confidentiality).toEqual([]);

    const otherSymbol = release(transformedBy(MODULE, "echo"));
    expect(otherSymbol.firings).toEqual([]);
    expect(otherSymbol.label.confidentiality).toEqual([selected]);

    const otherModule = release(transformedBy("sha256:edited", "tally"));
    expect(otherModule.firings).toEqual([]);
    expect(otherModule.label.confidentiality).toEqual([selected]);
  });

  it("rejects malformed module-reference candidates", () => {
    const malformed = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: "",
      symbol: "rules",
      policyDigest: "sha256:manifest",
      subject: ALICE_SPACE,
    };
    const result = evaluateExchangeRules(
      { confidentiality: [malformed] },
      undefined,
      { modulePolicyResolver: resolver },
    );
    expect(result.resolutionFailures[0]?.reason).toBe("malformed-reference");
  });
});
