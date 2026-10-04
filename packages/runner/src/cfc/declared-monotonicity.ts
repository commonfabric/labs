import { deepEqual } from "@commonfabric/utils/deep-equal";
import { hashStringOf } from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type CfcConfClause,
  clauseSubsumes,
  normalizeClause,
} from "./clause.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import type { CfcDeclaredWideningExemption, LabelMapEntry } from "./types.ts";

/**
 * The declared-component monotonicity gate (WP5; spec §8.12.1/§8.12.8;
 * docs/specs/cfc-persisted-declassification.md §4 item 3).
 *
 * A persisted path's DECLARED (store-policy) label component evolves only
 * through the schema-walk re-mint in `prepare.ts`. §8.12.1's
 * `canUpdateStoreLabel` — the semantics of record is the Lean mechanization
 * (`formal/Cfc/Store.lean`: `ConfLe`/`ClauseLe`/`IntegLe`) — requires every
 * update to be monotone:
 *
 * - **Confidentiality (CNF)** may only become more restrictive: every stored
 *   clause must still be present-or-strengthened in the proposal (the clause
 *   set may grow; an existing clause's alternative set may only shrink).
 *   The witness relation is `clauseSubsumes(proposed, stored)` — every
 *   alternative of the proposed clause entails some alternative of the
 *   stored clause (`alts(p) ⊆ alts(s)` modulo per-family entailment) —
 *   exactly the Lean `ClauseLe stored proposed`. `clauseSubsumes` fails
 *   closed on an empty proposed clause, so an unsatisfiable stored clause
 *   can never be re-witnessed: fail-closed, and seeded-metadata-only.
 * - **The declared integrity claim** may only remove atoms (weaker claims
 *   are safe; the store must not become more trusted "for free"): every
 *   proposed atom must already be in the stored set, by canonical structural
 *   equality.
 *
 * Scope (§8.12.8): the gate governs ONLY entries with `origin: "declared"`
 * on BOTH sides. Derived / link-carried / structure components follow
 * replace-on-overwrite disciplines, and legacy (origin-less) entries keep
 * the historical combined rules — none of them are ever compared here.
 *
 * A consequence worth stating plainly: schema mints that vary per write —
 * an `addIntegrity` current-principal claim resolving to a different acting
 * principal, a copied `exactCopyOf` label whose source changed — are
 * non-monotone declared updates by construction under `enforce`. That is
 * §8.12.1 semantics, not an accident: per-value evidence belongs in the
 * derived component, and the dial ships default-`observe` while those
 * mints migrate.
 *
 * The one sanctioned exception (§8.12.7 route 2b — the future
 * declassification-event writer) is the per-transaction privileged
 * exemption: it names exactly one (doc, path, clauseDigest) triple, where
 * `clauseDigest` is `cfcCanonicalClauseDigest` of the STORED clause being
 * dropped or widened. Integrity violations are never exemptable.
 */

/**
 * Canonical clause digest — clause identity for the exemption seam and the
 * future §4 event record (`{doc, path, clauseDigest, …}`). Clause indices
 * are evaluation-ephemeral; the digest of the canonicalized clause (
 * alternatives deduped and hash-sorted, singleton unwrapped) is not.
 */
export const cfcCanonicalClauseDigest = (clause: CfcConfClause): string =>
  hashStringOf(normalizeClause(clause));

const samePath = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((segment, index) => segment === right[index]);

/**
 * Compare the declared entries a prepare walk is about to persist against
 * the stored declared entries at the same paths; return one stable reason
 * string per violated §8.12.1 direction (empty = monotone). Stored declared
 * entries at paths the walk does not re-mint are carried forward verbatim by
 * the persist loop and need no check; proposed entries at paths with no
 * stored declared entry are creations, which monotonicity does not
 * constrain.
 */
export const collectDeclaredMonotonicityViolations = (input: {
  space: MemorySpace;
  docId: string;
  storedEntries: readonly LabelMapEntry[];
  proposedEntries: readonly LabelMapEntry[];
  exemption?: CfcDeclaredWideningExemption;
}): string[] => {
  const violations: string[] = [];
  const proposedDeclared = input.proposedEntries
    .filter((entry) => entry.origin === "declared")
    .map((entry) => ({
      path: canonicalizeLogicalPath(entry.path),
      label: entry.label,
    }));
  const exemption = input.exemption !== undefined &&
      input.exemption.space === input.space &&
      input.exemption.id === input.docId
    ? input.exemption
    : undefined;
  // Both sides are compared as the per-path JOIN of same-path declared
  // entries, not entry-by-entry (codex/cubic review on this PR). The walk
  // mints at most one declared entry per path (divergent-branch ifc is
  // rejected at merge time), but STORED metadata is data — peers/hydration
  // can present duplicates — and reads join same-component entries at one
  // path. Joining means: the stored clause set is the union across the
  // group (all clauses apply — a stored clause survives if ANY proposed
  // entry witnesses it), and the stored integrity CLAIM is the union of
  // atoms any same-path declared entry already claimed — keeping such an
  // atom is a shrink of the claim, not an addition, so proposed [X] against
  // stored entries [X] and [Y] is monotone.
  const storedByPath = new Map<
    string,
    { path: readonly string[]; entries: LabelMapEntry[] }
  >();
  for (const stored of input.storedEntries) {
    if (stored.origin !== "declared") {
      continue;
    }
    // A declared entry with no label values declares no policy to keep: it
    // marks a writer-claimed position so a write there is routed to the
    // claim (the persist loop mints one for a claimed position that holds
    // nothing yet). The writer's first write, which mints the position's
    // real label — an `addIntegrity` claim among it — is a creation as far
    // as monotonicity is concerned, not an addition to an empty claim.
    if (
      (stored.label.confidentiality?.length ?? 0) === 0 &&
      (stored.label.integrity?.length ?? 0) === 0
    ) {
      continue;
    }
    const storedPath = canonicalizeLogicalPath(stored.path);
    const key = JSON.stringify(storedPath);
    const group = storedByPath.get(key);
    if (group === undefined) {
      storedByPath.set(key, { path: storedPath, entries: [stored] });
    } else {
      group.entries.push(stored);
    }
  }
  for (const { path: storedPath, entries: storedAt } of storedByPath.values()) {
    const proposedAt = proposedDeclared.filter((entry) =>
      samePath(entry.path, storedPath)
    );
    if (proposedAt.length === 0) {
      continue;
    }
    const at = `for ${input.docId} at /${storedPath.join("/")}`;
    const proposedClauses = proposedAt.flatMap((entry) =>
      entry.label.confidentiality ?? []
    );
    // Duplicate stored clauses across group entries would repeat the same
    // reason; report each canonical clause once.
    const reportedClauses = new Set<string>();
    for (const stored of storedAt) {
      for (const storedClause of stored.label.confidentiality ?? []) {
        const witnessed = proposedClauses.some((proposedClause) =>
          clauseSubsumes(
            proposedClause as CfcConfClause,
            storedClause as CfcConfClause,
          )
        );
        if (witnessed) {
          continue;
        }
        const storedDigest = cfcCanonicalClauseDigest(
          storedClause as CfcConfClause,
        );
        if (
          exemption !== undefined &&
          samePath(exemption.path, storedPath) &&
          exemption.clauseDigest === storedDigest
        ) {
          // The sanctioned §8.12.7 route 2b exemption: exactly this stored
          // clause, at exactly this path of exactly this doc, may be dropped
          // or widened in this transaction.
          continue;
        }
        if (reportedClauses.has(storedDigest)) {
          continue;
        }
        reportedClauses.add(storedDigest);
        violations.push(
          `declared-monotonicity confidentiality violation ${at} ` +
            `(canUpdateStoreLabel, §8.12.1): stored clause ` +
            `${
              JSON.stringify(normalizeClause(storedClause as CfcConfClause))
            } dropped or ` +
            `weakened ` +
            `(clauses may be added and alternatives removed, never the reverse)`,
        );
      }
    }
    const storedIntegrity = storedAt.flatMap((stored) =>
      stored.label.integrity ?? []
    );
    // A proposed atom repeated across proposed entries would repeat the
    // reason; report each atom once.
    const reportedAtoms = new Set<string>();
    for (const proposedEntry of proposedAt) {
      for (const atom of proposedEntry.label.integrity ?? []) {
        if (storedIntegrity.some((storedAtom) => deepEqual(storedAtom, atom))) {
          continue;
        }
        const atomKey = hashStringOf(atom);
        if (reportedAtoms.has(atomKey)) {
          continue;
        }
        reportedAtoms.add(atomKey);
        violations.push(
          `declared-monotonicity integrity violation ${at} ` +
            `(canUpdateStoreLabel, §8.12.1): integrity atom ` +
            `${JSON.stringify(atom)} added ` +
            `(the declared integrity claim may only remove atoms)`,
        );
      }
    }
  }
  return violations;
};
