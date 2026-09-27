/**
 * A room whose members' stances are sealed into its policy's custody, and
 * whose policy releases only what one function of its own module projects
 * from them, once per instance.
 *
 * A member reviews a stance in the trusted host's `cf-custody-seal` dialog,
 * which a room binds as `<cf-custody-seal $draft $terms={terms}
 * $policy={policy} $sources $box={box} />`, with the member's own draft and
 * source policy from the member's home space. The host seals the stance into
 * the instance's box: one document in this room's space, which every
 * member's seal writes an entry into and which names no member. The pattern
 * never holds a member's DID, the box's address, or its own policy's
 * reference, and needs none of them:
 *
 * - The terms name each seat by a cell whose stored label attests one
 *   principal, as a member's profile does. The host resolves each to the DID
 *   it seals.
 * - `policy` is declared `PolicyOf` the room's rules, so its label carries
 *   the policy's reference with this room as its subject, and the host reads
 *   the reference from there.
 * - When a member seals, the seal writes a link to the box into `box`, in
 *   the transaction that writes the member's entry.
 *
 * Every entry of the box is labeled with the room's policy, and the box
 * itself with the policy or the room's readers, so what the pattern computes
 * from it is shown to anyone only through `releaseChoice`. That rule drops
 * the policy from what `projectChoice` returns, one of the listed answers,
 * when everything confidential `projectChoice` read was written by the seal
 * (`TransformedBy{builtin cfc-custody-seal}` as its input witness): the box
 * the seal linked into `box`, and not a document other code put there, which
 * could repeat another member's entry or mix it with entries it made up. A
 * member's rating, and anything else computed from the box, stays sealed.
 * The stances hold a bounded array of closed ratings, one per option, which
 * is the shape the seal admits for a multiple choice.
 *
 * `choice` is reactive, so the room shows the host's `cf-custody-answer`
 * instead, which asks the seal to publish `choice` once every seat has sealed
 * and the rule releases it. The seal writes it once into the instance's
 * answer slot, and the component shows what the slot holds, verified to be
 * the seal's write. What the room's readers are shown then cannot move,
 * whatever later points the projector at other input. `docs/specs/cfc-custody-seal.md` says what this does not cover.
 */

import {
  type Confidential,
  Default,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const releaseChoice = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "projectChoice",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: { kind: "builtin", builtinId: "cfc-custody-seal" },
      },
    }],
  },
  post: { dropClause: true },
});

export const custodyRules = exchangeRules([releaseChoice]);

/** Labeled with the room's policy: only `projectChoice`'s output leaves. */
export type Sealed<T> = Confidential<
  T,
  readonly [PolicyOf<typeof custodyRules>]
>;

/** The options a stance rates, in the order its ratings list them. */
export const OPTIONS = ["pizza", "sushi", "tacos"] as const;

/** The answer when no option suits every seat, or the room is incomplete. */
export const NO_AGREEMENT = "no agreement";

export type Rating = "no" | "maybe" | "yes";

/** One member's sealed stance: a rating per option. */
export interface Stance {
  ratings: Rating[];
}

/** One entry of the box, as the seal writes it. */
export interface BoxEntry {
  instance: string;
  terms: string;
  stance: Stance;
}

/** The instance's box: entries keyed by a blinded key that names no member. */
export type Box = Record<string, BoxEntry>;

/**
 * The stance schema the terms carry: a closed rating per option, which the
 * seal admits as an array whose one element schema is closed and whose
 * length is bounded.
 */
export const STANCE_SCHEMA = {
  type: "object",
  properties: {
    ratings: {
      type: "array",
      items: { enum: ["no", "maybe", "yes"] },
      minItems: OPTIONS.length,
      maxItems: OPTIONS.length,
    },
  },
  required: ["ratings"],
  additionalProperties: false,
};

/**
 * The released computation: the option no seat rated `no` that the most
 * seats rated `yes`, the earliest listed winning a tie. It answers
 * {@link NO_AGREEMENT} unless every entry was sealed under the same terms and
 * there is one entry per seat, and it never throws.
 */
export const projectChoice = lift((box: Box | undefined): string => {
  const entries = Object.values(box ?? {});
  const terms = entries[0]?.terms;
  if (
    terms === undefined || entries.some((entry) => entry?.terms !== terms)
  ) return NO_AGREEMENT;
  let seats: unknown;
  try {
    seats = (JSON.parse(terms) as { seats?: unknown }).seats;
  } catch {
    return NO_AGREEMENT;
  }
  if (!Array.isArray(seats) || seats.length !== entries.length) {
    return NO_AGREEMENT;
  }
  let best: string = NO_AGREEMENT;
  let bestYes = -1;
  OPTIONS.forEach((option, index) => {
    const ratings = entries.map((entry) => entry?.stance?.ratings?.[index]);
    if (ratings.some((rating) => rating !== "yes" && rating !== "maybe")) {
      return;
    }
    const yes = ratings.filter((rating) => rating === "yes").length;
    if (yes > bestYes) {
      best = option;
      bestYes = yes;
    }
  });
  return best;
});

/** Defined beside `projectChoice` but not named by the rule, so not released. */
export const firstRating = lift((box: Box | undefined): string =>
  Object.values(box ?? {})[0]?.stance?.ratings?.[0] ?? ""
);

/** The room's terms, as `propose` writes them. */
export interface CustodyTerms {
  question: string;
  answers: string[];
  /** A cell per seat, whose stored label attests the seat's member. */
  seats: unknown[];
  stanceSchema: typeof STANCE_SCHEMA;
}

interface CustodyProjectorInput {
  terms: Writable<Default<CustodyTerms | null, null>>;
  /**
   * Declared with the room's policy, so that once written its label carries
   * the policy's reference, with this room as its subject, for the host to
   * read. It has no default: `propose` writes it.
   */
  policy: Writable<Sealed<boolean>>;
  /**
   * Receives a link to the instance's box from the host once a seat seals.
   * It declares no label of its own: every entry of the box already carries
   * the room's policy, and a read through the link carries it.
   *
   * TODO(custody-box-link): declaring `Record<string, Sealed<BoxEntry>>` here
   * is refused. Repro: give `box` that type, then write a link to the sealed
   * box into it as `cf-custody-seal` does, a blind UI write
   * (`runtime.commitUiCellWrite(cell, link, { blind: true })`); commit
   * preparation crashes with `type changed incompatibly at /box: ["object"]
   * -> ["array"]`, as the schema merge sets the input's record schema
   * against an array schema. `integration/cfc-custody-projector.test.ts`
   * makes that write; change this type back to reproduce.
   */
  box: Writable<Default<Box, Record<string, never>>>;
}

export interface CustodyProjectorOutput {
  [NAME]: string;
  [UI]: VNode;
  terms: CustodyTerms | null;
  policy: Sealed<boolean>;
  box: Box;
  /**
   * The projected answer, which moves with what the projector reads. The
   * room shows the answer the seal published from it instead.
   */
  choice: string;
  /** One member's sealed rating, which no rule releases. */
  rating: string;
  propose: Stream<{ seats: unknown[] }>;
}

/**
 * Writes the room's terms, naming each seat by the cell the event carries,
 * and declares the room's policy on `policy`.
 */
const propose = handler<
  { seats: unknown[] },
  { terms: Writable<CustodyTerms | null>; policy: Writable<Sealed<boolean>> }
>(({ seats }, { terms, policy }) => {
  terms.set({
    question: "Where should we eat?",
    answers: [...OPTIONS, NO_AGREEMENT],
    seats,
    stanceSchema: STANCE_SCHEMA,
  });
  policy.set(true as Sealed<boolean>);
});

const CustodyProjector = pattern<
  CustodyProjectorInput,
  CustodyProjectorOutput
>(({ terms, policy, box }) => {
  const choice = projectChoice(box);
  const rating = firstRating(box);
  return {
    [NAME]: "Sealed custody projector",
    [UI]: (
      <cf-screen title="Sealed custody projector">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <cf-label>The room's choice</cf-label>
          <cf-custody-answer
            id="custody-projector-choice"
            $terms={terms}
            $policy={policy}
            $output={choice}
          />
        </cf-vstack>
      </cf-screen>
    ),
    terms,
    policy,
    box,
    choice,
    rating,
    propose: propose({ terms, policy }),
  };
});

export default CustodyProjector;
