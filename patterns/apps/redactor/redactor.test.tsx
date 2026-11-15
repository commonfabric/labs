/**
 * Redactor pattern tests: what gets replaced, how a reply is restored, and the
 * CFC boundary — the redacted draft may be written to the model's public
 * prompt, the raw draft may not.
 *
 * Run: deno task cf test patterns/apps/redactor/redactor.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Redactor from "./redactor.tsx";
import { restore } from "./redaction.ts";

const DRAFT =
  "Write a polite note to my landlord Jordan Rivera (jordan.r@rivera-props.com, " +
  "415-867-5309) saying I'll pay on Friday. Rivera knows my SSN is 123-45-6789. " +
  "Cc Alice Anderson.";

export default pattern(() => {
  const pastedReply = new Writable("");
  const redactor = Redactor(
    { pastedReply } as Parameters<typeof Redactor>[0],
  );

  const action_type_draft = action(() =>
    redactor.typeDraft.send({ text: DRAFT })
  );
  // "Jordan Rivera" is the first name found. "Alice Anderson" and every
  // Anderson are in the draft already, so its stand-in is "Bob Brown".
  const action_paste_reply = action(() =>
    pastedReply.set("Dear Bob Brown, I'll pay on Friday. Thanks, Mr. Brown!")
  );

  const assert_empty_start = assert(() => redactor.modelPrompt === "");

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
      { action: redactor.sendRawDraft },
      { assertion: assert_raw_refused },
      { action: redactor.send },
      { assertion: assert_redacted_sent },
      { action: action_paste_reply },
      { assertion: assert_reply_restored },
      { assertion: assert_restore_whole_words },
    ],
    // The refused raw send logs the CFC refusal; the refusal is the point.
    allowConsoleWarnings: true,
    redactor,
  };
});
