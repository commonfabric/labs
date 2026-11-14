import {
  assert,
  handler,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  hasExactText,
} from "../../tools/test-support/vnode-helpers.ts";
import AuthorizedSave from "./main.tsx";

const setDraftTitle = handler<
  void,
  { draftTitle: Writable<string>; title: string }
>((_, { draftTitle, title }) => {
  draftTitle.set(title);
});

export default pattern(() => {
  const draftTitle = new Writable("");
  const savedTitle = new Writable("");
  const instance = AuthorizedSave({ draftTitle, savedTitle });

  const action_set_draft = setDraftTitle({
    draftTitle,
    title: "Typed draft",
  });

  const assert_nothing_saved = assert(() =>
    draftTitle.get() === "Typed draft" &&
    savedTitle.get() === "" &&
    instance[NAME] === "Authorized Save (empty)" &&
    hasExactText(findNodeById(instance[UI], "saved-title"), "")
  );

  // The reviewed surface's own button carries the trusted gesture, so the
  // same draft does save from there.
  const assert_saved_from_trusted_surface = assert(() =>
    savedTitle.get() === "Typed draft" &&
    instance[NAME] === "Authorized Save (Typed draft)" &&
    hasExactText(findNodeById(instance[UI], "saved-title"), "Typed draft")
  );

  return {
    // CFC refuses each untrusted write below and logs the refusal as a
    // warning; the assertions are what show nothing was written.
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: action_set_draft },
      // The save stream sent with no trusted gesture at all.
      { action: instance.save },
      { assertion: assert_nothing_saved },
      // The host shortcut button binds the same stream, but it is not the
      // reviewed surface, so its click carries no trusted gesture either.
      { press: instance[UI], control: "Save title", within: "Host shortcut" },
      { assertion: assert_nothing_saved },
      { press: instance[UI], control: "Save title", within: "Trusted save" },
      { assertion: assert_saved_from_trusted_surface },
    ],
    instance,
  };
});
