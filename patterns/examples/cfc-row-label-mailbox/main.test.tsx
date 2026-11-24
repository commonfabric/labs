/**
 * Tests the per-row labeled mailbox: seeded mail lists in the inbox with an
 * authorship claim only where the row's auth evidence shows dmarc=pass, the
 * Alice+Bob slice drops the row with other participants, COUNT(*) refuses,
 * and the compose form's write gate admits a draft whose sender holds an
 * address and refuses one whose sender holds none.
 *
 * Run: deno task cf test patterns/examples/cfc-row-label-mailbox/main.test.tsx
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  countElements,
  findNodeById,
  fireClick,
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import Mailbox from "./main.tsx";

const inboxCount = (view: unknown): number =>
  countElements(findNodeById(view, "inbox-list"), "cf-card");
const sliceCount = (view: unknown): number =>
  countElements(findNodeById(view, "slice-list"), "cf-label");
const textOf = (view: unknown, id: string): string =>
  textContent(findNodeById(view, id));

export default pattern(() => {
  const draftFrom = Writable.of("");
  const draftTo = Writable.of("");
  const draftBody = Writable.of("");
  const subject = Mailbox({ draftFrom, draftTo, draftBody });

  return {
    // The draft whose sender holds no address is refused by throwing, which
    // is the write gate failing closed.
    expectRuntimeErrors: [
      'rowLabel rule rejected the INSERT (row 0): field "from_addr" is non-empty but matched nothing',
    ],
    [TESTS]: [
      {
        assertion: assert(() =>
          subject[NAME] === "Per-Row Labeled Mailbox (CFC Phase 3)"
        ),
      },
      { assertion: assert(() => inboxCount(subject[UI]) === 0) },

      {
        action: action(() =>
          fireClick(findNodeById(subject[UI], "seed-button"))
        ),
      },
      { settle: true },

      { assertion: assert(() => inboxCount(subject[UI]) === 2) },
      // The inbox aliases from_addr to sender, and each row says whether its
      // auth evidence minted an authorship claim.
      {
        assertion: assert(() =>
          hasText(
            findNodeById(subject[UI], "inbox-list"),
            "#1 from Alice Example <Alice@A.example> → bob@example.com",
          ) &&
          hasText(
            findNodeById(subject[UI], "inbox-list"),
            "auth: spf=pass dmarc=pass dkim=pass ⟹ claimed-authored-by minted",
          )
        ),
      },
      {
        assertion: assert(() =>
          hasText(
            findNodeById(subject[UI], "inbox-list"),
            "#2 from carol@c.example",
          ) &&
          hasText(
            findNodeById(subject[UI], "inbox-list"),
            "no auth evidence ⟹ no authorship claim",
          )
        ),
      },
      // Carol's mail to Dave and Erin exceeds the slice's ceiling and is
      // skipped; Alice's mail to Bob fits.
      { assertion: assert(() => sliceCount(subject[UI]) === 1) },
      {
        assertion: assert(() =>
          hasText(findNodeById(subject[UI], "slice-list"), "Lunch tomorrow?") &&
          !hasText(
            findNodeById(subject[UI], "slice-list"),
            "Quarterly numbers attached.",
          )
        ),
      },
      {
        assertion: assert(() =>
          textOf(subject[UI], "count-error").includes(
            "cannot be re-labeled on a row-rule-bearing db",
          )
        ),
      },

      // A draft with a sender address passes the write gate and clears the
      // body.
      {
        action: action(() => {
          draftFrom.set("alice@a.example");
          draftTo.set("bob@example.com");
          draftBody.set("See you at noon.");
        }),
      },
      {
        action: action(() =>
          fireClick(findNodeById(subject[UI], "send-button"))
        ),
      },
      { settle: true },
      { assertion: assert(() => inboxCount(subject[UI]) === 3) },
      {
        assertion: assert(() =>
          hasText(
            findNodeById(subject[UI], "inbox-list"),
            "#3 from alice@a.example → bob@example.com",
          ) &&
          hasText(findNodeById(subject[UI], "slice-list"), "See you at noon.")
        ),
      },
      { assertion: assert(() => draftBody.get() === "") },

      // A sender of "nobody" is non-empty but holds no address for the row's
      // sender principal, which must match at least one, so the write gate
      // refuses the INSERT: nothing is inserted and the draft keeps its body.
      {
        action: action(() => {
          draftFrom.set("nobody");
          draftBody.set("Anonymous note.");
        }),
      },
      {
        action: action(() =>
          fireClick(findNodeById(subject[UI], "send-button"))
        ),
      },
      { settle: true },
      { assertion: assert(() => inboxCount(subject[UI]) === 3) },
      {
        assertion: assert(() =>
          !hasText(subject[UI], "Anonymous note.") &&
          draftBody.get() === "Anonymous note."
        ),
      },
    ],
    subject,
  };
});
