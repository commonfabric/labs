import type { CfcAtom } from "@commonfabric/api/cfc";
import { deepFreeze, hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  type AtomPattern,
  isAtomPattern,
  matchAtomPattern,
} from "./atom-pattern.ts";

/**
 * User-scoped trust closure (spec §4.8, Epic B3 of
 * docs/history/plans/cfc-future-work-implementation.md §3): concept guards in
 * exchange rules and integrity floors are satisfied from CONCRETE carried
 * integrity via the acting principal's trust closure — trust statements bind
 * concrete principals to concepts, verifier delegations decide whose
 * statements an acting principal accepts, and concept edges order concepts.
 *
 * Mirrors the policy-record posture: a deployment-configured, frozen trust
 * set on `RuntimeOptions` — and, per the revised B2b decision (SC-28 in
 * docs/specs/cfc-spec-changes.md), the enduring form: remote attestation
 * covers deployment config for security-sensitive inputs, so attested
 * federated peers provably share it and space-hosted stores are not needed
 * for federation soundness. Deployment config is already operator-trusted;
 * signed, space-hosted trust statements would need their own motivation.
 *
 * Determinism contract (the folded-in "trust-snapshot determinism" item):
 * `conceptSatisfied` is a pure function of (frozen config, arguments) — no
 * clock, no ambient lookups. Config identity is covered by `digest`; the
 * Runtime's default `trustSnapshotProvider` folds that digest into
 * `TrustSnapshot.revision`, so a config change invalidates prepared digests
 * the same way any trust-snapshot change does. Hosts supplying a custom
 * provider must fold their own trust-config versioning into `revision`.
 */

/**
 * "`verifier` asserts that atoms matching `concrete` implement concept
 * `implements`" (spec §4.8.2, minus the signature — see module doc). The
 * concrete side is an `AtomPattern`, so one statement can cover a family
 * (e.g. any `TransformedBy` naming a specific codeHash); a fully concrete
 * atom is the degenerate exact-match pattern.
 */
export type CfcTrustStatement = {
  readonly concrete: AtomPattern;
  readonly implements: string;
  readonly verifier: string;
};

/**
 * "`delegator` accepts `verifier`'s statements for `concepts`" (spec §4.8.3).
 * `delegator: "*"` is the deployment-root form — every acting principal
 * accepts the verifier (the degenerate single-trust-root case, like B2a's
 * policy scoping). `concepts: "*"` covers all concepts.
 */
export type CfcVerifierDelegation = {
  readonly delegator: string;
  readonly verifier: string;
  readonly concepts: readonly string[] | "*";
};

/**
 * Deployment-defined concept ordering edge (spec §4.8.9 `conceptEdges`):
 * satisfying `from` satisfies `to`. NOT per-user — statements are the
 * user-scoped layer; edges are policy structure.
 */
export type CfcConceptEdge = {
  readonly from: string;
  readonly to: string;
};

/** Authoring form for `RuntimeOptions.cfcTrustConfig`. */
export type CfcTrustConfigInput = {
  readonly statements?: readonly CfcTrustStatement[];
  readonly delegations?: readonly CfcVerifierDelegation[];
  readonly conceptEdges?: readonly CfcConceptEdge[];
};

/** Validated, digested, deep-frozen trust config held by the Runtime. */
export type CfcTrustConfig = {
  readonly statements: readonly CfcTrustStatement[];
  readonly delegations: readonly CfcVerifierDelegation[];
  readonly conceptEdges: readonly CfcConceptEdge[];
  readonly digest: string;
};

/**
 * Concept-edge closure depth bound. The visited set already makes traversal
 * cycle-safe; the explicit bound additionally pins the semantics — a chain
 * needing more than this many concept-to-concept hops fails CLOSED, so the
 * answer never depends on traversal order or an implementation's appetite
 * for deep recursion. Sixteen is far above any sane policy's concept
 * hierarchy.
 */
export const MAX_TRUST_CLOSURE_DEPTH = 16;

const CONFIG_KEYS = new Set(["statements", "delegations", "conceptEdges"]);
const STATEMENT_KEYS = new Set(["concrete", "implements", "verifier"]);
const DELEGATION_KEYS = new Set(["delegator", "verifier", "concepts"]);
const EDGE_KEYS = new Set(["from", "to"]);

// Same fail-closed posture as policy.ts: trust config is enforcement config,
// so malformation throws at Runtime boot naming the offending entry — a
// typo'd key must not become a silently inert (or silently widened) trust
// edge.
const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`cfcTrustConfig: unknown key "${key}" in ${where}`);
    }
  }
};

const requireNonEmptyString = (
  value: unknown,
  where: string,
): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`cfcTrustConfig: ${where} must be a non-empty string`);
  }
  return value;
};

const requireEntryRecord = (
  value: unknown,
  where: string,
): Record<string, unknown> => {
  if (!isObjectNotArray(value)) {
    throw new Error(`cfcTrustConfig: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
};

const requireEntryArray = (value: unknown, where: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`cfcTrustConfig: ${where} must be an array`);
  }
  return value;
};

/**
 * Validates, digests, and deep-freezes a deployment trust config (mirrors
 * `buildCfcPolicySnapshot`). `undefined` in → `undefined` out (no trust
 * configured: every concept guard fails closed).
 */
export const buildCfcTrustConfig = (
  input: CfcTrustConfigInput | undefined,
): CfcTrustConfig | undefined => {
  if (input === undefined) return undefined;
  const root = requireEntryRecord(input, "config");
  rejectUnknownKeys(root, CONFIG_KEYS, "config");

  const statements: CfcTrustStatement[] = [];
  if (root.statements !== undefined) {
    for (const entry of requireEntryArray(root.statements, "statements")) {
      const statement = requireEntryRecord(entry, "statement");
      rejectUnknownKeys(statement, STATEMENT_KEYS, "statement");
      if (statement.concrete === undefined) {
        throw new Error(
          "cfcTrustConfig: statement needs a concrete atom pattern",
        );
      }
      if (!isAtomPattern(statement.concrete)) {
        throw new Error(
          "cfcTrustConfig: statement.concrete is not a `FabricValue`",
        );
      }
      statements.push({
        concrete: statement.concrete,
        implements: requireNonEmptyString(
          statement.implements,
          "statement.implements",
        ),
        verifier: requireNonEmptyString(
          statement.verifier,
          "statement.verifier",
        ),
      });
    }
  }

  const delegations: CfcVerifierDelegation[] = [];
  if (root.delegations !== undefined) {
    for (const entry of requireEntryArray(root.delegations, "delegations")) {
      const delegation = requireEntryRecord(entry, "delegation");
      rejectUnknownKeys(delegation, DELEGATION_KEYS, "delegation");
      const concepts = delegation.concepts;
      if (concepts !== "*") {
        for (
          const concept of requireEntryArray(
            concepts,
            "delegation.concepts",
          )
        ) {
          requireNonEmptyString(concept, "delegation.concepts entry");
        }
      }
      delegations.push({
        delegator: requireNonEmptyString(
          delegation.delegator,
          "delegation.delegator",
        ),
        verifier: requireNonEmptyString(
          delegation.verifier,
          "delegation.verifier",
        ),
        concepts: concepts as readonly string[] | "*",
      });
    }
  }

  const conceptEdges: CfcConceptEdge[] = [];
  if (root.conceptEdges !== undefined) {
    for (const entry of requireEntryArray(root.conceptEdges, "conceptEdges")) {
      const edge = requireEntryRecord(entry, "concept edge");
      rejectUnknownKeys(edge, EDGE_KEYS, "concept edge");
      conceptEdges.push({
        from: requireNonEmptyString(edge.from, "concept edge from"),
        to: requireNonEmptyString(edge.to, "concept edge to"),
      });
    }
  }

  return deepFreeze({
    statements,
    delegations,
    conceptEdges,
    digest: hashStringOf({
      version: 1,
      statements,
      delegations,
      conceptEdges,
    }),
  });
};

export type TrustResolver = {
  /**
   * Is concept `concept` satisfied by some concrete atom of
   * `integrityAtoms` under `actingPrincipal`'s trust closure (spec §4.8.9)?
   *
   * Per-user scoping (invariant 11): the concrete atoms are portable — the
   * SAME atoms evaluate under each recipient's own closure — but which
   * statements create edges depends on the acting principal's delegations
   * (`delegator: "*"` deployment-root delegations apply to everyone,
   * including an undefined acting principal). Everything else fails closed:
   * no config, no matching statement, no admissible delegation, or a
   * concept-edge chain longer than {@link MAX_TRUST_CLOSURE_DEPTH}.
   */
  conceptSatisfied(
    concept: string,
    integrityAtoms: readonly CfcAtom[],
    actingPrincipal: string | undefined,
  ): boolean;
};

/**
 * Builds the resolver for a frozen config. Pure: the resolver closes over
 * the config value only, and `conceptSatisfied` consults nothing else — see
 * the module determinism contract.
 */
export const createTrustResolver = (
  config: CfcTrustConfig | undefined,
): TrustResolver => ({
  conceptSatisfied(concept, integrityAtoms, actingPrincipal) {
    if (config === undefined) return false;
    if (integrityAtoms.length === 0) return false;

    // Statements admissible for this acting principal (spec §4.8.9
    // trustedEdgesForUser): some delegation by the acting principal (or the
    // deployment root "*") names the statement's verifier and covers the
    // statement's concept.
    const admissible = config.statements.filter((statement) =>
      config.delegations.some((delegation) =>
        (delegation.delegator === "*" ||
          delegation.delegator === actingPrincipal) &&
        delegation.verifier === statement.verifier &&
        (delegation.concepts === "*" ||
          delegation.concepts.includes(statement.implements))
      )
    );
    if (admissible.length === 0) return false;

    // Concepts directly implemented by some carried concrete atom.
    const reached = new Set<string>();
    for (const statement of admissible) {
      if (reached.has(statement.implements)) continue;
      if (
        integrityAtoms.some((atom) =>
          matchAtomPattern(statement.concrete, atom) !== null
        )
      ) {
        reached.add(statement.implements);
      }
    }
    if (reached.has(concept)) return true;

    // Bounded transitive closure over concept edges (breadth-first: `depth`
    // counts edge hops from a directly-implemented concept).
    let frontier = [...reached];
    for (
      let depth = 0;
      depth < MAX_TRUST_CLOSURE_DEPTH && frontier.length > 0;
      depth++
    ) {
      const next: string[] = [];
      for (const edge of config.conceptEdges) {
        if (frontier.includes(edge.from) && !reached.has(edge.to)) {
          reached.add(edge.to);
          next.push(edge.to);
        }
      }
      if (reached.has(concept)) return true;
      frontier = next;
    }
    return false;
  },
});
