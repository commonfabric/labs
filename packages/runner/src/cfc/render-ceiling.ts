import {
  CFC_ATOM_TYPE,
  type CfcAtom,
  cfcAtom,
  type CfcModulePolicyRefAtom,
} from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { CfcConfClause } from "./clause.ts";
import { clauseAlternatives } from "./clause.ts";
import {
  type CfcGrantResolver,
  evaluateExchangeRules,
} from "./exchange-eval.ts";
import {
  buildCfcPolicySnapshot,
  type ExchangeRule,
  isExactModulePolicyRef,
  type PolicySnapshot,
} from "./policy.ts";
import type { RenderModulePolicyResolver } from "./policy-resolver.ts";
import type { SpaceMembershipProvider } from "./space-membership.ts";
import { type CfcTrustConfig, createTrustResolver } from "./trust.ts";

/**
 * Display-sink render ceiling resolution (Epic H3b of
 * docs/history/plans/cfc-future-work-implementation.md §7; spec §8.10.6).
 *
 * The render path is a display-sink egress boundary. Spec §8.10.6: "Ordinary
 * exchange-rule evaluation runs before the fit check, as at any boundary.
 * Confidentiality clauses that the ceiling does not satisfy AFTER exchange
 * evaluation MUST fail closed." So this module resolves the CONSUMED LABEL
 * of a rendered cell — it never rewrites the ceiling — and returns the
 * resolved confidentiality for the reconciler to fit (clause-subsumption,
 * §8.10.3) against the host's `maxConfidentiality`.
 *
 * Resolution runs RUNNER-side (this module) exactly as B5's sink gate does
 * (`evaluateGatedConfidentiality` in prepare.ts), differing only in the
 * boundary class: this mints `sinkClass:"display"` where the network sink
 * mints `sinkClass:"network"`. The reconciler consumes the resolved label; it
 * never runs the evaluator itself.
 */

/** The display sink class — the render sibling of B5's `"network"` class. */
export const RENDER_DISPLAY_SINK_CLASS = "display";

/** Boundary-context sink name for the render surface (spec §8.10.5 / §15.4). */
export const RENDER_SINK_NAME = "render";

/**
 * The display boundary context minted for every render evaluation: the sink
 * name plus its class. `sinkClass:"display"` scopes the standard render
 * exchange rules (and any deployment rule guarded on the display class).
 */
const renderDisplayBoundary = (): readonly CfcAtom[] => [
  cfcAtom.boundaryContext("sink", RENDER_SINK_NAME),
  cfcAtom.boundaryContext("sinkClass", RENDER_DISPLAY_SINK_CLASS),
];

/**
 * The standard render exchange rule set (spec §4.3.3 SpaceReaderAccess, scoped
 * to the display boundary). `Space($s)` confidentiality plus a verified
 * `HasRole($p, $s, reader)` membership fact — under a display boundary — adds
 * a `User($p)` alternative, so a display audience holding that role fits the
 * `User(actingUser)` ceiling. `PersonalSpace(actingUser)` needs no rule: the
 * §8.10.6 ceiling admits it by exact match (the acting user is its owner).
 */
export const STANDARD_RENDER_EXCHANGE_RULES: readonly ExchangeRule[] = [{
  id: "space-reader-access-display",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.HasRole,
      principal: { var: "$p" },
      space: { var: "$s" },
      role: "reader",
    }],
    boundary: [{
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "sinkClass",
      value: RENDER_DISPLAY_SINK_CLASS,
    }],
  },
  post: {
    addAlternatives: [{ type: CFC_ATOM_TYPE.User, subject: { var: "$p" } }],
  },
}];

/** Built once — the standard render rules are static deployment-independent. */
const STANDARD_RENDER_SNAPSHOT: PolicySnapshot = buildCfcPolicySnapshot([{
  id: "cfc-standard-render",
  rules: STANDARD_RENDER_EXCHANGE_RULES,
}])!;

export type RenderConfidentialityResolverConfig = {
  /** The display audience — the acting user whose HasRole facts are minted. */
  readonly actingPrincipal?: string;

  /**
   * Deployment trust config (B3), for any render rule with a `Concept`-valued
   * integrity guard. The standard SpaceReaderAccess rule uses a plain HasRole
   * guard and does not consult it, but it is threaded for parity with the
   * sink gate and future concept-guarded render rules.
   */
  readonly trustConfig?: CfcTrustConfig;

  /**
   * The acting user's VERIFIED reader spaces (§4.9.3): spaces for which the
   * runtime mints `HasRole(actingPrincipal, space, reader)` membership facts,
   * so a `Space(...)` label naming one of them resolves to `User(actingUser)`.
   *
   * These MUST be spaces the acting user is a proven reader of, NOT merely
   * spaces whose data is locally resident: residency is not read authority
   * (a runtime can sync a space's bytes under an ACL-off deployment without
   * the acting user being an authorized reader), so the cell's own storage
   * space is deliberately NOT trusted as a membership fact. The acting user's
   * own space (space DID == principal DID) is the one always-verifiable member
   * — a principal definitionally reads its own space regardless of ACL mode;
   * broader cross-space membership arrives with the §4.9.3 membership lookup.
   */
  readonly memberSpaces?: readonly string[];

  /**
   * The §4.9.3 membership lookup: a per-space capability oracle consulted for
   * each space `membershipSpacesInConfidentiality` lists for the label being
   * rendered. When it verifies the
   * acting principal reads that space (its declared ACL grants READ+, never
   * residency), the resolver mints `HasRole(actingPrincipal, id, reader)` so
   * the clause resolves — the dynamic complement to the static `memberSpaces`
   * fast path (own space + session space, which need no ACL read).
   *
   * The cross-space guarantee is exactly as strong as the deployment's
   * `MEMORY_ACL_MODE`: under `enforce` the ACL is authoritative; under
   * `observe`/`off` the lookup reads the same declared ACL record
   * — strictly better than residency, but only as strong as the posture. Fail
   * closed throughout: a `null` role (absent/unsynced/malformed ACL, or a
   * non-reader principal) mints nothing and the `Space(...)` clause stays
   * blocked.
   */
  readonly membershipProvider?: SpaceMembershipProvider;

  /**
   * Grant lookup for `policyState`-guarded render rules (§8.12.7 route 2a).
   * The standard SpaceReaderAccess rule carries no policyState guard, so this
   * stays inert until display-boundary rules consume grants (the ShareGrant
   * end-to-end build-order item) — threaded now for parity with the sink
   * gate, which resolves grants through the same context field. Fail closed
   * when absent, exactly like `trustResolver`.
   */
  readonly grantResolver?: CfcGrantResolver;

  /**
   * Manifest lookup for a label that selects a module policy (`PolicyOf<...>`,
   * spec §4.3.6), given the spaces the label was read from. The selected
   * manifest's exchange rules run alongside the standard render rules, as at
   * any boundary (§8.10.6), so a module rule that releases its clause — for
   * instance by adding `User(reader)` on a
   * `HasRole(reader, THIS_POLICY.subject)` fact, which the resolver mints for
   * a verified reader of the subject space — reaches the display audience.
   * Absent, or a lookup that finds no verified manifest, leaves such a label
   * unresolved, so it stays outside the ceiling (fail closed). The render
   * ceiling has its own switch, so this evaluation runs whatever the
   * `cfcPolicyEvaluation` dial says, as the standard render rule does.
   */
  readonly modulePolicyResolver?: RenderModulePolicyResolver;
};

/**
 * The spaces whose reader membership can decide how a label renders: each
 * `Space(id)` atom, the candidates spec §4.9.3 names, and the plaintext
 * subject space of each module policy the label selects, which
 * `docs/specs/cfc-spec-changes.md` SC-44 adds. A module rule's
 * `HasRole(reader, THIS_POLICY.subject)` guard is a membership point query on
 * that space and can fire for no other reader without one. A subject held in
 * commitment form names no space and is not listed: the runtime never opens a
 * commitment (§4.3.6), so such a guard can match only a fact the resolver
 * mints anyway. A space a module rule adds from any other binding is not
 * listed, and its `Space` alternative stays sealed. The render resolver
 * consults exactly these, and the reconciler watches exactly these ACLs.
 * Order-preserving and deduped.
 */
export const membershipSpacesInConfidentiality = (
  confidentiality: readonly CfcConfClause[],
): readonly string[] => {
  const spaces: string[] = [];
  for (const clause of confidentiality) {
    for (const alternative of clauseAlternatives(clause as CfcConfClause)) {
      let space: unknown;
      if (isExactModulePolicyRef(alternative)) {
        space = alternative.subject;
      } else if (
        isObjectOrArray(alternative) &&
        (alternative as { type?: unknown }).type === CFC_ATOM_TYPE.Space
      ) {
        space = (alternative as { id?: unknown }).id;
      }
      if (typeof space === "string" && !spaces.includes(space)) {
        spaces.push(space);
      }
    }
  }
  return spaces;
};

/**
 * The module-policy references a label selects, each exactly once, in label
 * order. The reconciler watches their manifests so a label sealed for want of
 * one re-renders when it arrives. A malformed reference is not listed; the
 * evaluator seals its label regardless.
 */
export const modulePolicyRefsInConfidentiality = (
  confidentiality: readonly CfcConfClause[],
): readonly CfcModulePolicyRefAtom[] => {
  const refs: CfcModulePolicyRefAtom[] = [];
  for (const clause of confidentiality) {
    for (const alternative of clauseAlternatives(clause as CfcConfClause)) {
      if (
        isExactModulePolicyRef(alternative) &&
        !refs.some((ref) => deepEqual(ref, alternative))
      ) {
        refs.push(alternative);
      }
    }
  }
  return refs;
};

/** The label of the cell being rendered, as read at the display boundary. */
export type RenderLabelInput = {
  readonly confidentiality: readonly CfcConfClause[];
  readonly integrity?: readonly CfcAtom[];

  /**
   * The spaces whose documents the label was read from. A module policy's
   * manifest is read from these, the label's local digest-addressed store
   * (spec §4.4.1): the commit that persisted the label installed the manifest
   * beside it. A thunk, called only for a label that selects a module policy,
   * since finding them can mean resolving the cell's links. Absent or empty,
   * a label that selects a module policy stays sealed.
   */
  readonly spaces?: () => readonly string[];
};

/**
 * Resolves one rendered cell's confidentiality label at the display boundary.
 * Returns the exchange-rewritten confidentiality clause set; the reconciler
 * fits it against the ceiling. Fuel exhaustion returns the ORIGINAL label
 * (fail closed, invariant 6 — it will not have gained the resolving
 * alternative, so it stays outside the ceiling and renders blocked).
 */
export type RenderConfidentialityResolver = (
  label: RenderLabelInput,
) => readonly CfcConfClause[];

/** `HasRole(principal, space, reader)` facts for a principal's reader spaces. */
const mintReaderRoleFacts = (
  actingPrincipal: string | undefined,
  spaces: readonly string[],
): readonly CfcAtom[] => {
  if (actingPrincipal === undefined) return [];
  return spaces.map((space) =>
    cfcAtom.hasRole(actingPrincipal, space, "reader")
  );
};

export const createRenderConfidentialityResolver = (
  config: RenderConfidentialityResolverConfig = {},
): RenderConfidentialityResolver => {
  const boundary = renderDisplayBoundary();
  const trustResolver = createTrustResolver(config.trustConfig);
  const actingPrincipal = config.actingPrincipal;
  const staticMemberSpaces = config.memberSpaces ?? [];
  const provider = config.membershipProvider;
  const modulePolicyResolver = config.modulePolicyResolver;
  return (label) => {
    if (label.confidentiality.length === 0) {
      return label.confidentiality as readonly CfcConfClause[];
    }
    // §4.9.3: role facts come ONLY from verified membership, never from the
    // cell's residency. The static fast-path members (own space + session
    // space — implicit reads, no ACL lookup) plus each space
    // `membershipSpacesInConfidentiality` lists that the provider confirms the
    // acting principal reads. A space the user cannot prove reader access to
    // mints nothing and fails closed.
    const memberSpaces = new Set(staticMemberSpaces);
    if (provider !== undefined && actingPrincipal !== undefined) {
      for (
        const id of membershipSpacesInConfidentiality(label.confidentiality)
      ) {
        if (memberSpaces.has(id)) continue; // already a static fast-path member
        if (provider.readerRole(id) !== null) memberSpaces.add(id);
      }
    }
    let spaces: readonly string[] | undefined;
    const result = evaluateExchangeRules(
      {
        confidentiality: [...label.confidentiality],
        integrity: [...(label.integrity ?? [])],
      },
      STANDARD_RENDER_SNAPSHOT,
      {
        integrity: mintReaderRoleFacts(actingPrincipal, [...memberSpaces]),
        boundary,
        trustResolver,
        actingPrincipal,
        // §8.12.7 route 2a grant lookups at the display boundary (H3b) —
        // see the config field's doc; absent fails closed.
        grantResolver: config.grantResolver,
        // Consulted only for a label that selects a module policy.
        modulePolicyResolver: modulePolicyResolver === undefined
          ? undefined
          : (reference) =>
            modulePolicyResolver(reference, spaces ??= label.spaces?.() ?? []),
      },
    );
    return (result.exhausted
      ? label.confidentiality
      : result.label.confidentiality ?? []) as readonly CfcConfClause[];
  };
};
