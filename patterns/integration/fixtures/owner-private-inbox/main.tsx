/**
 * Creates an owner-private inbox in a space of its own, and gives a sender and
 * a stranger handlers of their own that reach it. Fixture for
 * `owner-private-inbox-multi-runtime.test.ts`.
 */

import {
  Default,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Inbox, { type InboxOutput, type Offer } from "./inbox.tsx";

export interface CreateEvent {
  /** Whether every principal may write the inbox's space, not only its owner. */
  open: boolean;
}

const create = handler<CreateEvent, { inboxes: Writable<InboxOutput[]> }>(
  (event, { inboxes }) => {
    const factory = event.open
      ? Inbox.inSpace(undefined, { grants: { "*": "WRITE" } })
      : Inbox.inSpace();
    inboxes.push(factory({ title: "Offers", offers: [] }));
  },
);

const offer = handler<Offer, { inboxes: Writable<InboxOutput[]> }>(
  (event, { inboxes }) => {
    inboxes.key(0).resolveAsCell().key("receive").send({ note: event.note });
  },
);

const copyTitle = handler<
  void,
  { inboxes: Writable<InboxOutput[]>; copiedTitle: Writable<string> }
>((_event, { inboxes, copiedTitle }) => {
  copiedTitle.set(inboxes.key(0).resolveAsCell().key("title").get() ?? "");
});

const copyOffers = handler<
  void,
  { inboxes: Writable<InboxOutput[]>; copiedOffers: Writable<Offer[]> }
>((_event, { inboxes, copiedOffers }) => {
  const offers = inboxes.key(0).resolveAsCell().key("offers").get() as
    | Offer[]
    | undefined;
  copiedOffers.set((offers ?? []).map((item) => ({ note: `${item.note}` })));
});

export interface ManagerInput {
  inboxes: Writable<Default<InboxOutput[], []>>;
  copiedTitle: Writable<Default<string, "">>;
  copiedOffers: Writable<Default<Offer[], []>>;
}

export interface ManagerOutput {
  [NAME]: string;
  [UI]: VNode;
  inboxes: InboxOutput[];
  copiedTitle: string;
  copiedOffers: Offer[];

  /** Creates the inbox in a new space, owned by the event's actor. */
  create: Stream<CreateEvent>;

  /** Sends an offer to the inbox, from the event's actor's own handler. */
  offer: Stream<Offer>;

  /** Copies the inbox's public title into this piece. */
  copyTitle: Stream<void>;

  /** Copies the inbox's offers into this piece. */
  copyOffers: Stream<void>;
}

export default pattern<ManagerInput, ManagerOutput>((
  { inboxes, copiedTitle, copiedOffers },
) => ({
  [NAME]: "Owner-private inbox manager fixture",
  [UI]: <div>owner-private inbox manager fixture</div>,
  inboxes,
  copiedTitle,
  copiedOffers,
  create: create({ inboxes }),
  offer: offer({ inboxes }),
  copyTitle: copyTitle({ inboxes, copiedTitle }),
  copyOffers: copyOffers({ inboxes, copiedOffers }),
}));
