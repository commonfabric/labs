import { assert, equals, pattern, TESTS, UI } from "commonfabric";
import {
  findNode,
  findNodeByProp,
  isButton,
  propsOf,
} from "../test/vnode-helpers.ts";
import ProfileGroupChat from "./main.tsx";

const asObject = (value: unknown): object | undefined =>
  typeof value === "object" && value !== null ? value : undefined;

export default pattern(() => {
  const chat = ProfileGroupChat({});

  // Sending needs the viewer's `#profile`, which a pattern test cannot
  // resolve, so this pins the wiring rather than a sent message: Enter in the
  // message field fires the very stream the Send button does.
  const assert_enter_fires_send = assert(() => {
    const onSubmit = asObject(
      propsOf(findNodeByProp(chat[UI], "aria-label", "Message"))
        ?.["oncf-submit"],
    );
    const onClick = asObject(
      propsOf(findNode(chat[UI], isButton("Send")))?.onClick,
    );
    return onSubmit !== undefined && equals(onSubmit, onClick);
  });

  return {
    [TESTS]: [{ assertion: assert_enter_fires_send }],
    chat,
  };
});
