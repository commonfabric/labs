import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import {
  createRenderConfidentialityResolver,
  RENDER_DISPLAY_SINK_CLASS,
} from "../src/cfc/render-ceiling.ts";
import type { SpaceMembershipProvider } from "../src/cfc/space-membership.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";

// Epic H3b (docs/history/plans/cfc-future-work-implementation.md §7): the display-sink
// render ceiling resolves §15.2 principal shapes via exchange rules
// (spec §8.10.6 — "ordinary exchange-rule evaluation runs before the fit
// check"; §4.3.3 SpaceReaderAccess; §4.9.3 HasRole membership facts). The
// resolver runs RUNNER-side; the reconciler consumes the resolved label and
// fits it clause-subsumption-wise (§8.10.3) against the ceiling.

const ALICE = "did:key:alice";
const MALLORY = "did:key:mallory";
const SPACE_TEAM = "did:key:team-space";
const SPACE_OTHER = "did:key:other-space";

const userAlice = cfcAtom.user(ALICE);
const personalSpaceAlice = cfcAtom.personalSpace(ALICE);

// The §8.10.6 default display ceiling for Alice: her identity + personal-space
// principal forms. Space principals are admitted via verified HasRole
// exchange, never listed statically.
const aliceCeiling = [userAlice, personalSpaceAlice];

describe("CFC render confidentiality resolver (H3b)", () => {
  it("resolves nothing but admits a direct User(actingUser) label (test 1)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    const resolved = resolve({ confidentiality: [userAlice] });
    // Post-resolution the acting user's own identity atom fits the User ceiling.
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("admits PersonalSpace(actingUser) directly, no rule needed", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    const resolved = resolve({ confidentiality: [personalSpaceAlice] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("resolves a Space atom through a declared reader role (test 2)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      // §4.9.3: Alice's verified reader membership in the team space.
      memberSpaces: [SPACE_TEAM],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    // Space(team) gained a User(alice) alternative and now fits the ceiling.
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("does NOT mint a reader fact from cell residency alone (fail-closed)", () => {
    // Residency is not read authority: a cell tagged Space(team) that is merely
    // resident in the acting user's runtime (e.g. synced under an ACL-off
    // deployment) must NOT resolve. HasRole facts come only from the verified
    // member set (§4.9.3), never inferred from the cell's storage space.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_TEAM),
    ]);
  });

  it("resolves the acting user's own space (a verified reader space)", () => {
    // A principal definitionally reads its own space (space DID == principal
    // DID), independent of deployment ACL mode — so the own space is always a
    // sound verified member fact.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(ALICE)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("leaves an unresolvable Space atom outside the ceiling (test 3, fail-closed)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [SPACE_TEAM],
    });
    // Data claims a space Alice is NOT a verified reader of.
    const resolved = resolve({
      confidentiality: [cfcAtom.space(SPACE_OTHER)],
    });
    const offending = atomsOutsideCeiling(resolved, aliceCeiling);
    expect(offending).toEqual([cfcAtom.space(SPACE_OTHER)]);
  });

  it("does not resolve a Space atom for a different principal's role", () => {
    // The membership fact names Alice; the acting principal is Alice, so a role
    // belonging to Mallory cannot admit the data even if supplied.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: MALLORY,
      memberSpaces: [SPACE_TEAM],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    // The clause gains a User(mallory) alternative — outside Alice's ceiling —
    // so it stays blocked at the fit check (one offending clause).
    const offending = atomsOutsideCeiling(resolved, aliceCeiling);
    expect(offending.length).toBe(1);
    expect(atomsOutsideCeiling(resolved, [cfcAtom.user(MALLORY)])).toEqual([]);
  });

  it('mints a display-class boundary context (sinkClass:"display")', () => {
    // The display sink class is the render sibling of B5's network class.
    expect(RENDER_DISPLAY_SINK_CLASS).toBe("display");
  });

  it("returns the label unchanged when it carries no confidentiality", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    expect(resolve({ confidentiality: [] })).toEqual([]);
  });

  it("mints no role facts without an acting principal (fail-closed)", () => {
    // No acting principal → no HasRole facts can be minted for any member
    // space, so a Space label cannot resolve.
    const resolve = createRenderConfidentialityResolver({
      memberSpaces: [SPACE_TEAM],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_TEAM),
    ]);
  });
});

// §4.9.3 per-label membership discovery: instead of a static member set, the
// resolver mints HasRole facts PER-LABEL from the Space atoms present in the
// label, consulting a SpaceMembershipProvider (the ACL-doc-backed lookup).
const providerGranting = (
  grantedSpaces: readonly string[],
): SpaceMembershipProvider => ({
  readerRole: (space) => grantedSpaces.includes(space) ? "reader" : null,
  subscribe: () => () => {},
});

describe("CFC render resolver — per-label membership discovery (§4.9.3)", () => {
  it("resolves a Space label the provider verifies the acting user reads", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("blocks a Space label the provider does not grant (fail-closed)", () => {
    // The provider grants nothing for SPACE_OTHER — residency/an unsynced ACL
    // mints no fact, so the clause stays outside the ceiling.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_OTHER)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_OTHER),
    ]);
  });

  it("§4.9.4 conjunctive: admits iff EVERY Space clause resolves", () => {
    // A value carrying two Space atoms gets an independent verified fact per
    // space; both must resolve for the value to fit.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    // Only TEAM granted: OTHER stays offending.
    const partial = resolve({
      confidentiality: [cfcAtom.space(SPACE_TEAM), cfcAtom.space(SPACE_OTHER)],
    });
    expect(atomsOutsideCeiling(partial, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_OTHER),
    ]);
    // Both granted: the whole conjunction fits.
    const resolveBoth = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM, SPACE_OTHER]),
    });
    const both = resolveBoth({
      confidentiality: [cfcAtom.space(SPACE_TEAM), cfcAtom.space(SPACE_OTHER)],
    });
    expect(atomsOutsideCeiling(both, aliceCeiling)).toEqual([]);
  });

  it("combines the static fast-path member set with per-label discovery", () => {
    // Own space stays a static fast-path member (no ACL read); a cross-space
    // Space atom is discovered per-label via the provider.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    const resolved = resolve({
      confidentiality: [cfcAtom.space(ALICE), cfcAtom.space(SPACE_TEAM)],
    });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("does not consult the provider for a space in the static fast path", () => {
    // The own/session fast path needs no ACL read; the provider must not be
    // asked about spaces already trusted statically.
    const consulted: string[] = [];
    const provider: SpaceMembershipProvider = {
      readerRole: (space) => {
        consulted.push(space);
        return null;
      },
      subscribe: () => () => {},
    };
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      membershipProvider: provider,
    });
    resolve({ confidentiality: [cfcAtom.space(ALICE)] });
    expect(consulted).not.toContain(ALICE);
  });

  it("discovers Space atoms nested inside an anyOf clause", () => {
    // §4.3.4 multi-binding: a disjunctive clause offers one access path per
    // role held; the provider is consulted for Space atoms inside anyOf too.
    const consulted: string[] = [];
    const provider: SpaceMembershipProvider = {
      readerRole: (space) => {
        consulted.push(space);
        return space === SPACE_TEAM ? "reader" : null;
      },
      subscribe: () => () => {},
    };
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: provider,
    });
    resolve({
      confidentiality: [{
        anyOf: [cfcAtom.space(SPACE_TEAM), cfcAtom.user(MALLORY)],
      }],
    });
    expect(consulted).toContain(SPACE_TEAM);
  });
});

// A module policy selected by a `PolicyOf` label: its manifest's exchange rule
// releases the sealed clause to the readers of the policy's subject space by
// adding `Space(THIS_POLICY.subject)` once the label carries the release
// evidence. The standard display rule then admits a reader of that space.
const RELEASE_MODULE = "sha256:release-module";
const RELEASE_SYMBOL = "releaseToMembers";
const releaseManifest = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: RELEASE_MODULE,
  symbol: RELEASE_SYMBOL,
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseWhenTallied",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: "TallyComplete",
          space: { thisPolicyField: "subject" },
        }],
      },
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Space,
          id: { thisPolicyField: "subject" },
        }],
        integrity: [],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});
const releaseRef = (subject: string) =>
  cfcAtom.modulePolicyRef(
    RELEASE_MODULE,
    RELEASE_SYMBOL,
    releaseManifest.policyDigest,
    subject,
  );
const tallied = (space: string) => ({ type: "TallyComplete", space });

describe("CFC render resolver — module policies at the display boundary", () => {
  it("releases a PolicyOf label whose module rule admits space readers", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [SPACE_TEAM],
      modulePolicyResolver: () => releaseManifest,
    });
    const resolved = resolve({
      confidentiality: [releaseRef(SPACE_TEAM)],
      integrity: [tallied(SPACE_TEAM)],
    });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("keeps the label sealed when the module rule's guard is unmet", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [SPACE_TEAM],
      modulePolicyResolver: () => releaseManifest,
    });
    const resolved = resolve({ confidentiality: [releaseRef(SPACE_TEAM)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
      releaseRef(SPACE_TEAM),
    ]);
  });

  it("keeps the label sealed for a viewer who reads no released space", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [SPACE_OTHER],
      modulePolicyResolver: () => releaseManifest,
    });
    const resolved = resolve({
      confidentiality: [releaseRef(SPACE_TEAM)],
      integrity: [tallied(SPACE_TEAM)],
    });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([{
      anyOf: [releaseRef(SPACE_TEAM), cfcAtom.space(SPACE_TEAM)],
    }]);
  });

  it("fails closed when the manifest is missing, mismatched, or unresolvable", () => {
    const otherManifest = buildCfcPolicyArtifactManifest({
      ...releaseManifest.manifest,
      symbol: "otherRules",
    });
    for (
      const modulePolicyResolver of [
        undefined,
        () => undefined,
        () => otherManifest,
        () => ({ ...releaseManifest, policyDigest: "sha256:forged" }),
        () => {
          throw new Error("manifest store unavailable");
        },
      ]
    ) {
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: ALICE,
        memberSpaces: [SPACE_TEAM],
        modulePolicyResolver,
      });
      const label = [releaseRef(SPACE_TEAM)];
      const resolved = resolve({
        confidentiality: label,
        integrity: [tallied(SPACE_TEAM)],
      });
      expect(resolved).toEqual(label);
    }
  });

  it("mints a reader fact for a Space atom a module rule adds", () => {
    // The label carries no Space atom until the module rule fires, so the
    // membership lookup can only learn of the released space from the
    // evaluation itself.
    const consulted: string[] = [];
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: {
        readerRole: (space) => {
          consulted.push(space);
          return space === SPACE_TEAM ? "reader" : null;
        },
        subscribe: () => () => {},
      },
      modulePolicyResolver: () => releaseManifest,
    });
    const resolved = resolve({
      confidentiality: [releaseRef(SPACE_TEAM)],
      integrity: [tallied(SPACE_TEAM)],
    });
    expect(consulted).toEqual([SPACE_TEAM]);
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("does not admit an added Space atom the viewer cannot read", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_OTHER]),
      modulePolicyResolver: () => releaseManifest,
    });
    const resolved = resolve({
      confidentiality: [releaseRef(SPACE_TEAM)],
      integrity: [tallied(SPACE_TEAM)],
    });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([{
      anyOf: [releaseRef(SPACE_TEAM), cfcAtom.space(SPACE_TEAM)],
    }]);
  });
});

// The manifest `packages/patterns/cfc-exchange-rules/direct-release.tsx`
// compiles `directReleaseRules` to: a holder of `HasRole(reader)` on the
// policy's subject space gains a `User(reader)` alternative. Its digest is the
// one that pattern's baseline pins, so these tests exercise the rule the shell
// actually renders rather than a look-alike.
const DIRECT_RELEASE_DIGEST = "jr6me2Bb11h2h9txejm-Vjp-5-YPtlpKsLaGcjSR4Sk";
const directReleaseManifest = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "UsUHkONMerVZwnUOIBrbzrUlhEfaV0SByvpFqW28WLg",
  symbol: "directReleaseRules",
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseToSpaceReader",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: CFC_ATOM_TYPE.HasRole,
          principal: { var: "reader" },
          space: { thisPolicyField: "subject" },
          role: "reader",
        }],
      },
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "reader" },
        }],
        integrity: [],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});
const directReleaseRef = (subject: string) =>
  cfcAtom.modulePolicyRef(
    directReleaseManifest.manifest.moduleIdentity,
    directReleaseManifest.manifest.symbol,
    directReleaseManifest.policyDigest,
    subject,
  );

describe("CFC render resolver — the direct-release PolicyOf rule", () => {
  it("builds the manifest direct-release.tsx pins", () => {
    expect(directReleaseManifest.policyDigest).toEqual(DIRECT_RELEASE_DIGEST);
  });

  it("releases the owner's own-space PolicyOf value to the owner", () => {
    // The label carries no Space atom and no integrity: the only way to fit
    // the ceiling is the module rule firing on the minted own-space role.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      modulePolicyResolver: () => directReleaseManifest,
    });
    expect(atomsOutsideCeiling(
      resolve({ confidentiality: [directReleaseRef(ALICE)] }),
      aliceCeiling,
    )).toEqual([]);
  });

  it("releases a shared-space PolicyOf value to a verified reader of that space", () => {
    // The subject space is neither static nor named by a Space atom, so its
    // membership is known only by asking the provider about the policy's
    // subject.
    const consulted: string[] = [];
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      membershipProvider: {
        readerRole: (space) => {
          consulted.push(space);
          return space === SPACE_TEAM ? "reader" : null;
        },
        subscribe: () => () => {},
      },
      modulePolicyResolver: () => directReleaseManifest,
    });
    expect(atomsOutsideCeiling(
      resolve({ confidentiality: [directReleaseRef(SPACE_TEAM)] }),
      aliceCeiling,
    )).toEqual([]);
    expect(consulted).toEqual([SPACE_TEAM]);
  });

  it("keeps a shared-space PolicyOf value sealed from a non-reader", () => {
    // The same fixture as the reader case, with the provider denying: what
    // separates the two outcomes is the subject space's verified membership.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      membershipProvider: providerGranting([SPACE_OTHER]),
      modulePolicyResolver: () => directReleaseManifest,
    });
    expect(atomsOutsideCeiling(
      resolve({ confidentiality: [directReleaseRef(SPACE_TEAM)] }),
      aliceCeiling,
    )).toEqual([directReleaseRef(SPACE_TEAM)]);
  });

  it("does not release to another principal's reader evidence", () => {
    // A HasRole fact the label carries for somebody else binds `reader` to
    // that principal, and User(mallory) does not fit Alice's ceiling.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      modulePolicyResolver: () => directReleaseManifest,
    });
    const resolved = resolve({
      confidentiality: [directReleaseRef(SPACE_TEAM)],
      integrity: [cfcAtom.hasRole(MALLORY, SPACE_TEAM, "reader")],
    });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([{
      anyOf: [directReleaseRef(SPACE_TEAM), cfcAtom.user(MALLORY)],
    }]);
  });

  it("fails closed without a verified manifest even for the owner", () => {
    for (
      const modulePolicyResolver of [
        undefined,
        () => undefined,
        () => ({ ...directReleaseManifest, policyDigest: "forged" }),
      ]
    ) {
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: ALICE,
        memberSpaces: [ALICE],
        modulePolicyResolver,
      });
      expect(atomsOutsideCeiling(
        resolve({ confidentiality: [directReleaseRef(ALICE)] }),
        aliceCeiling,
      )).toEqual([directReleaseRef(ALICE)]);
    }
  });

  it("reads the manifest from the spaces the label was read from", () => {
    const asked: Array<readonly string[]> = [];
    let listed = 0;
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      modulePolicyResolver: (_reference, spaces) => {
        asked.push(spaces);
        return spaces.includes(SPACE_OTHER) ? directReleaseManifest : undefined;
      },
    });
    const spaces = () => {
      listed++;
      return [SPACE_OTHER];
    };
    expect(atomsOutsideCeiling(
      resolve({ confidentiality: [directReleaseRef(ALICE)], spaces }),
      aliceCeiling,
    )).toEqual([]);
    expect(asked).toEqual([[SPACE_OTHER]]);
    // Without the spaces the label came from there is nowhere to read.
    expect(atomsOutsideCeiling(
      resolve({ confidentiality: [directReleaseRef(ALICE)] }),
      aliceCeiling,
    )).toEqual([directReleaseRef(ALICE)]);
    // A label that selects no module policy never asks for them.
    resolve({ confidentiality: [cfcAtom.space(ALICE)], spaces });
    expect(listed).toEqual(1);
  });

  it("releases a committed subject the viewer's own space matches", () => {
    // A cross-space copy carries its subject in commitment form. The runtime
    // never opens it; the HasRole fact it mints for Alice's own space unifies
    // with it commitment-aware (spec §4.3.6, §4.6.4.1).
    const committed = directReleaseRef(
      commitCfcFieldValue(ALICE) as unknown as string,
    );
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      modulePolicyResolver: () => directReleaseManifest,
    });
    expect(atomsOutsideCeiling(
      resolve({ confidentiality: [committed] }),
      aliceCeiling,
    )).toEqual([]);
  });

  it("keeps a committed shared subject sealed, and never asks about it", () => {
    // Alice reads the team space, but the label names it only as a digest:
    // no membership query can be addressed to it, so nothing matches.
    const committed = directReleaseRef(
      commitCfcFieldValue(SPACE_TEAM) as unknown as string,
    );
    const consulted: string[] = [];
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      membershipProvider: {
        readerRole: (space) => {
          consulted.push(space);
          return space === SPACE_TEAM ? "reader" : null;
        },
        subscribe: () => () => {},
      },
      modulePolicyResolver: () => directReleaseManifest,
    });
    expect(atomsOutsideCeiling(
      resolve({ confidentiality: [committed] }),
      aliceCeiling,
    )).toEqual([committed]);
    expect(consulted).toEqual([]);
  });
});

describe("CFC render resolver — spaces a module rule adds", () => {
  // A rule that adds `Space(x)` for a space bound from label-carried evidence
  // rather than from THIS_POLICY.subject. Membership is looked up only for
  // the label's `Space` atoms (spec §4.9.3) and its module-policy subjects
  // (docs/specs/cfc-spec-changes.md SC-44), which is also exactly what the
  // reconciler watches, so such a space stays sealed.
  const addsTeam = buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity: "sha256:release-elsewhere",
    symbol: "releaseElsewhere",
    template: {
      templateVersion: 1,
      exchangeRules: [{
        name: "releaseToNamedSpace",
        preCondition: {
          confidentiality: [{ thisPolicy: true }],
          integrity: [{ type: "ReleasedTo", space: { var: "x" } }],
        },
        postCondition: {
          confidentiality: [{ type: CFC_ATOM_TYPE.Space, id: { var: "x" } }],
          integrity: [],
        },
      }],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });
  const ref = cfcAtom.modulePolicyRef(
    addsTeam.manifest.moduleIdentity,
    addsTeam.manifest.symbol,
    addsTeam.policyDigest,
    SPACE_OTHER,
  );

  it("leaves a space bound from other evidence sealed, unconsulted", () => {
    const consulted: string[] = [];
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: {
        readerRole: (space) => {
          consulted.push(space);
          return space === SPACE_TEAM ? "reader" : null;
        },
        subscribe: () => () => {},
      },
      modulePolicyResolver: () => addsTeam,
    });
    expect(atomsOutsideCeiling(
      resolve({
        confidentiality: [ref],
        integrity: [{ type: "ReleasedTo", space: SPACE_TEAM }],
      }),
      aliceCeiling,
    )).toEqual([{ anyOf: [cfcAtom.space(SPACE_TEAM), ref] }]);
    expect(consulted).toEqual([SPACE_OTHER]);
  });

  it("admits that space when the viewer's membership is already known", () => {
    // The same rule and evidence, with the team space a static member: the
    // rule does fire, so the sealed case above is the membership lookup's
    // scope and not a rule that never matched.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [SPACE_TEAM],
      modulePolicyResolver: () => addsTeam,
    });
    expect(atomsOutsideCeiling(
      resolve({
        confidentiality: [ref],
        integrity: [{ type: "ReleasedTo", space: SPACE_TEAM }],
      }),
      aliceCeiling,
    )).toEqual([]);
  });
});
