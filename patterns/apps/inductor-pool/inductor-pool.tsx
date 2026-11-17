/**
 * Inductor pool: one goal's lo-fi rules, contributed under pseudonyms, and
 * released once enough distinct pseudonyms hold the same rule. See README.md
 * for the design and its CFC debt.
 *
 * The pool's policy releases what one function of this module computed,
 * `releaseConsensus`, as `examples/cfc-exchange-rules/blessed-computation.tsx`
 * releases a tally. Contributions and the pool secret carry
 * `PolicyOf<typeof poolRules>`; the store everyone reads admits only public
 * values; and the one exchange rule drops the policy's clause on a value the
 * runtime stamped `TransformedBy` this module's `releaseConsensus`. So the
 * released rules and their counts reach the public store, and nothing else of
 * a contribution or the secret can.
 */

import {
  type AuthoredByCurrentUser,
  computed,
  type Confidential,
  currentPrincipal,
  type Default,
  FS,
  handler,
  lift,
  linksOf,
  type MaxConfidentiality,
  NAME,
  pattern,
  principalOf,
  type Stream,
  UI,
  type VNode,
  type Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";
import { describeRule } from "../lofi-inductor/rule-grammar.ts";
import {
  type CanonicalRule,
  canonicalSet,
  type Contribution,
  DEFAULT_JITTER,
  DEFAULT_THRESHOLD_CENTER,
  MIN_THRESHOLD,
  mintSecret,
  type ReleasedRule,
  releaseFrom,
  tallyAll,
} from "./consensus.ts";

export type { CanonicalRule, Contribution, ReleasedRule } from "./consensus.ts";

// =============================================================================
// POLICY
// =============================================================================

// The one release. When every write of a transaction comes from one verified
// function, the runtime stamps what it writes `TransformedBy`, naming the
// function's module by content identity and the function by its export name.
// `THIS_POLICY.moduleIdentity` is this module's identity, which covers what it
// imports (`consensus.ts`, the rule grammar), so the rule names this module's
// `releaseConsensus` however the module is edited.
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
  { pseudonym: string; rules: PrivateRule[] },
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

/**
 * The key of each rule's threshold offset: readable only through the policy,
 * and written only by `submitContribution`, which mints it once. Code that
 * could set it could choose every offset.
 */
export type PoolSecret = WriteAuthorizedBy<
  Confidential<string, readonly [PolicyOf<typeof poolRules>]>,
  typeof submitContribution
>;

/**
 * What everyone may read: it admits only public values, and only
 * `publishRelease` writes it, so no other code can post a rule as released
 * and no writer can declare it without its ceiling.
 */
export type PublicRelease = WriteAuthorizedBy<
  MaxConfidentiality<ReleasedRule[], readonly []>,
  typeof publishRelease
>;

// =============================================================================
// THE RELEASED COMPUTATION
// =============================================================================

interface ReleaseInput {
  contributions: Contribution[] | undefined;
  secret: string | undefined;
  thresholdCenter: number;
  jitter: number;
}

/**
 * The pool's one released function: the rules at least their threshold of
 * distinct pseudonyms hold, with their counts, and nothing else. The secret,
 * the offsets, and every count below threshold stay inside it.
 *
 * CFC DEBT, cut 1 (distinct people): this counts distinct pseudonyms. The
 * pool binds each pseudonym to one authenticated principal and each principal
 * to one pseudonym (`submitContribution`), but nothing attests that two
 * principals are two people. Principled CFC would have the threshold count an
 * attested distinct-principal (personhood) atom on each contribution, so the
 * release rule itself could require N distinct attested people.
 */
export const releaseConsensus = lift((input: ReleaseInput): ReleasedRule[] =>
  releaseFrom(input.contributions, input.secret, {
    thresholdCenter: input.thresholdCenter,
    jitter: input.jitter,
  })
);

/**
 * Every rule with its count, threshold or not. Defined beside
 * `releaseConsensus` but named by no rule, so what it computes stays
 * confidential: the pool's tests show the public store refuses it.
 */
export const tallyEveryRule = lift(
  (contributions: Contribution[] | undefined): ReleasedRule[] =>
    tallyAll(contributions),
);

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * The index of the contribution `actor` already holds under `pseudonym`, or
 * -1 when they hold none. Throws when `actor` holds one under another
 * pseudonym, or another principal holds `pseudonym`: a pseudonym is one
 * principal's, and a principal has one.
 */
function slotOf(
  contributions: Writable<StoredContribution[]>,
  actor: string,
  pseudonym: string,
): number {
  const stored = contributions.get();
  let mine = -1;
  for (let i = 0; i < stored.length; i++) {
    const author = principalOf(contributions.key(i), "authored-by");
    const sameName = stored[i]?.pseudonym === pseudonym;
    if (author === actor && !sameName) {
      throw new Error(
        "You already contribute to this pool under another pseudonym.",
      );
    }
    if (author !== actor && sameName) {
      throw new Error("That pseudonym belongs to another contributor.");
    }
    if (author === actor) mine = i;
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
  secret: Writable<PoolSecret | undefined>;
  release: Stream<void>;
}

/** What `publishRelease` is bound to. */
export interface PublishState {
  from: ReleasedRule[];
  to: Writable<PublicRelease>;
}

/** A contribution as `submit` takes it. */
export interface ContributionEvent {
  pseudonym: string;
  rules: CanonicalRule[];
}

/**
 * Takes one pseudonym's whole rule set, replacing any set it gave before.
 *
 * The pool binds a pseudonym to the principal who first used it here and a
 * principal to one pseudonym: the stored contribution's `authored-by` label is
 * the runtime's, so a contributor cannot submit under someone else's
 * pseudonym, or under a second one of their own to be counted twice. A
 * refused submission throws and stores nothing. Every rule is checked against
 * the grammar again and stored in canonical form.
 *
 * CFC DEBT, cut 2 (pseudonym linkability): the `authored-by` label, and the
 * commit that writes the contribution, name the contributor's core identity,
 * and anyone who can read the pool space can read both. Principled CFC would
 * have the contributor's runtime sign with an intermediate key chained from
 * the per-goal pseudonym (profile-delegation.md, "Attribution and
 * unlinkability"), the server attest that the pseudonym committed, and the
 * label name the pseudonym, unlinkable to its owner and their other
 * pseudonyms.
 */
export const submitContribution = handler<ContributionEvent, SubmitState>(
  (event, { contributions, secret, release }) => {
    const actor = currentPrincipal();
    if (actor === undefined) {
      throw new Error("A contribution needs an authenticated contributor.");
    }
    const pseudonym = typeof event?.pseudonym === "string"
      ? event.pseudonym.trim()
      : "";
    if (pseudonym === "") throw new Error("A contribution needs a pseudonym.");
    const rules = canonicalSet(event?.rules);
    const mine = slotOf(contributions, actor, pseudonym);

    // Randomness is allowed only in a handler, so the first contribution mints
    // the secret. A concurrent first contribution conflicts on it and, retried,
    // reads the one that landed.
    if (!secret.get()) secret.set(mintSecret(Math.random) as PoolSecret);

    const contribution = {
      pseudonym,
      rules: rules.map((rule) => rule as PrivateRule),
    } as StoredContribution;
    // A replacement drops the old entry and appends the new one rather than
    // setting the slot in place: after an in-place set, the slot's
    // `authored-by` reads as no one (README.md, "CFC snags").
    if (mine >= 0) {
      const kept = (linksOf(contributions) ?? []).filter((_, i) => i !== mine);
      contributions.set([...kept, contribution] as StoredContribution[]);
    } else contributions.push(contribution);
    release.send();
  },
);

/** Copies the released rules into the public store. */
export const publishRelease = handler<void, PublishState>((_, { from, to }) => {
  to.set(
    (from ?? []).map((rule) => ({
      field: rule.field,
      pattern: rule.pattern,
      predicts: rule.predicts,
      key: rule.key,
      count: rule.count,
    })),
  );
});

// =============================================================================
// PATTERN
// =============================================================================

interface InductorPoolInput {
  /** The yes-or-no question this pool collects rules for. */
  goal: Default<string, "">;
  /** The threshold a rule has before its offset. */
  thresholdCenter: Default<number, typeof DEFAULT_THRESHOLD_CENTER>;
  /** The bound `k` of each rule's offset, in `[-k, +k]`. */
  jitter: Default<number, typeof DEFAULT_JITTER>;
  /** One entry per contributor, written only by `submit`. */
  contributions: Writable<Default<StoredContribution[], []>>;
  /**
   * The threshold offsets' key, minted by the first contribution. It has no
   * default: a confidential default written beside the public `released`
   * makes the piece's start commit refuse (README.md, "CFC snags").
   */
  secret: Writable<PoolSecret | undefined>;
  /** The released rules, which anyone may read. */
  released: Writable<Default<PublicRelease, []>>;
}

/**
 * A #inductorPool: collects lo-fi rules for one goal under per-goal
 * pseudonyms and releases a rule, with its count, once enough distinct
 * pseudonyms hold it. Lo-fi inductors find one with
 * `wish({ query: "#inductorPool" })`.
 */
export interface InductorPoolOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  goal: string;
  thresholdCenter: number;
  jitter: number;
  /** The stored contributions, confidential to the pool's policy. */
  contributions: StoredContribution[];
  /** The released rules and their counts. */
  released: PublicRelease;
  /**
   * What `releaseConsensus` computes now: the rules at threshold and their
   * counts. The policy releases it, and `release` copies it into `released`.
   */
  consensus: ReleasedRule[];
  /** How many rules are released. */
  releasedCount: number;
  /** Contribute (or replace) one pseudonym's rule set. */
  submit: Stream<ContributionEvent>;
  /** Copy what is released into `released`; `submit` does this too. */
  release: Stream<void>;
}

export default pattern<InductorPoolInput, InductorPoolOutput>(
  ({ goal, thresholdCenter, jitter, contributions, secret, released }) => {
    const consensus = releaseConsensus({
      contributions,
      secret,
      thresholdCenter,
      jitter,
    });
    const release = publishRelease({ from: consensus, to: released });
    const submit = submitContribution({ contributions, secret, release });

    const releasedCount = computed(() => released.get().length);
    const title = computed(() => {
      const question = goal.trim();
      return question ? `Inductor pool: ${question}` : "Inductor pool";
    });
    const configLine = computed(() =>
      `A rule is released once ${thresholdCenter} ± ${jitter} distinct ` +
      `contributors hold it (never fewer than ${MIN_THRESHOLD}); each ` +
      `rule's exact threshold is hidden.`
    );
    const countLine = computed(() => {
      const n = released.get().length;
      return n === 1 ? "1 rule released." : `${n} rules released.`;
    });
    const releasedLines = computed(() =>
      released.get().map((rule: ReleasedRule) => ({
        rule: describeRule(rule),
        count: `${rule.count} contributors`,
      }))
    );
    const content = computed(() =>
      [
        `# ${title}`,
        "",
        configLine,
        "",
        ...released.get().map((rule: ReleasedRule) =>
          `- \`${describeRule(rule)}\` (${rule.count} contributors)`
        ),
      ].join("\n")
    );

    return {
      [NAME]: title,
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="2">
            <cf-heading level={4}>{title}</cf-heading>
            <span>{configLine}</span>
          </cf-vstack>
          <cf-vscroll>
            <cf-vstack gap="3" style="padding: 1rem;">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>Released rules</cf-heading>
                  <span id="inductor-pool-count">{countLine}</span>
                  {releasedLines.map((line) => (
                    <cf-hstack gap="2">
                      <code style="flex: 1;">{line.rule}</code>
                      <span>{line.count}</span>
                    </cf-hstack>
                  ))}
                </cf-vstack>
              </cf-card>
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>Contribute</cf-heading>
                  <span>
                    Publish from a lo-fi inductor for this goal. It sends its
                    accepted rules under your one pseudonym for the goal, and
                    publishing again replaces what you sent before. No one
                    learns a rule you hold until enough others hold it too.
                  </span>
                </cf-vstack>
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content,
      },
      goal,
      thresholdCenter,
      jitter,
      contributions,
      released,
      consensus,
      releasedCount,
      submit,
      release,
    };
  },
);
