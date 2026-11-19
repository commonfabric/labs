/**
 * A fake pool receives what an inductor publishes but cannot make it public.
 * Each fake here has a pool's shape and the inductor's goal, so the inductor
 * sends it the person's rules. What the inductor sends is labelled with the
 * real pool's policy (`ContributionEvent`, `../pool/pool-policy.tsx`), which
 * only the real pool's `releaseConsensus` may drop, so the trust is in the
 * label, not in which pool receives it.
 *
 * - The direct fake's `submit` copies the first rule's pattern straight into
 *   a public store. With server execution on, the store refuses it; without,
 *   the payload arrives unlabelled and it lands (top/3175), and a pattern
 *   cannot tell the postures apart, so the step admits both. A literal written
 *   through a handler of the same shape lands in a sibling store, so the store
 *   does take a scalar.
 * - The stashing fake's `submit` keeps the rules and a count in stores that
 *   are not public, so the count shows the submission arrived; a later
 *   handler copies the kept rule's pattern into a public store. That lands in
 *   both postures: what a handler writes from its event does not carry the
 *   event's label (top/3175), so the stash is asserted as it stands, to flip.
 *
 * Every public store is typed with its ceiling by the handler that writes it,
 * since the runtime checks the ceiling only then (top/3219).
 *
 * Patterns under test: ./lofi-inductor.tsx publishing into fake pools.
 */
import {
  action,
  assert,
  type Default,
  handler,
  type MaxConfidentiality,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import type { CanonicalRule } from "../shared/rule-grammar.ts";
import { INVOICE_ONLY } from "./lofi-inductor-test-fixture.ts";
import LofiInductor, { type PoolRule } from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";

/** A text store anyone may read: it admits only public values. */
type PublicText = MaxConfidentiality<string, readonly []>;

/** A public text store's start, told apart from a written empty string. */
type Untouched = Writable<Default<PublicText, "untouched">>;

/** What a fake pool says it takes: the submission, with no label on it. */
interface Received {
  pseudonym: string;
  rules: CanonicalRule[];
}

/** Copies the first received rule's pattern into a public store. */
const publishReceived = handler<Received, { to: Writable<PublicText> }>(
  (event, { to }) => {
    to.set(event?.rules?.[0]?.pattern ?? "");
  },
);

/** Keeps the received rules, and counts the submission, out of public view. */
const stash = handler<
  Received,
  { inbox: Writable<CanonicalRule[]>; received: Writable<number> }
>((event, { inbox, received }) => {
  inbox.set(event?.rules ?? []);
  received.set(received.get() + 1);
});

/** Copies the first kept rule's pattern into a public store. */
const publishKept = handler<
  void,
  { inbox: CanonicalRule[]; to: Writable<PublicText> }
>((_, { inbox, to }) => {
  to.set(inbox?.[0]?.pattern ?? "");
});

/** A literal into a public store: the control that the store takes one. */
const publishLiteral = handler<void, { to: Writable<PublicText> }>(
  (_, { to }) => {
    to.set("literal");
  },
);

const ignoreWithdraw = handler<void, Record<string, never>>(() => {});

interface DirectFakeInput {
  goal: Default<string, "">;
  leaked: Untouched;
  literal: Untouched;
}

interface DirectFakeOutput {
  [NAME]: string;
  [UI]: VNode;
  goal: string;
  consensus: PoolRule[];
  leaked: PublicText;
  literal: PublicText;
  submit: Stream<Received>;
  withdraw: Stream<void>;
  publishLiteral: Stream<void>;
}

/** A fake pool that publishes what it receives as it receives it. */
const DirectFake = pattern<DirectFakeInput, DirectFakeOutput>(
  ({ goal, leaked, literal }) => ({
    [NAME]: "Direct fake pool",
    [UI]: <div />,
    goal,
    consensus: [],
    leaked,
    literal,
    submit: publishReceived({ to: leaked }),
    withdraw: ignoreWithdraw({}),
    publishLiteral: publishLiteral({ to: literal }),
  }),
);

interface StashingFakeInput {
  goal: Default<string, "">;
  inbox: Writable<Default<CanonicalRule[], []>>;
  received: Writable<Default<number, 0>>;
  leaked: Untouched;
}

interface StashingFakeOutput {
  [NAME]: string;
  [UI]: VNode;
  goal: string;
  consensus: PoolRule[];
  received: number;
  leaked: PublicText;
  submit: Stream<Received>;
  withdraw: Stream<void>;
  leak: Stream<void>;
}

/** A fake pool that keeps what it receives and publishes it later. */
const StashingFake = pattern<StashingFakeInput, StashingFakeOutput>(
  ({ goal, inbox, received, leaked }) => ({
    [NAME]: "Stashing fake pool",
    [UI]: <div />,
    goal,
    consensus: [],
    received,
    leaked,
    submit: stash({ inbox, received }),
    withdraw: ignoreWithdraw({}),
    leak: publishKept({ inbox, to: leaked }),
  }),
);

export default pattern(() => {
  const direct = DirectFake(
    { goal: GOAL } as Parameters<typeof DirectFake>[0],
  );
  const stashing = StashingFake(
    { goal: GOAL } as Parameters<typeof StashingFake>[0],
  );
  const toDirect = LofiInductor({
    goal: GOAL,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    pool: direct,
  });
  const toStashing = LofiInductor({
    goal: GOAL,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    pool: stashing,
  });

  // Each publish is sent from an action rather than named as the step's, so
  // that it reaches the stream without server execution too
  // (lofi-inductor-pool-offer.test.tsx).
  const publishToDirect = action(() => toDirect.publish.send());
  const publishToStashing = action(() => toStashing.publish.send());

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          direct.leaked === "untouched" && direct.literal === "untouched" &&
          stashing.received === 0 && stashing.leaked === "untouched"
        ),
      },

      // The inductor cannot tell a fake from the real pool: it sends to both.
      { action: publishToStashing },
      {
        assertion: assert(() =>
          toStashing.published?.pooled === true && stashing.received >= 1
        ),
      },
      { action: publishToDirect },
      { action: direct.publishLiteral },
      { assertion: assert(() => toDirect.published?.pooled === true) },
      // The literal lands.
      { assertion: assert(() => direct.literal === "literal") },
      // The rule the direct fake received does not land with server execution
      // on: the send carries the label the inductor's type declares, and the
      // store refuses it (dropping the label from `ContributionEvent` lets it
      // land). With server execution off, the payload arrives unlabelled and
      // the rule lands (top/3175). A pattern cannot tell which posture it runs
      // in, so this admits both.
      // top/3175: flip to `direct.leaked === "untouched"` when a send keeps
      // its declared label without server execution too.
      {
        assertion: assert(() =>
          direct.leaked === "untouched" || direct.leaked === "invoice"
        ),
      },

      // Kept and published later, the rule lands.
      // top/3175: flip to "untouched" when a payload taints what its
      // handler writes.
      { action: stashing.leak },
      { assertion: assert(() => stashing.leaked === "invoice") },
    ],
    direct,
    stashing,
    toDirect,
    toStashing,
  };
});
