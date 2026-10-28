/**
 * Home's private-inbox refusal notice when another principal created the
 * refused inbox, each user in a runtime of their own: the stranger creates an
 * inbox, whose offers carry the stranger's confidentiality label, and the
 * owner's Home records a refusal of it and shows the owner the refusal's code
 * and time. `inspectConfLabel` reports no user's label on the notice's
 * sentence, which it does report once the notice reads the refused inbox's
 * offers.
 */
import {
  action,
  assert,
  type Cell,
  equals,
  handler,
  inspectConfLabel,
  multiUserTest,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNodeById, hasText } from "../test/vnode-helpers.ts";
import Home, { type HomeOutput } from "./home.tsx";
import { refusalReasonText } from "./private-inbox-refusal-text.ts";
import PrivateInbox, {
  type PrivateInboxHolder,
  type PrivateInboxPiece,
} from "./private-inbox.tsx";

/** When the test's refusal was first recorded. */
const REFUSED_AT = Date.UTC(2026, 9, 9, 12, 0, 0);

/** An inbox's result, as the link a holder keeps. */
function linkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function linkOf(inbox: unknown): unknown {
  return inbox;
}

/** Creates an inbox, owned by the principal sending the event. */
const createInbox = handler<void, { inbox: Writable<PrivateInboxHolder> }>(
  (_event, { inbox }) => {
    inbox.set({ piece: linkOf(PrivateInbox({ offers: [] })) });
  },
);

interface Setup {
  home: HomeOutput;
  strangerInbox: PrivateInboxHolder;
  createStrangerInbox: Stream<void>;
}

export const setup = pattern(() => {
  const strangerInbox = new Writable<PrivateInboxHolder>({}).for(
    "strangerInbox",
  );
  return {
    home: Home({}),
    strangerInbox,
    createStrangerInbox: createInbox({ inbox: strangerInbox }),
  };
});

export const owner = pattern<{ setup: Setup }>(({ setup }) => {
  const record_refusal = action(() => {
    const inbox = setup.strangerInbox.piece;
    if (inbox === undefined) return;
    setup.home.privateInboxRefusal.set({
      refusal: {
        reason: "inbox-adoption-acl-mismatch",
        inbox,
        refusedAt: REFUSED_AT,
      },
    });
  });
  const refusal_names_strangers_inbox = assert(() =>
    setup.strangerInbox.piece !== undefined &&
    equals(
      setup.home.privateInboxRefusal.get().refusal?.inbox,
      setup.strangerInbox.piece,
    )
  );
  // The notice's explanation, by its place in Home's rendering: the screen's
  // header slot, the notice, its alert, the alert's description, then the
  // first line's sentence.
  // deno-lint-ignore no-explicit-any
  const ui = setup.home[UI] as any;
  const explanation =
    ui.children[2].children[0].children[0].children[1].children[0].children[2];
  const explanationLabel = inspectConfLabel(explanation, "", {
    atomType: "https://commonfabric.org/cfc/atom/User",
  });
  // The explanation is the sentence for the refusal's code, and
  // `inspectConfLabel` reports no user's label on it. `notAvailable` is also
  // what a path reaching nothing gives, so the sentence is checked too.
  const explanation_carries_no_users_label = assert(() =>
    explanation === refusalReasonText("inbox-adoption-acl-mismatch") &&
    explanationLabel.status === "notAvailable"
  );
  const notice_shown = assert(() =>
    hasText(
      findNodeById(setup.home[UI], "home-private-inbox-refusal"),
      "Reason: inbox-adoption-acl-mismatch.",
    ) &&
    hasText(
      findNodeById(setup.home[UI], "home-private-inbox-refusal"),
      "First noticed 10/9/2026, 12:00:00 PM UTC.",
    )
  );
  return {
    [TESTS]: [
      { await: "inbox-created" },
      { action: record_refusal },
      { assertion: refusal_names_strangers_inbox },
      { assertion: notice_shown },
      { assertion: explanation_carries_no_users_label },
    ],
  };
});

export const stranger = pattern<{ setup: Setup }>(({ setup }) => {
  const create_inbox = action(() => {
    setup.createStrangerInbox.send();
  });
  return {
    [TESTS]: [
      { action: create_inbox },
      { label: "inbox-created" },
    ],
  };
});

export default multiUserTest({ setup, participants: { owner, stranger } });
