/**
 * A private inbox: a list its owner creates, labeled for the owner and with
 * each item labeled for the owner as well, which anyone holding the inbox can
 * append to. Fixture for `owner-private-inbox-multi-runtime.test.ts`.
 */

import {
  type Confidential,
  type CurrentPrincipal,
  Default,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface Offer {
  note: string;
}

/** Readable only by the principal the store is bound to. */
export type OwnerPrivate<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

type Offers = OwnerPrivate<OwnerPrivate<Offer>[]>;

const receive = handler<Offer, { offers: Writable<Offers> }>(
  (event, { offers }) => {
    offers.push({ note: event.note });
  },
);

export interface InboxInput {
  title: Default<string, "">;
  offers: Writable<Default<Offers, []>>;
}

export interface InboxOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  offers: Offers;

  /** Appends an offer, whoever sends it. */
  receive: Stream<Offer>;
}

export default pattern<InboxInput, InboxOutput>(({ title, offers }) => ({
  [NAME]: "Owner-private inbox fixture",
  [UI]: <div>owner-private inbox fixture</div>,
  title,
  offers,
  receive: receive({ offers }),
}));
