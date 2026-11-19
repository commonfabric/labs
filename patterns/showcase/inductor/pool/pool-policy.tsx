/**
 * The inductor pool's policy, and the one code that writes what it guards.
 * See README.md for the design and its CFC debt.
 *
 * The policy releases what one function of this module computed,
 * `releaseConsensus`, as `examples/cfc-exchange-rules/blessed-computation.tsx`
 * releases a tally. Contributions, and the seal inside them, carry
 * `PolicyOf<typeof poolRules>`, and the one exchange rule drops the policy's
 * clause on a value the runtime stamped `TransformedBy` this module's
 * `releaseConsensus`, over inputs this module's `submitContribution` wrote.
 * So the released rules and their counts are public, and nothing else of a
 * contribution is.
 *
 * The rule names this module by `THIS_POLICY.moduleIdentity`, its content
 * identity with everything it imports (`consensus.ts`, the rule grammar).
 * The pattern and its view live in `inductor-pool.tsx`, which this module does
 * not import, so editing the view leaves the identity, and every stored
 * contribution's clause, as it was.
 */

import {
  type AuthoredByCurrentUser,
  type Confidential,
  currentPrincipal,
  handler,
  lift,
  principalOf,
  type Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";
import {
  type CanonicalRule,
  canonicalSet,
  type Contribution,
  isSealed,
  mintSeal,
  type PoolSeal,
  type ReleasedRule,
  releaseSealed,
  tallyAll,
} from "./consensus.ts";

//
// The policy
//

// The one release. When every write of a transaction comes from one verified
// function, the runtime stamps what it writes `TransformedBy`, naming the
// function's module by content identity and the function by its export name.
// `THIS_POLICY.moduleIdentity` is this module's identity, so the rule names
// this module's `releaseConsensus` however the module is edited.
//
// The identity alone would release whatever `releaseConsensus` computed over
// any input a caller chose: a copy of the contributions with each one doubled
// under a made-up pseudonym, say. The `inputWitness` requires that every
// confidential input it read was written by this module's
// `submitContribution`, so a contribution list any other code wrote, or added
// to, is refused (docs/specs/cfc-transformed-by-input-witnesses.md). The
// secret and threshold travel inside the contributions (`PoolSeal`), so they
// are witnessed too: a public input does not constrain the witness, so a
// threshold or secret passed beside the contributions would be the caller's
// to choose.
export const releaseThresholdConsensus = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "releaseConsensus",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "submitContribution",
        },
      },
    }],
  },
  post: { dropClause: true },
});

export const poolRules = exchangeRules([releaseThresholdConsensus]);

/**
 * One contributed rule, readable only through the pool's policy. Each rule
 * object is a document of its own, which the contribution's label does not
 * reach, so the rule carries the label too.
 */
export type PrivateRule = Confidential<
  CanonicalRule,
  readonly [PolicyOf<typeof poolRules>]
>;

/** A contribution, readable only through the pool's policy. */
export type PrivateContribution = Confidential<
  {
    contributor: string;
    pseudonym: string;
    rules: PrivateRule[];
    seal: PoolSeal;
  },
  readonly [PolicyOf<typeof poolRules>]
>;

/**
 * A stored contribution: written only by `submitContribution`, and labelled
 * `authored-by` the principal it acted for. The policy is the element's, at
 * its position in the list, so no other code can push, replace, or re-point
 * one, and the author label is the runtime's, not anything the contributor
 * says.
 */
export type StoredContribution = AuthoredByCurrentUser<
  WriteAuthorizedBy<PrivateContribution, typeof submitContribution>
>;

//
// The released computation
//

/**
 * The pool's one released function: the rules at least their threshold of
 * distinct contributors hold, with their counts, and nothing else. It takes the
 * contributions alone; the secret and threshold are the seal they carry, so
 * the secret, the offsets, and every count below threshold stay inside it,
 * and a caller chooses none of them.
 *
 * It is a module-scope `lift`, not a `computed()` in the pattern, because
 * `TransformedBy` names a function by its module and export name, and only an
 * exported, named function has both. The same holds for `tallyEveryRule`.
 *
 * CFC DEBT, cut 1 (distinct people): this counts distinct principals, as
 * `submitContribution` stamped them, so one principal counts once even over
 * entries they replaced or withdrew; but nothing attests that two principals
 * are two people. Principled CFC would have the threshold count an
 * attested distinct-principal (personhood) atom on each contribution, so the
 * release rule itself could require N distinct attested people.
 */
export const releaseConsensus = lift(
  (contributions: Contribution[] | undefined): ReleasedRule[] =>
    releaseSealed(contributions),
);

/**
 * Every rule with its count, threshold or not. Defined beside
 * `releaseConsensus` but named by no rule, so what it computes stays
 * confidential. The pool's tests check a public store refuses it when the
 * writing handler types the store with its ceiling; one that does not is not
 * checked today (top/3219).
 */
export const tallyEveryRule = lift(
  (contributions: Contribution[] | undefined): ReleasedRule[] =>
    tallyAll(contributions),
);

//
// The one writer
//

/**
 * The index of the contribution `actor` holds, or -1 when they hold none.
 * Throws when another principal holds `pseudonym`, if one is given: a
 * pseudonym is one principal's.
 */
function slotOf(
  contributions: Writable<StoredContribution[]>,
  actor: string,
  pseudonym?: string,
): number {
  const stored = contributions.get();
  let mine = -1;
  for (let i = 0; i < stored.length; i++) {
    const author = principalOf(contributions.key(i), "authored-by");
    if (author === actor) mine = i;
    else if (pseudonym !== undefined && stored[i]?.pseudonym === pseudonym) {
      throw new Error("That pseudonym belongs to another contributor.");
    }
  }
  return mine;
}

/**
 * What `submitContribution` is bound to. The handler writes through these
 * declarations, so they carry the labels; an interface, unlike an inline type,
 * may name the handler it belongs to.
 */
export interface SubmitState {
  contributions: Writable<StoredContribution[]>;
  /** The threshold the first contribution seals; ignored after that. */
  thresholdCenter: number;
  jitter: number;
  /**
   * Set for the binding behind `withdraw`: the event is ignored, and the
   * sender's entry is taken out.
   */
  withdrawing?: boolean;
}

/**
 * A contribution as `submit` takes it, labelled with the pool's policy as the
 * stored contribution is. A sender types what it sends this way, so the rules
 * it sends carry the policy wherever they land: a pool that is not this one
 * receives them, but nothing it writes them into is public, since only this
 * module's `releaseConsensus` may drop the clause. Each rule is a document of
 * its own, so it carries the label too.
 */
export type ContributionEvent = Confidential<
  {
    pseudonym: string;
    rules: PrivateRule[];
  },
  readonly [PolicyOf<typeof poolRules>]
>;

/**
 * Takes a contributor's whole rule set, replacing any set they gave before,
 * or, bound `withdrawing`, removes theirs.
 *
 * A contributor is the principal the runtime labels their contribution
 * `authored-by`, not the pseudonym they send: each principal holds one entry,
 * so no one is counted twice. A principal who sends a pseudonym other than the
 * one they hold replaces their entry under the new one; nothing links the two
 * that the `authored-by` label did not already. A pseudonym another principal
 * holds is refused, so no one contributes under someone else's. A refused
 * submission throws and stores nothing. Every rule is checked against the
 * grammar again and stored in canonical form.
 *
 * The pool binds this one handler twice, as `submit` and as `withdraw`, so
 * every write to the contributions is this one function's, which is what the
 * release's input witness and the stored entries' `WriteAuthorizedBy` name.
 *
 * CFC DEBT, cut 2 (pseudonym linkability): the `authored-by` label, and the
 * commit that writes the contribution, name the contributor's core identity,
 * and anyone who can read the pool space can read both. Principled CFC would
 * have the contributor's runtime sign with an intermediate key chained from
 * the per-goal pseudonym (profile-delegation.md, "Attribution and
 * unlinkability"), the server attest that the pseudonym committed, and the
 * label name the pseudonym, unlinkable to its owner and their other
 * pseudonyms. Because the release is exact and live, the signed commit that
 * moves a released rule's count also says whose contribution holds it.
 */
export const submitContribution = handler<ContributionEvent, SubmitState>(
  (event, { contributions, thresholdCenter, jitter, withdrawing }) => {
    const actor = currentPrincipal();
    if (actor === undefined) {
      throw new Error("A contribution needs an authenticated contributor.");
    }
    if (withdrawing === true) {
      const mine = slotOf(contributions, actor);
      if (mine >= 0) contributions.removeByValue(contributions.key(mine));
      return;
    }
    const pseudonym = typeof event?.pseudonym === "string"
      ? event.pseudonym.trim()
      : "";
    if (pseudonym === "") throw new Error("A contribution needs a pseudonym.");
    const rules = canonicalSet(event?.rules);
    const mine = slotOf(contributions, actor, pseudonym);

    // Randomness is allowed only in a handler, so the first contribution mints
    // the secret, and seals the threshold beside it; every later one copies
    // that seal. A concurrent first contribution conflicts on the list, which
    // this handler read, and, retried, copies the seal that landed. Once every
    // contributor has withdrawn, the next contribution seals afresh.
    // A pool's threshold never goes under `MIN_SEALED_THRESHOLD`: `mintSeal`
    // refuses a lower centre and narrows the jitter, and a copied seal that
    // breaks the floor (a list this handler did not start) is refused here,
    // as the release would refuse it.
    const first = contributions.get()[0]?.seal;
    if (first !== undefined && !isSealed(first)) {
      throw new Error("The pool's seal is not one this pool could mint.");
    }
    const seal = first ?? mintSeal(Math.random, { thresholdCenter, jitter });

    // The contributor is the runtime's principal for this run, written only
    // here, so the release counts each principal once, old entries included.
    const contribution = {
      contributor: actor,
      pseudonym,
      rules,
      seal: {
        secret: seal.secret,
        thresholdCenter: seal.thresholdCenter,
        jitter: seal.jitter,
      },
    };
    // A replacement removes the old entry and appends the new one rather than
    // setting the slot in place: after an in-place set, the slot's
    // `authored-by` reads as no one (README.md, "CFC snags"). It does not
    // rebuild the list either, which would copy every other entry's
    // reference into a new slot.
    if (mine >= 0) contributions.removeByValue(contributions.key(mine));
    contributions.push(contribution);
  },
);
