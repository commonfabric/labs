import {
  action,
  assert,
  handler,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  countElements,
  findElement,
  hasText,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
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
  // A piece that exports a mentionable of its own, and one that opts out.
  const nested = new Writable<MentionablePiece>({ [NAME]: "Nested" });
  const container = new Writable<{
    [NAME]: string;
    mentionable: MentionableCell[];
  }>({ [NAME]: "Container", mentionable: [] });
  const hidden = new Writable<MentionablePiece>({
    [NAME]: "Hidden",
    isMentionable: false,
  });
  const subject = BacklinksIndex({
    pieceRegistry: [target, source, container, hidden] as MentionableCell[],
  });
  const mention = addMention({ source, target });
  const action_add_mention = action(() => {
    mention.send();
  });
  const action_export_nested = action(() => {
    container.key("mentionable").push(nested);
  });

  const assert_registry_is_mentionable = assert(() =>
    subject.mentionable.length === 3
  );
  const assert_mention_populates_backlink = assert(() =>
    target.key("backlinks").get()?.length === 1
  );
  const assert_exported_mentionable_is_listed = assert(() =>
    subject.mentionable.map((piece) => piece.get()[NAME]).join() ===
      "Target,Source,Container,Nested"
  );
  // The view lists each mentionable piece with a link per backlink: Target's
  // one, from Source.
  const assert_view_lists_pieces_and_backlinks = assert(() =>
    hasText(subject[UI], "4 of 4 pieces") &&
    countElements(subject[UI], "cf-render") === 4 &&
    countElements(subject[UI], "cf-cell-link") === 1
  );
  const action_filter = action(() =>
    setBound(findElement(subject[UI], "cf-input"), "$value", " TARG ")
  );
  const assert_filter_narrows_by_name = assert(() =>
    hasText(subject[UI], "1 of 4 pieces") &&
    countElements(subject[UI], "cf-render") === 1 &&
    countElements(subject[UI], "cf-cell-link") === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_registry_is_mentionable },
      { action: action_add_mention },
      { assertion: assert_mention_populates_backlink },
      { action: action_export_nested },
      { assertion: assert_exported_mentionable_is_listed },
      { assertion: assert_view_lists_pieces_and_backlinks },
      { action: action_filter },
      { assertion: assert_filter_narrows_by_name },
    ],
    subject,
  };
});
