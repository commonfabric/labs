import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  CFC_RUNTIME_SUBJECT,
  cfcAtom,
} from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  type CfcConfClause,
  clauseAlternatives,
  normalizeClause,
} from "../src/cfc/clause.ts";
import {
  DEFAULT_EXCHANGE_FUEL,
  evaluateExchangeRules,
} from "../src/cfc/exchange-eval.ts";
import {
  type CfcGrantCandidate,
  cfcGrantCandidateOf,
  type CfcGrantWriteInput,
  createRuntimeCfcGrantSource,
} from "../src/cfc/grants.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";
import {
  buildCfcPolicyArtifactManifest,
  buildCfcPolicySnapshot,
  type CfcPolicyRecordInput,
  type ExchangeRule,
} from "../src/cfc/policy.ts";
import {
  createRenderConfidentialityResolver,
  RENDER_DISPLAY_SINK_CLASS,
} from "../src/cfc/render-ceiling.ts";
import { SINK_CLASSES, sinkClassOf } from "../src/cfc/sink-inventory.ts";
import type { SpaceMembershipProvider } from "../src/cfc/space-membership.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

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

describe("CFC render resolver — deployment policy at the display boundary", () => {
  // The display boundary evaluates the deployment's policy records before the
  // ceiling fit, as any boundary does (spec §8.10.6). The record here is the
  // owner-self display release a deployment authors: a `Resource` atom whose
  // subject is the acting user gains a `User` alternative naming that user.
  // Every case fits against Alice's ceiling.

  const ownerSelfDisplayRecord: CfcPolicyRecordInput = {
    id: "owner-self-display",
    rules: [{
      id: "resource-owner-self-display",
      appliesTo: {
        type: CFC_ATOM_TYPE.Resource,
        subject: { var: "$actingUser" },
      },
      preCondition: {
        boundary: [{
          type: CFC_ATOM_TYPE.BoundaryContext,
          key: "sinkClass",
          value: RENDER_DISPLAY_SINK_CLASS,
        }],
      },
      post: {
        addAlternatives: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$actingUser" },
        }],
      },
    }],
  };
  const ownerSelfSnapshot = buildCfcPolicySnapshot([ownerSelfDisplayRecord]);
  const resolveForAlice = () =>
    createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      policySnapshot: ownerSelfSnapshot,
    });
  const message = (subject: string) => cfcAtom.resource("message", subject);
  const ownerSelf = (atom: CfcConfClause) =>
    normalizeClause({ anyOf: [atom, userAlice] });

  /**
   * Whether the owner-self record releases `acting`'s own message to them,
   * the positive control for a case that shows it releasing nothing else.
   */
  const releasesOwnMessage = (acting: string) =>
    deepEqual(
      createRenderConfidentialityResolver({
        actingPrincipal: acting,
        policySnapshot: ownerSelfSnapshot,
      })({ confidentiality: [message(acting)] }),
      [normalizeClause({ anyOf: [message(acting), cfcAtom.user(acting)] })],
    );

  describe("releasing", () => {
    it("adds `User(acting)` to the acting user's own `Resource` clause, which then fits the ceiling", () => {
      const resolved = resolveForAlice()({
        confidentiality: [userAlice, message(ALICE)],
      });
      expect(resolved).toEqual([userAlice, ownerSelf(message(ALICE))]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
    });

    it("keeps the matched `Resource` alternative beside the one it adds", () => {
      const resolved = resolveForAlice()({ confidentiality: [message(ALICE)] });
      expect(resolved.length).toBe(1);
      expect(clauseAlternatives(resolved[0])).toContainEqual(message(ALICE));
      expect(clauseAlternatives(resolved[0])).toContainEqual(userAlice);
    });

    it("releases a scoped `Resource` whatever its class and scope", () => {
      const scoped = cfcAtom.resource("health", ALICE, { doc: "doc:e" });
      const resolved = resolveForAlice()({ confidentiality: [scoped] });
      expect(resolved).toEqual([ownerSelf(scoped)]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
    });

    it("adds `User(acting)` to each clause naming one of the acting user's resources", () => {
      const email = cfcAtom.resource("email", ALICE);
      const contact = cfcAtom.resource("contact", ALICE);
      const resolved = resolveForAlice()({ confidentiality: [email, contact] });
      expect(resolved).toEqual([ownerSelf(email), ownerSelf(contact)]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
    });

    it("adds `User(acting)` to an authored OR-clause holding the acting user's resource", () => {
      const clause = { anyOf: [message(ALICE), cfcAtom.space(SPACE_OTHER)] };
      const resolved = resolveForAlice()({ confidentiality: [clause] });
      expect(resolved).toEqual([
        normalizeClause({
          anyOf: [message(ALICE), cfcAtom.space(SPACE_OTHER), userAlice],
        }),
      ]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
    });
  });

  describe("not releasing", () => {
    it("keeps the owner's own `Resource` clause hidden without a deployment record", () => {
      // The standard render rules release no `Resource`: an owner-self
      // release is the deployment's to author.
      const label = [userAlice, message(ALICE)];
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: ALICE,
        memberSpaces: [ALICE],
      });
      const resolved = resolve({ confidentiality: label });
      expect(resolved).toEqual(label);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
        message(ALICE),
      ]);
    });

    it("releases nothing of Alice's to another acting user", () => {
      const label = [userAlice, message(ALICE)];
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: MALLORY,
        policySnapshot: ownerSelfSnapshot,
      });
      expect(resolve({ confidentiality: label })).toEqual(label);
      expect(releasesOwnMessage(MALLORY)).toBe(true);
    });

    it("keeps a value hidden whose deployment release names someone other than the acting user", () => {
      // A deployment record can add any alternative, and the alternative it
      // adds must still fit the acting user's ceiling.
      const toMallory = buildCfcPolicySnapshot([{
        id: "release-to-mallory",
        rules: [{
          id: "resource-to-mallory",
          appliesTo: { type: CFC_ATOM_TYPE.Resource },
          preCondition: {
            boundary: [{
              type: CFC_ATOM_TYPE.BoundaryContext,
              key: "sinkClass",
              value: RENDER_DISPLAY_SINK_CLASS,
            }],
          },
          post: { addAlternatives: [cfcAtom.user(MALLORY)] },
        }],
      }]);
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: ALICE,
        policySnapshot: toMallory,
      });
      const resolved = resolve({
        confidentiality: [userAlice, message(ALICE)],
      });
      const released = normalizeClause({
        anyOf: [message(ALICE), cfcAtom.user(MALLORY)],
      });
      expect(resolved).toEqual([userAlice, released]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([released]);
    });

    it("leaves another subject's `Resource` clause unchanged, adding neither user", () => {
      const label = [message(MALLORY)];
      const resolved = resolveForAlice()({ confidentiality: label });
      expect(resolved).toEqual(label);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual(label);
      expect(releasesOwnMessage(ALICE)).toBe(true);
    });

    it("rewrites only the acting user's clause of two subjects' conjoined resources", () => {
      const own = cfcAtom.resource("x", ALICE);
      const theirs = cfcAtom.resource("x", MALLORY);
      const resolved = resolveForAlice()({ confidentiality: [own, theirs] });
      expect(resolved).toEqual([ownerSelf(own), theirs]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([theirs]);
    });

    it("leaves a clause naming another principal, a facet context, or an expiry untouched", () => {
      // The facet context names Alice as its subject and is still not one of
      // her resources: the rule matches the `Resource` family alone.
      for (
        const sibling of [
          cfcAtom.user("mailto:bob@example.com"),
          {
            type: CFC_ATOM_TYPE.Context,
            name: "facet:journal",
            subject: ALICE,
          },
          cfcAtom.expires(1),
        ]
      ) {
        const resolved = resolveForAlice()({
          confidentiality: [userAlice, message(ALICE), sibling],
        });
        expect(resolved).toEqual([
          userAlice,
          ownerSelf(message(ALICE)),
          sibling,
        ]);
        expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([sibling]);
      }
    });

    it("leaves a caveat clause untouched, even one sourced from the acting user's resource", () => {
      const caveat = cfcAtom.caveat(
        CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
        message(ALICE),
      );
      const resolved = resolveForAlice()({
        confidentiality: [userAlice, message(ALICE), caveat],
      });
      expect(resolved).toEqual([userAlice, ownerSelf(message(ALICE)), caveat]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([caveat]);
    });

    it("fires at no sink class but display", () => {
      // What confines the record to display is its own guard, checked here
      // against every class the egress gate mints from the sink inventory,
      // the model-call sinks' network class among them; the sink gates
      // evaluate the same deployment snapshot.
      const label = [userAlice, message(ALICE)];
      const evaluateAt = (sinkClass: string) =>
        evaluateExchangeRules({ confidentiality: label }, ownerSelfSnapshot, {
          boundary: [cfcAtom.boundaryContext("sinkClass", sinkClass)],
          actingPrincipal: ALICE,
        });
      expect(evaluateAt(RENDER_DISPLAY_SINK_CLASS).label.confidentiality)
        .toEqual([userAlice, ownerSelf(message(ALICE))]);
      const sinkClasses = new Set(Object.values(SINK_CLASSES));
      expect(sinkClasses.has(sinkClassOf("llm"))).toBe(true);
      for (const sinkClass of sinkClasses) {
        const result = evaluateAt(sinkClass);
        expect(result.firings).toEqual([]);
        expect(result.label.confidentiality).toEqual(label);
      }
    });

    it("rewrites nothing without an acting principal", () => {
      // A missing principal must not match a missing subject either.
      const label = [
        message(ALICE),
        { type: CFC_ATOM_TYPE.Resource, class: "message" },
      ];
      const resolve = createRenderConfidentialityResolver({
        memberSpaces: [ALICE],
        policySnapshot: ownerSelfSnapshot,
      });
      expect(resolve({ confidentiality: label })).toEqual(label);
      expect(releasesOwnMessage(ALICE)).toBe(true);
    });

    it("rewrites nothing for an acting principal that is not a user's DID", () => {
      // A `Resource` minted without a subject names the runtime, as a stored
      // credential's does; the runtime is a service, not an owner who views.
      for (
        const [acting, atom] of [
          [CFC_RUNTIME_SUBJECT, cfcAtom.resource("oauth-token")],
          ["alice", cfcAtom.resource("message", "alice")],
          ["did:key", cfcAtom.resource("message", "did:key")],
        ] as const
      ) {
        const resolve = createRenderConfidentialityResolver({
          actingPrincipal: acting,
          policySnapshot: ownerSelfSnapshot,
        });
        expect(resolve({ confidentiality: [atom] })).toEqual([atom]);
      }
      expect(releasesOwnMessage(ALICE)).toBe(true);
    });

    it("releases a committed subject that digests to the acting user, and no other", () => {
      // The commitment is compared against the acting user's DID and never
      // opened.
      const committed = (subject: string) => ({
        type: CFC_ATOM_TYPE.Resource,
        class: "message",
        subject: commitCfcFieldValue(subject),
      });
      expect(resolveForAlice()({ confidentiality: [committed(ALICE)] }))
        .toEqual([ownerSelf(committed(ALICE))]);
      expect(resolveForAlice()({ confidentiality: [committed(MALLORY)] }))
        .toEqual([committed(MALLORY)]);
    });

    it("returns the original label when the rule runs out of fuel", () => {
      // One firing per clause, so a label one clause longer than the budget
      // exhausts it. The label that fits the budget exactly is what shows the
      // rule fires on these clauses at all.
      const clauses = (count: number) =>
        Array.from(
          { length: count },
          (_, index) => cfcAtom.resource(`class-${index}`, ALICE),
        );
      const fitting = clauses(DEFAULT_EXCHANGE_FUEL);
      expect(
        atomsOutsideCeiling(
          resolveForAlice()({ confidentiality: fitting }),
          aliceCeiling,
        ),
      ).toEqual([]);
      const exhausting = clauses(DEFAULT_EXCHANGE_FUEL + 1);
      const resolved = resolveForAlice()({ confidentiality: exhausting });
      expect(resolved).toEqual(exhausting);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual(exhausting);
    });
  });

  describe("the `$actingUser` variable in rule data", () => {
    // Spec §4.9.2: a rule's `$actingUser` is the acting principal, supplied by
    // the evaluator before matching and never read off the label. A rule
    // without an integrity or policy-state guard stays out of module
    // manifests, so the unguarded owner-self form is the runtime's alone.

    const displayBoundary = [
      cfcAtom.boundaryContext("sink", "render"),
      cfcAtom.boundaryContext("sinkClass", RENDER_DISPLAY_SINK_CLASS),
    ];
    const ownerSelfShaped = (variable: string): ExchangeRule => ({
      id: "owner-self-shaped",
      appliesTo: { type: CFC_ATOM_TYPE.Resource, subject: { var: variable } },
      preCondition: {
        boundary: [{
          type: CFC_ATOM_TYPE.BoundaryContext,
          key: "sinkClass",
          value: RENDER_DISPLAY_SINK_CLASS,
        }],
      },
      post: {
        addAlternatives: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: variable },
        }],
      },
    });
    const evaluateDeployment = (
      variable: string,
      subject: string,
      actingPrincipal: string | undefined,
    ) =>
      evaluateExchangeRules(
        { confidentiality: [message(subject)] },
        buildCfcPolicySnapshot([{
          id: "deployment",
          rules: [ownerSelfShaped(variable)],
        }]),
        { boundary: displayBoundary, actingPrincipal },
      );

    it("binds a deployment rule's `$actingUser` to the acting principal and to nobody else", () => {
      // The same rule under an ordinary variable fires on any subject: the
      // label-learned release `$actingUser` must not become.
      expect(
        evaluateDeployment("$owner", MALLORY, ALICE).label.confidentiality,
      ).toEqual([
        normalizeClause({ anyOf: [message(MALLORY), cfcAtom.user(MALLORY)] }),
      ]);
      expect(
        evaluateDeployment("$actingUser", ALICE, ALICE).label.confidentiality,
      ).toEqual([ownerSelf(message(ALICE))]);
      for (
        const [subject, acting] of [[MALLORY, ALICE], [ALICE, undefined]]
      ) {
        const result = evaluateDeployment("$actingUser", subject!, acting);
        expect(result.firings).toEqual([]);
        expect(result.label.confidentiality).toEqual([message(subject!)]);
      }
    });

    // A module rule releasing its clause to whichever reader of the policy's
    // subject space is acting.
    const actingReaderManifest = buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: "sha256:acting-reader-module",
      symbol: "actingReaderRules",
      template: {
        templateVersion: 1,
        exchangeRules: [{
          name: "releaseToActingReader",
          preCondition: {
            confidentiality: [{ thisPolicy: true }],
            integrity: [{
              type: CFC_ATOM_TYPE.HasRole,
              principal: { var: "$actingUser" },
              space: { thisPolicyField: "subject" },
              role: "reader",
            }],
          },
          postCondition: {
            confidentiality: [{
              type: CFC_ATOM_TYPE.User,
              subject: { var: "$actingUser" },
            }],
            integrity: [],
          },
        }],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
    const actingReaderRef = cfcAtom.modulePolicyRef(
      actingReaderManifest.manifest.moduleIdentity,
      actingReaderManifest.manifest.symbol,
      actingReaderManifest.policyDigest,
      SPACE_TEAM,
    );

    it("releases a guarded module rule's clause to the acting reader it names", () => {
      const resolve = createRenderConfidentialityResolver({
        actingPrincipal: ALICE,
        memberSpaces: [SPACE_TEAM],
        modulePolicyResolver: () => actingReaderManifest,
      });
      const resolved = resolve({ confidentiality: [actingReaderRef] });
      expect(resolved).toEqual([
        normalizeClause({ anyOf: [actingReaderRef, userAlice] }),
      ]);
      expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
    });

    it("keeps that clause sealed without an acting principal, and from another reader's evidence", () => {
      // Mallory's reader fact would bind an ordinary variable to Mallory.
      const label = {
        confidentiality: [actingReaderRef],
        integrity: [cfcAtom.hasRole(MALLORY, SPACE_TEAM, "reader")],
      };
      for (const actingPrincipal of [undefined, ALICE]) {
        const resolve = createRenderConfidentialityResolver({
          actingPrincipal,
          modulePolicyResolver: () => actingReaderManifest,
        });
        expect(resolve(label)).toEqual([actingReaderRef]);
      }
    });

    it("refuses a module manifest whose rule has no guard, or targets anything but its own policy", () => {
      const manifestWith = (preCondition: unknown) => () =>
        buildCfcPolicyArtifactManifest({
          ...actingReaderManifest.manifest,
          template: {
            ...actingReaderManifest.manifest.template,
            exchangeRules: [{
              ...actingReaderManifest.manifest.template.exchangeRules[0],
              preCondition,
            }],
          },
        } as never);
      expect(manifestWith({
        confidentiality: [{ thisPolicy: true }],
        integrity: [],
      })).toThrow(/integrity or policyState guard/);
      expect(manifestWith({
        confidentiality: [{
          type: CFC_ATOM_TYPE.Resource,
          subject: { var: "$actingUser" },
        }],
        integrity: [],
      })).toThrow(/must target THIS_POLICY/);
    });
  });
});

const grantSigner = await Identity.fromPassphrase("runner-cfc-render-grants");

/** Runs `body` against a runtime whose storage the grant signer owns. */
const withGrantRuntime = async (
  body: (runtime: Runtime) => void | Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: grantSigner });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("CFC render resolver — grants at the display boundary", () => {
  // A module rule guarded on a grant record (spec §4.3.5) fires at display
  // when the grant it names is written through the trusted writer, and at no
  // other time. The grant lives in the owner's identity space; the policy's
  // subject is that space, so the rule binds the owner from `THIS_POLICY` and
  // the reader from the grant's audience. The owner writes; the viewer, whose
  // ceiling every case fits against, acts.

  const OWNER = grantSigner.did();
  const VIEWER = "did:key:z6MkViewerOfTheOwnersAnswer";
  const userViewer = cfcAtom.user(VIEWER);
  const viewerCeiling = [userViewer, cfcAtom.personalSpace(VIEWER)];
  const ANSWER = "of:answer-q7";
  const OTHER_ANSWER = "of:answer-q8";

  const shareManifest = buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity: "sha256:share-grant-module",
    symbol: "shareGrantRules",
    template: {
      templateVersion: 1,
      exchangeRules: [{
        name: "releaseToGrantee",
        preCondition: {
          confidentiality: [{ thisPolicy: true }],
          integrity: [],
        },
        guard: {
          policyState: [{
            kind: "ShareGrant",
            owner: { thisPolicyField: "subject" },
            resource: ANSWER,
            audience: {
              type: CFC_ATOM_TYPE.User,
              subject: { var: "$grantee" },
            },
          }],
        },
        postCondition: {
          confidentiality: [{
            type: CFC_ATOM_TYPE.User,
            subject: { var: "$grantee" },
          }],
          integrity: [],
        },
      }],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });
  const shareRefFor = (subject: string) =>
    cfcAtom.modulePolicyRef(
      shareManifest.manifest.moduleIdentity,
      shareManifest.manifest.symbol,
      shareManifest.policyDigest,
      subject,
    );
  const shareRef = shareRefFor(OWNER);
  const released = normalizeClause({ anyOf: [shareRef, userViewer] });
  const answerCandidate = cfcGrantCandidateOf({
    kind: "ShareGrant",
    fields: { owner: OWNER, resource: ANSWER },
  })!;

  /** Writes the owner's grant through the trusted policy-writer path. */
  const writeGrant = async (
    runtime: Runtime,
    overrides: Partial<CfcGrantWriteInput> = {},
  ): Promise<void> => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: "cfc-grant-writer",
    });
    tx.writeCfcGrant({
      kind: "ShareGrant",
      owner: OWNER,
      resource: ANSWER,
      audience: [userViewer],
      grantedAt: 1000,
      ...overrides,
    });
    expect((await tx.commit()).ok).toBeDefined();
    await runtime.idle();
  };

  /** Resolves the owner's `PolicyOf` label as the viewer, through `source`. */
  const resolveAsViewer = (
    runtime: Runtime,
    { label = [shareRef], consulted }: {
      label?: CfcConfClause[];
      consulted?: (candidate: CfcGrantCandidate) => void;
    } = {},
  ) =>
    createRenderConfidentialityResolver({
      actingPrincipal: VIEWER,
      modulePolicyResolver: () => shareManifest,
      grantSource: createRuntimeCfcGrantSource(runtime),
    })({ confidentiality: label }, { grant: consulted });

  describe("releasing", () => {
    it("adds `User(viewer)` to the owner's clause when the owner's grant names the viewer, which then fits the ceiling", async () => {
      await withGrantRuntime(async (runtime) => {
        await writeGrant(runtime);
        const resolved = resolveAsViewer(runtime);
        expect(resolved).toEqual([released]);
        expect(atomsOutsideCeiling(resolved, viewerCeiling)).toEqual([]);
      });
    });

    it("reports the candidate it consulted, whether or not the grant is there", async () => {
      await withGrantRuntime(async (runtime) => {
        const consulted: CfcGrantCandidate[] = [];
        resolveAsViewer(runtime, {
          consulted: (candidate) => consulted.push(candidate),
        });
        expect(consulted).toEqual([answerCandidate]);
        await writeGrant(runtime);
        consulted.length = 0;
        resolveAsViewer(runtime, {
          consulted: (candidate) => consulted.push(candidate),
        });
        expect(consulted).toEqual([answerCandidate]);
      });
    });
  });

  describe("not releasing", () => {
    it("keeps the clause sealed without a grant", async () => {
      await withGrantRuntime((runtime) => {
        const resolved = resolveAsViewer(runtime);
        expect(resolved).toEqual([shareRef]);
        expect(atomsOutsideCeiling(resolved, viewerCeiling)).toEqual([
          shareRef,
        ]);
      });
    });

    it("keeps the clause sealed once the grant is revoked", async () => {
      await withGrantRuntime(async (runtime) => {
        await writeGrant(runtime, { revoked: { at: 2000, by: OWNER } });
        expect(resolveAsViewer(runtime)).toEqual([shareRef]);
      });
    });

    it("keeps the clause sealed under a grant for another resource", async () => {
      await withGrantRuntime(async (runtime) => {
        await writeGrant(runtime, { resource: OTHER_ANSWER });
        expect(resolveAsViewer(runtime)).toEqual([shareRef]);
      });
    });

    it("keeps a policy whose subject is another owner sealed by this owner's grant", async () => {
      // The rule binds its owner from the policy's subject; the grant at that
      // owner's address is what it reads, and this owner wrote none there.
      await withGrantRuntime(async (runtime) => {
        await writeGrant(runtime);
        const other = shareRefFor("did:key:z6MkAnotherOwnerOfAnAnswer");
        expect(resolveAsViewer(runtime, { label: [other] })).toEqual([other]);
      });
    });

    it("keeps the clause sealed under a document at the grant's address that the guard matches but that does not verify", async () => {
      // Written past the trusted writer, straight into storage. Each carries
      // the fields the guard reads, so only verify-on-read refuses it: a
      // stored space other than the one it sits in, a version that is not
      // the grant version, a time that is not a number.
      const grant = {
        version: 1,
        space: OWNER,
        kind: "ShareGrant",
        owner: OWNER,
        resource: ANSWER,
        audience: [userViewer],
        grantedAt: 1000,
      };
      for (
        const stored of [
          { ...grant, space: "did:key:z6MkASpaceTheDocumentIsNotIn" },
          { ...grant, version: 2 },
          { ...grant, grantedAt: "1000" },
        ]
      ) {
        await withGrantRuntime(async (runtime) => {
          const tx = runtime.storageManager.edit();
          tx.write({
            space: answerCandidate.space as never,
            id: answerCandidate.id,
            type: "application/json",
            path: ["value"],
          }, stored as never);
          expect((await tx.commit()).error).toBeUndefined();
          await runtime.idle();
          expect(resolveAsViewer(runtime)).toEqual([shareRef]);
        });
      }
    });

    it("keeps the clause sealed under a single-use grant, since a render is an observing site", async () => {
      await withGrantRuntime(async (runtime) => {
        await writeGrant(runtime, { singleUse: true });
        expect(resolveAsViewer(runtime)).toEqual([shareRef]);
      });
    });

    it("releases to the grant's audience and to nobody else", async () => {
      // A grant to a third party fires the rule for that party; what it adds
      // sits outside the viewer's ceiling.
      await withGrantRuntime(async (runtime) => {
        const third = "did:key:z6MkThirdPartyTheGrantNames";
        await writeGrant(runtime, { audience: [cfcAtom.user(third)] });
        const resolved = resolveAsViewer(runtime);
        const toThird = normalizeClause({
          anyOf: [shareRef, cfcAtom.user(third)],
        });
        expect(resolved).toEqual([toThird]);
        expect(atomsOutsideCeiling(resolved, viewerCeiling)).toEqual([
          toThird,
        ]);
      });
    });
  });

  describe("the change feed", () => {
    it("signals a grant written after the first evaluation, and its revocation after that", async () => {
      await withGrantRuntime(async (runtime) => {
        const source = createRuntimeCfcGrantSource(runtime);
        const resolve = createRenderConfidentialityResolver({
          actingPrincipal: VIEWER,
          modulePolicyResolver: () => shareManifest,
          grantSource: source,
        });
        let changes = 0;
        const cancel = source.subscribe(answerCandidate, () => changes++);
        try {
          expect(resolve({ confidentiality: [shareRef] })).toEqual([shareRef]);
          expect(changes).toBe(0);
          await writeGrant(runtime);
          expect(changes).toBe(1);
          expect(resolve({ confidentiality: [shareRef] })).toEqual([released]);
          await writeGrant(runtime, { revoked: { at: 2000, by: OWNER } });
          expect(changes).toBe(2);
          expect(resolve({ confidentiality: [shareRef] })).toEqual([shareRef]);
        } finally {
          cancel();
        }
      });
    });
  });
});

describe("CFC render resolver — the reciprocal two-grant rule", () => {
  // A module rule with two grant guards over one resource: the owner's grant
  // naming the reader, and the reader's grant naming the owner. The reader
  // sees the owner's answer only while both stand. Every case fits against
  // the reader's ceiling.
  //
  // What this arranges that a deployment would not: both grants sit in one
  // runtime's storage, each in its owner's identity space, so the reader's
  // evaluation reads the owner's space and its own alike; the reader's grant
  // is written by acting as the reader for one transaction, as a served run
  // is stamped; for the `HasRole` binding the reader is declared a verified
  // reader of the owner's space; and the resource is a literal in the rule,
  // one rule per question.

  const OWNER = grantSigner.did();
  const READER = "did:key:z6MkReaderWhoAnswersInTurn";
  const userReader = cfcAtom.user(READER);
  const readerCeiling = [userReader, cfcAtom.personalSpace(READER)];
  const Q7 = "of:answer-q7";
  const Q8 = "of:answer-q8";

  type OwnerBinding = "subject" | "represents-principal";
  type ReaderBinding = "actingUser" | "hasRole";

  /**
   * The reciprocal rule with the owner bound from `THIS_POLICY.subject` or
   * from the label's `represents-principal` atom, and the reader bound as
   * `$actingUser` or from a `HasRole` fact on the policy's subject space.
   */
  const reciprocalManifest = (owner: OwnerBinding, reader: ReaderBinding) => {
    const ownerPattern = owner === "subject"
      ? { thisPolicyField: "subject" }
      : { var: "$owner" };
    const readerVariable = reader === "actingUser" ? "$actingUser" : "$reader";
    const readerPattern = { var: readerVariable };
    return buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: `sha256:reciprocal-${owner}-${reader}`,
      symbol: "reciprocalRules",
      template: {
        templateVersion: 1,
        exchangeRules: [{
          name: "releaseWhenBothShare",
          preCondition: {
            confidentiality: [{ thisPolicy: true }],
            integrity: [
              ...(owner === "represents-principal"
                ? [{ kind: "represents-principal", subject: ownerPattern }]
                : []),
              ...(reader === "hasRole"
                ? [{
                  type: CFC_ATOM_TYPE.HasRole,
                  principal: readerPattern,
                  space: { thisPolicyField: "subject" },
                  role: "reader",
                }]
                : []),
            ],
          },
          guard: {
            policyState: [{
              kind: "ShareGrant",
              owner: ownerPattern,
              resource: Q7,
              audience: { type: CFC_ATOM_TYPE.User, subject: readerPattern },
            }, {
              kind: "ShareGrant",
              owner: readerPattern,
              resource: Q7,
              audience: { type: CFC_ATOM_TYPE.User, subject: ownerPattern },
            }],
          },
          postCondition: {
            confidentiality: [{
              type: CFC_ATOM_TYPE.User,
              subject: readerPattern,
            }],
            integrity: [],
          },
        }],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
  };

  /**
   * Writes `owner`'s grant over `resource` to `audience` through the trusted
   * writer, acting as `owner` for that transaction.
   */
  const writeGrant = async (
    runtime: Runtime,
    owner: string,
    resource: string,
    audience: string,
  ): Promise<void> => {
    const tx = runtime.edit();
    setCfcTrustSnapshot(tx, runtime.trustSnapshotForPrincipal(owner));
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: "cfc-grant-writer",
    });
    tx.writeCfcGrant({
      kind: "ShareGrant",
      owner,
      resource,
      audience: [cfcAtom.user(audience)],
      grantedAt: 1000,
    });
    expect((await tx.commit()).ok).toBeDefined();
    await runtime.idle();
  };

  for (const owner of ["subject", "represents-principal"] as const) {
    for (const reader of ["actingUser", "hasRole"] as const) {
      describe(`owner from ${owner}, reader from ${reader}`, () => {
        const manifest = reciprocalManifest(owner, reader);
        const ref = cfcAtom.modulePolicyRef(
          manifest.manifest.moduleIdentity,
          manifest.manifest.symbol,
          manifest.policyDigest,
          OWNER,
        );
        const label = {
          confidentiality: [ref],
          integrity: owner === "represents-principal"
            ? [{ kind: "represents-principal", subject: OWNER }]
            : [],
        };
        const resolveAsReader = (runtime: Runtime) =>
          createRenderConfidentialityResolver({
            actingPrincipal: READER,
            memberSpaces: reader === "hasRole" ? [OWNER] : [],
            modulePolicyResolver: () => manifest,
            grantSource: createRuntimeCfcGrantSource(runtime),
          })(label);

        it("adds `User(reader)` when the owner's grant names the reader and the reader's names the owner", async () => {
          await withGrantRuntime(async (runtime) => {
            await writeGrant(runtime, OWNER, Q7, READER);
            await writeGrant(runtime, READER, Q7, OWNER);
            const resolved = resolveAsReader(runtime);
            expect(resolved).toEqual([
              normalizeClause({ anyOf: [ref, userReader] }),
            ]);
            expect(atomsOutsideCeiling(resolved, readerCeiling)).toEqual([]);
          });
        });

        it("keeps the clause sealed under the owner's grant alone", async () => {
          await withGrantRuntime(async (runtime) => {
            await writeGrant(runtime, OWNER, Q7, READER);
            expect(resolveAsReader(runtime)).toEqual([ref]);
          });
        });

        it("keeps the clause sealed under the reader's grant alone", async () => {
          await withGrantRuntime(async (runtime) => {
            await writeGrant(runtime, READER, Q7, OWNER);
            expect(resolveAsReader(runtime)).toEqual([ref]);
          });
        });

        it("keeps the clause sealed when the two grants name different questions", async () => {
          await withGrantRuntime(async (runtime) => {
            await writeGrant(runtime, OWNER, Q7, READER);
            await writeGrant(runtime, READER, Q8, OWNER);
            expect(resolveAsReader(runtime)).toEqual([ref]);
          });
        });
      });
    }
  }
});
