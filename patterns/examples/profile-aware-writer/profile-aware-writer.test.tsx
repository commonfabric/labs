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
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import ProfileAwareWriter, { handleSend } from "./profile-aware-writer.tsx";

export default pattern(() => {
  const writer = ProfileAwareWriter({});

  const assert_names_itself = assert(() =>
    writer[NAME] === "Profile-Aware Writer" &&
    hasText(writer[UI], "Profile-Aware Writer") &&
    hasText(writer[UI], "Profile Context:")
  );
  const assert_no_topic_yet = assert(() =>
    writer.topic === "" && !hasText(writer[UI], "Topic:")
  );

  // A blank message names no topic, so the writer asks for nothing.
  const action_send_blank = action(() => sendMessage(writer[UI], "   "));

  // A topic in the writer itself would start a language-model request, which
  // a pattern test cannot answer, so the handler is also bound to a topic of
  // the test's own to see what it keeps.
  const topic = Writable.of("");
  const send = handleSend({ topic });
  const assert_topic_trimmed = assert(() =>
    topic.get() === "Dragons in winter"
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_no_topic_yet },
      { action: action_send_blank },
      { assertion: assert_no_topic_yet },
      { action: send, event: { detail: { message: "  Dragons in winter  " } } },
      { assertion: assert_topic_trimmed },
    ],
    writer,
  };
});
