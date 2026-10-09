import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CFC_ATOM_TYPE,
  cfcAtom,
  type CfcListPosition,
} from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { createRenderConfidentialityResolver } from "../src/cfc/render-ceiling.ts";
import type { ListMembershipProvider } from "../src/cfc/list-membership.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";

// A standing release to a list (spec §4.9.5, §8.7.5): the output carries the
// owner's module-policy clause and the authored clause
// `[User(owner) ∨ Members(list, subject)]`; the owner's module rule adds the
// same `Members` alternative to the policy clause under the transformation's
// witness, and the display boundary admits whoever the list names.

const OWNER = "did:key:owner";
const DANIEL = "did:key:daniel";
const EVE = "did:key:eve";
const HOME = "did:key:owner-home";
const OTHER_HOME = "did:key:other-home";

const LIVE: CfcListPosition = {
  space: "did:key:share",
  id: "of:live",
  path: ["liveList"],
};
const CURRENT: CfcListPosition = {
  space: "did:key:share",
  id: "of:live",
  path: ["current"],
};

const ceilingFor = (principal: string) => [
  cfcAtom.user(principal),
  cfcAtom.personalSpace(principal),
];

/** A list provider over a mutable map of list → listed principals. */
const listsProvider = (
  viewer: string,
  lists: Map<CfcListPosition, readonly string[]>,
): ListMembershipProvider => ({
  listed: (list) =>
    [...lists].some(([position, principals]) =>
      deepEqual(position, list) && principals.includes(viewer)
    ),
  subscribe: () => () => {},
});

// The owner's module policy: one rule that releases the policy clause to the
// list an authored `Members` atom names for the same subject, once the value
// carries the transformation's witness.
const MODULE = "sha256:location-module";
const SYMBOL = "locationRules";
const WITNESS = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "verified", moduleIdentity: "sha256:location-module" },
  inputWitness: { type: "GPSMeasurement" },
};
const manifest = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: MODULE,
  symbol: SYMBOL,
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseLiveToList",
      preCondition: {
        confidentiality: [{ thisPolicy: true }, {
          type: CFC_ATOM_TYPE.Members,
          list: { var: "$l" },
          subject: { thisPolicyField: "subject" },
        }],
        integrity: [WITNESS],
      },
      preConfScope: "anywhere",
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Members,
          list: { var: "$l" },
          subject: { thisPolicyField: "subject" },
        }],
        integrity: [],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});
const policy = (subject: string) =>
  cfcAtom.modulePolicyRef(MODULE, SYMBOL, manifest.policyDigest, subject);

/** The authored clause the capture check admits for `list`. */
const authored = (list: CfcListPosition, subject = HOME) => ({
  anyOf: [cfcAtom.user(OWNER), cfcAtom.members(list, subject)],
});

const resolveAs = (
  viewer: string,
  lists: Map<CfcListPosition, readonly string[]>,
) =>
  createRenderConfidentialityResolver({
    actingPrincipal: viewer,
    listMembershipProvider: listsProvider(viewer, lists),
    modulePolicyResolver: () => manifest,
  });

describe("CFC render resolver — a Members label (spec §4.9.5)", () => {
  it("admits a listed viewer and not an unlisted one", () => {
    const lists = new Map([[LIVE, [DANIEL]]]);
    const label = { confidentiality: [cfcAtom.members(LIVE, HOME)] };
    expect(
      atomsOutsideCeiling(resolveAs(DANIEL, lists)(label), ceilingFor(DANIEL)),
    ).toEqual([]);
    expect(
      atomsOutsideCeiling(resolveAs(EVE, lists)(label), ceilingFor(EVE)),
    ).not.toEqual([]);
  });

  it("follows a membership change at the next evaluation", () => {
    const lists = new Map<CfcListPosition, readonly string[]>([[LIVE, [
      DANIEL,
    ]]]);
    const resolve = resolveAs(DANIEL, lists);
    const label = { confidentiality: [cfcAtom.members(LIVE, HOME)] };
    expect(atomsOutsideCeiling(resolve(label), ceilingFor(DANIEL))).toEqual([]);
    lists.set(LIVE, []);
    expect(atomsOutsideCeiling(resolve(label), ceilingFor(DANIEL))).not
      .toEqual([]);
  });

  it("mints nothing without a list provider (fail closed)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: DANIEL,
    });
    const label = { confidentiality: [cfcAtom.members(LIVE, HOME)] };
    expect(atomsOutsideCeiling(resolve(label), ceilingFor(DANIEL))).not
      .toEqual([]);
  });
});

describe("CFC render resolver — releasing to a list (spec §8.7.5)", () => {
  const released = (lists: readonly CfcListPosition[], witness = true) => ({
    confidentiality: [policy(HOME), ...lists.map((list) => authored(list))],
    integrity: witness ? [WITNESS] : [],
  });

  it("releases the owner's clause to a listed viewer", () => {
    const lists = new Map([[LIVE, [DANIEL]]]);
    expect(
      atomsOutsideCeiling(
        resolveAs(DANIEL, lists)(released([LIVE])),
        ceilingFor(DANIEL),
      ),
    ).toEqual([]);
  });

  it("keeps the owner's clause sealed from an unlisted viewer", () => {
    const lists = new Map([[LIVE, [DANIEL]]]);
    expect(
      atomsOutsideCeiling(
        resolveAs(EVE, lists)(released([LIVE])),
        ceilingFor(EVE),
      ),
    ).not.toEqual([]);
  });

  it("releases nothing without the transformation's witness", () => {
    const lists = new Map([[LIVE, [DANIEL]]]);
    expect(
      atomsOutsideCeiling(
        resolveAs(DANIEL, lists)(released([LIVE], false)),
        ceilingFor(DANIEL),
      ),
    ).toContainEqual(policy(HOME));
  });

  it("requires a viewer on every list when two are named (intersection)", () => {
    const lists = new Map<CfcListPosition, readonly string[]>([
      [LIVE, [DANIEL]],
      [CURRENT, [DANIEL, EVE]],
    ]);
    const label = released([LIVE, CURRENT]);
    expect(
      atomsOutsideCeiling(resolveAs(DANIEL, lists)(label), ceilingFor(DANIEL)),
    ).toEqual([]);
    expect(
      atomsOutsideCeiling(resolveAs(EVE, lists)(label), ceilingFor(EVE)),
    ).not.toEqual([]);
  });

  it("does not rebind a list authored for another subject", () => {
    const lists = new Map([[LIVE, [DANIEL]]]);
    const label = {
      confidentiality: [policy(HOME), authored(LIVE, OTHER_HOME)],
      integrity: [WITNESS],
    };
    expect(
      atomsOutsideCeiling(resolveAs(DANIEL, lists)(label), ceilingFor(DANIEL)),
    ).toContainEqual(policy(HOME));
  });

  it("keeps the owner on her own output whatever the list holds", () => {
    const lists = new Map<CfcListPosition, readonly string[]>([[LIVE, []]]);
    const resolved = resolveAs(OWNER, lists)({
      confidentiality: [authored(LIVE)],
    });
    expect(atomsOutsideCeiling(resolved, ceilingFor(OWNER))).toEqual([]);
  });
});
