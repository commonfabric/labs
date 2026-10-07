import {
  action,
  assert,
  pattern,
  resultOf,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { findNode, propsOf } from "../test/vnode-helpers.ts";
import ChatNote from "./chat-note.tsx";

type BacklinkStream = {
  send: (event: {
    detail: {
      text: string;
      pieceId: string;
      piece: unknown;
      navigate: boolean;
    };
  }) => void;
};

const backlinkStreamOf = (subject: { [UI]: unknown }): BacklinkStream => {
  const editor = findNode(
    subject[UI],
    (node) => propsOf(node)?.["onbacklink-create"] !== undefined,
  );
  return propsOf(editor)?.["onbacklink-create"] as BacklinkStream;
};

export default pattern(() => {
  const pieceRegistryWish = wish<Writable<Array<{ title?: string }>>>({
    query: "#pieceRegistry",
  });
  const pieceRegistry = resultOf(pieceRegistryWish.result);
  const subject = ChatNote({
    title: "Subject",
    content: "",
  });
  const linked = ChatNote({
    title: "Linked",
    content: "Linked content",
  });

  const action_create_backlink = action(() => {
    backlinkStreamOf(subject).send({
      detail: {
        text: "Linked",
        pieceId: "linked",
        piece: linked,
        navigate: false,
      },
    });
  });

  const assert_starts_unlinked = assert(() =>
    subject.mentioned.length === 0 && pieceRegistry.get().length === 0
  );
  const assert_backlink_registers_and_mentions_piece = assert(() =>
    pieceRegistry.get().length === 1 &&
    pieceRegistry.get()[0]?.title === "Linked"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_unlinked },
      { action: action_create_backlink },
      { assertion: assert_backlink_registers_and_mentions_piece },
    ],
    allowConsoleWarnings: true,
    subject,
  };
});
