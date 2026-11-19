/**
 * Redactor pattern tests: what gets replaced, how a reply is restored, and the
 * CFC boundary — the redacted draft may be written to the model's public
 * prompt, the raw draft may not.
 *
 * Run: deno task cf test patterns/apps/redactor/redactor.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findNode,
  fireEvent,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import Redactor from "./redactor.tsx";
import { restore } from "./redaction.ts";

const DRAFT =
  "Write a polite note to my landlord Jordan Rivera (jordan.r@rivera-props.com, " +
  "415-867-5309) saying I'll pay on Friday. Rivera knows my SSN is 123-45-6789. " +
  "Cc Alice Anderson.";

// "Send to model" asks the model; CI blocks live calls.
export const llmMocks = [
  {
    when: { lastMessageContains: "polite note" },
    text: "Dear Bob Brown, see you Friday.",
  },
  {
    when: { lastMessageContains: "rent is late" },
    text: "Tell Alice the rent is fine.",
  },
];

// A draft with nothing to replace, sent, then edited to mention a vault name.
const PLAIN_DRAFT = "Explain politely that the rent is late.";
const LATER_DRAFT = "Jordan Rivera says the rent is late.";

export default pattern(() => {
  const pastedReply = new Writable("");
  const redactor = Redactor(
    { pastedReply } as Parameters<typeof Redactor>[0],
  );

  const action_type_draft = action(() =>
    redactor.typeDraft.send({ text: DRAFT })
  );

  // A second redactor: its reply must keep the key it was sent with, even
  // when that key is empty and the draft changes afterwards.
  const plain = Redactor(
    { pastedReply: new Writable("") } as Parameters<typeof Redactor>[0],
  );
  const action_type_plain = action(() =>
    plain.typeDraft.send({ text: PLAIN_DRAFT })
  );
  const action_edit_plain = action(() =>
    plain.typeDraft.send({ text: LATER_DRAFT })
  );
  const assert_plain_sent = assert(() =>
    plain.modelPrompt === PLAIN_DRAFT && plain.redacted === PLAIN_DRAFT
  );
  const assert_plain_edited = assert(() =>
    plain.redacted.startsWith("Alice Anderson says")
  );
  // "Alice" is now Jordan's stand-in, but the reply was written against the
  // empty key it was sent with, so nothing is swapped.
  const assert_plain_reply_kept = assert(() =>
    plain.restored === "Tell Alice the rent is fine."
  );
  // "Jordan Rivera" is the first name found. "Alice Anderson" and every
  // Anderson are in the draft already, so its stand-in is "Bob Brown".
  const action_paste_reply = action(() =>
    pastedReply.set("Dear Bob Brown, I'll pay on Friday. Thanks, Mr. Brown!")
  );

  const assert_empty_start = assert(() => redactor.modelPrompt === "");

  // Focusing the draft gives an unset draft a value, without which the
  // owner's display refuses it and the bound textarea drops what is typed.
  const action_focus_draft = action(() =>
    fireEvent(
      findNode(
        redactor[UI],
        (node) => propsOf(node)?.["oncf-focus"] !== undefined,
      ),
      "oncf-focus",
      {},
      "the draft textarea",
    )
  );
  const assert_draft_started = assert(() =>
    redactor.redacted === "" && redactor.found.length === 0
  );

  const assert_vault_name_replaced = assert(() =>
    !redactor.redacted.includes("Jordan") &&
    !redactor.redacted.includes("Rivera")
  );
  const assert_detected_values_replaced = assert(() =>
    !redactor.redacted.includes("123-45-6789") &&
    !redactor.redacted.includes("867-5309") &&
    !redactor.redacted.includes("rivera-props")
  );
  // A name already in the draft is not used as a stand-in, and is left alone.
  const assert_real_mention_kept = assert(() =>
    redactor.redacted.includes("Cc Alice Anderson.") &&
    !redactor.redacted.includes("Bob Anderson")
  );
  const assert_no_leaks = assert(() => redactor.leaks.length === 0);
  const assert_found_list = assert(() =>
    redactor.found.some((d) => d.source === "vault") &&
    redactor.found.some((d) => d.category === "ssn")
  );

  // The boundary: only the released computation reaches the public prompt.
  const assert_raw_refused = assert(() => redactor.modelPrompt === "");
  const assert_redacted_sent = assert(() =>
    redactor.modelPrompt !== "" &&
    redactor.modelPrompt === redactor.redacted
  );

  // A reply written in stand-ins comes back with the originals.
  const assert_reply_restored = assert(() =>
    redactor.restored ===
      "Dear Jordan Rivera, I'll pay on Friday. Thanks, Mr. Rivera!"
  );

  const assert_restore_whole_words = assert(() =>
    restore("Bobby met Bob.", [
      { category: "name", original: "Jordan", standIn: "Bob" },
    ]) === "Bobby met Jordan."
  );

  return {
    [TESTS]: [
      { assertion: assert_empty_start },
      { action: action_focus_draft },
      { assertion: assert_draft_started },
      {
        action: redactor.vault.addEntry,
        event: { category: "name", value: "Jordan Rivera" },
      },
      { action: action_type_draft },
      { assertion: assert_vault_name_replaced },
      { assertion: assert_detected_values_replaced },
      { assertion: assert_real_mention_kept },
      { assertion: assert_no_leaks },
      { assertion: assert_found_list },
      { assertion: assert_raw_refused },
      // The raw draft is refused at the public prompt.
      { action: redactor.sendRawDraft },
      { assertion: assert_raw_refused },
      { action: redactor.send },
      { assertion: assert_redacted_sent },
      // The raw draft cannot overwrite what was sent.
      { action: redactor.sendRawDraft },
      { assertion: assert_redacted_sent },
      { action: action_paste_reply },
      { assertion: assert_reply_restored },
      { assertion: assert_restore_whole_words },
      { action: action_type_plain },
      { action: plain.send },
      { assertion: assert_plain_sent },
      {
        action: plain.vault.addEntry,
        event: { category: "name", value: "Jordan Rivera" },
      },
      { action: action_edit_plain },
      { assertion: assert_plain_edited },
      { assertion: assert_plain_reply_kept },
    ],
    // The refused raw send logs the CFC refusal; the refusal is the point.
    allowConsoleWarnings: true,
    redactor,
  };
});
