/**
 * A room whose members' stances are sealed into its policy's custody, and
 * whose policy releases only what one function of its own module projects
 * from them, once per instance.
 *
 * This is `custody-projector.tsx` with the release rule a room over sealed
 * custody is meant to take, and showing the answer the seal publishes rather
 * than its reactive projection. That room stays as it was recorded, with the
 * weaker rule, because the rule is part of the policy its `policy` cell
 * declares: a room of it keeps its sealed values under that policy.
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
 * from it leaves the policy only through `releaseChoice`. That rule releases
 * what `projectChoice` returns, one of the listed answers, to the seal alone
 * (`Builtin{cfc-custody-seal}`, a reader no member holds), when everything
 * confidential `projectChoice` read was written by the seal
 * (`TransformedBy{builtin cfc-custody-seal}` as its input witness): the box
 * the seal linked into `box`, and not a document other code put there, which
 * could repeat another member's entry or mix it with entries it made up. A
 * member's rating, and anything else computed from the box, stays sealed.
 * The stances hold a bounded array of closed ratings, one per option, which
 * is the shape the seal admits for a multiple choice.
 *
 * `choice`, the projection, is read by no member. It is reactive, and a
 * member's code can point the projector at input of its own; an answer that
 * does not change keeps its earlier stamp, so were `choice` readable, it
 * would say whether that input yields the released answer. The room shows the
 * host's `cf-custody-answer` instead, which asks the seal to publish `choice`
 * once every seat has sealed and the rule releases it to the seal. The seal
 * declassifies it once into the instance's answer slot, which the room's
 * readers can read, and the component shows what the slot holds, verified to
 * be the seal's write. The slot is create-only and the seal's alone to
 * write, so the answer published for an instance never changes, whatever
 * later points the projector at other input and whoever writes what.
 *
 * Which instance the room shows is not held against a member's own code. The
 * component shows the slot of the instance its bound `terms` digest to, under
 * the policy its bound `policy` names, and those bindings sit in the room's
 * result document and UI, which the room space's members can write and no
 * writer claim covers. A member's code can point them at another instance's
 * terms, such as those of a one-seat room the member sealed and published
 * alone, whose answer the room then shows as its own, or at terms whose slot
 * is empty.
 *
 * `terms` and `policy` are write-once here as defense in depth: each carries a
 * writer claim naming `propose`, and `propose` writes each only while it reads
 * as unwritten. That refuses a write to the room's argument document by any
 * other code, through any schema, and nothing more. Write authority is keyed
 * by code, not by piece (normative CFC §8.15.8), so a member's own instance of
 * this pattern bound beneath these cells runs an authorized `propose`, and a
 * source update's successor inherits this one's authority.
 * `docs/specs/cfc-custody-seal.md` says what closing this would take, and
 * what else the room does not cover.
 *
 * Whoever runs `propose` first writes the terms, and anyone who can write in
 * the room space can run it, with seats of their choosing, before the room's
 * own proposal does. The room does not guard against that: it records no
 * creator to check the sender against, and a guard requiring the sender to
 * hold a seat would admit any sender that seats itself. What that costs is
 * the room, not a member's consent. The seal's confirmation shows every seat,
 * and a member seals only under terms that seat them, so terms the members
 * did not agree to leave the room with no answer, and the remedy is another
 * room.
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
  type WriteAuthorizedBy,
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
  // Released to the seal alone, which publishes it once per instance; no
  // member reads the projection itself.
  post: {
    addAlternatives: [{
      type: "https://commonfabric.org/cfc/atom/Builtin",
      name: "cfc-custody-seal",
    }],
  },
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

/**
 * The room's terms, which only the code of `propose` may write, and which it
 * writes only while it reads them as unwritten. The host shows the slot of the
 * instance the terms digest to, so terms rewritten after the answer is
 * published would have the room show another instance's slot, or an empty one.
 */
export type ProposedTerms = WriteAuthorizedBy<CustodyTerms, typeof propose>;

/**
 * The room's policy cell, which only the code of `propose` may write, and
 * which it writes only while it reads it as unwritten, for the same reason: the
 * host reads the slot under the policy this cell names.
 */
export type DeclaredPolicy = WriteAuthorizedBy<Sealed<boolean>, typeof propose>;

interface CustodyAnswerRoomInput {
  /**
   * Absent until `propose` writes it. It has no default: on
   * `CustodyTerms | null`, the writer claim would sit on the object branch
   * alone and not refuse a write of `null`, which would let other code clear
   * the terms for `propose` to write again.
   */
  terms: Writable<ProposedTerms>;
  /**
   * Declared with the room's policy, so that once written its label carries
   * the policy's reference, with this room as its subject, for the host to
   * read. It has no default: `propose` writes it.
   */
  policy: Writable<DeclaredPolicy>;
  /**
   * Receives a link to the instance's box, which the seal writes in the
   * transaction that writes a member's entry. It declares no label of its
   * own: every entry of the box already carries the room's policy, and a
   * read through the link carries it.
   *
   * TODO(custody-box-link): declaring `Record<string, Sealed<BoxEntry>>` here
   * is refused. Repro: give `box` that type and seal into the room, as
   * `integration/cfc-custody-projector.test.ts` does; the seal's commit
   * preparation crashes with `type changed incompatibly at /box: ["object"]
   * -> ["array"]`, as the schema merge sets the input's record schema
   * against an array schema.
   */
  box: Writable<Default<Box, Record<string, never>>>;
}

export interface CustodyAnswerRoomOutput {
  [NAME]: string;
  [UI]: VNode;
  terms?: CustodyTerms;
  policy: Sealed<boolean>;
  box: Box;
  /**
   * The projected answer, which moves with what the projector reads. It is
   * released to the seal alone, which publishes it; no member reads it, and
   * the room shows the answer the seal published instead.
   */
  choice: string;
  /** One member's sealed rating, which no rule releases. */
  rating: string;
  propose: Stream<{ seats: unknown[] }>;
}

/**
 * Writes the room's terms, naming each seat by the cell the event carries,
 * and declares the room's policy on `policy`, each only while it is
 * unwritten. Each guard reads the cell it writes and nothing else, so the
 * room's own stream, run again, finds what the first proposal wrote and
 * writes nothing. An instance of this pattern bound elsewhere reads its own
 * binding instead; the doc comment at the top says what the claims leave
 * open.
 */
const propose = handler<
  { seats: unknown[] },
  { terms: Writable<CustodyTerms>; policy: Writable<Sealed<boolean>> }
>(({ seats }, { terms, policy }) => {
  if (terms.get() === undefined) {
    terms.set({
      question: "Where should we eat?",
      answers: [...OPTIONS, NO_AGREEMENT],
      seats,
      stanceSchema: STANCE_SCHEMA,
    });
  }
  if (policy.get() === undefined) policy.set(true as Sealed<boolean>);
});

const CustodyAnswerRoom = pattern<
  CustodyAnswerRoomInput,
  CustodyAnswerRoomOutput
>(({ terms, policy, box }) => {
  const choice = projectChoice(box);
  const rating = firstRating(box);
  return {
    [NAME]: "Sealed custody answer room",
    [UI]: (
      <cf-screen title="Sealed custody answer room">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <cf-label>The room's choice</cf-label>
          <cf-custody-answer
            id="custody-answer-room-choice"
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

export default CustodyAnswerRoom;
