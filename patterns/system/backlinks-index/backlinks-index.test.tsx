import {
  action,
  assert,
  handler,
  NAME,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import BacklinksIndex, {
  type MentionableCell,
  type MentionablePiece,
} from "./backlinks-index.tsx";

const addMention = handler<
  void,
  { source: MentionableCell; target: MentionableCell }
>((_, { source, target }) => {
  source.key("mentioned").push(target as any);
});

export default pattern(() => {
  const target = new Writable<MentionablePiece>({
    [NAME]: "Target",
    mentioned: [],
    backlinks: [],
  });
  const source = new Writable<MentionablePiece>({
    [NAME]: "Source",
    mentioned: [],
    backlinks: [],
  });
  const subject = BacklinksIndex({
    pieceRegistry: [target, source] as MentionableCell[],
  });
  const mention = addMention({ source, target });
  const action_add_mention = action(() => {
    mention.send();
  });

  const assert_registry_is_mentionable = assert(() =>
    subject.mentionable.length === 2
  );
  const assert_mention_populates_backlink = assert(() =>
    target.key("backlinks").get()?.length === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_registry_is_mentionable },
      { action: action_add_mention },
      { assertion: assert_mention_populates_backlink },
    ],
    subject,
  };
});
