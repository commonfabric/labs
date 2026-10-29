import { assert, handler, pattern, TESTS, Writable } from "commonfabric";
import {
  SAVE_TITLE_ACTION,
  TRUSTED_SAVE_SURFACE,
} from "../../system/cfc/trusted-surfaces/mod.ts";
import AuthorizedSave from "./main.tsx";

const setDraftTitle = handler<
  void,
  { draftTitle: Writable<string>; title: string }
>((_, { draftTitle, title }) => {
  draftTitle.set(title);
});

// The protected `savedTitle` write requires the trusted save gesture: send
// the renderer-trusted event directly to the surface's stream (see the
// `trustedUi` steps below), like a user clicking the reviewed button.
const trustedSaveGesture = {
  surface: TRUSTED_SAVE_SURFACE,
  action: SAVE_TITLE_ACTION,
};

export default pattern(() => {
  const draftTitle = new Writable("");
  const savedTitle = new Writable("");
  const instance = AuthorizedSave({
    draftTitle,
    savedTitle,
  });

  const action_set_first_draft = setDraftTitle({
    draftTitle,
    title: "First title",
  });

  const action_set_second_draft = setDraftTitle({
    draftTitle,
    title: "Second title",
  });

  const assert_initial_saved_empty = assert(() => savedTitle.get() === "");
  const assert_first_draft_visible = assert(() =>
    draftTitle.get() === "First title"
  );
  const assert_first_save_committed = assert(() =>
    savedTitle.get() === "First title"
  );
  const assert_second_draft_does_not_autosave = assert(() =>
    savedTitle.get() === "First title"
  );
  const assert_second_save_committed = assert(() =>
    savedTitle.get() === "Second title"
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_saved_empty },
      { action: action_set_first_draft },
      { assertion: assert_first_draft_visible },
      { action: instance.save, trustedUi: trustedSaveGesture },
      { assertion: assert_first_save_committed },
      { action: action_set_second_draft },
      { assertion: assert_second_draft_does_not_autosave },
      { action: instance.save, trustedUi: trustedSaveGesture },
      { assertion: assert_second_save_committed },
    ],
    instance,
  };
});
