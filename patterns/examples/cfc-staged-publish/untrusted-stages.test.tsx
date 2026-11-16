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
import {
  REVIEW_SNAPSHOT_ACTION,
  SAVE_DRAFT_ACTION,
  TRUSTED_REVIEW_SURFACE,
  TRUSTED_SAVE_DRAFT_SURFACE,
} from "../../system/cfc/trusted-surfaces/mod.ts";
import StagedPublish from "./main.tsx";

const setDraft = handler<
  void,
  { draftTitle: Writable<string>; draftBody: Writable<string> }
>((_, { draftTitle, draftBody }) => {
  draftTitle.set("Launch checklist");
  draftBody.set("Ship the staged publish demo with trusted UI gates.");
});

export default pattern(() => {
  const draftTitle = new Writable("");
  const draftBody = new Writable("");
  const savedTitle = new Writable("");
  const reviewedTitle = new Writable("");
  const publishedTitle = new Writable("");
  const publishedBody = new Writable("");

  const instance = StagedPublish({
    draftTitle,
    draftBody,
    savedTitle,
    savedBody: new Writable(""),
    reviewedTitle,
    reviewedBody: new Writable(""),
    publishedTitle,
    publishedBody,
  });

  const action_set_draft = setDraft({ draftTitle, draftBody });

  const assert_nothing_saved = assert(() =>
    draftTitle.get() === "Launch checklist" &&
    savedTitle.get() === "" &&
    instance.stage === "drafting"
  );
  const assert_reviewed = assert(() =>
    reviewedTitle.get() === "Launch checklist" &&
    instance.stage === "reviewed"
  );
  const assert_nothing_published = assert(() =>
    publishedTitle.get() === "" &&
    publishedBody.get() === "" &&
    instance.stage === "reviewed" &&
    instance[NAME] === "CFC Staged Publish (reviewed)" &&
    hasExactText(findNodeById(instance[UI], "published-title"), "")
  );

  return {
    // CFC refuses each stage write sent without its surface's trusted
    // gesture and logs the refusal as a warning; the assertions are what
    // show nothing was written.
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: action_set_draft },
      { action: instance.saveDraft },
      { assertion: assert_nothing_saved },
      {
        action: instance.saveDraft,
        trustedUi: {
          surface: TRUSTED_SAVE_DRAFT_SURFACE,
          action: SAVE_DRAFT_ACTION,
        },
      },
      {
        action: instance.reviewSaved,
        trustedUi: {
          surface: TRUSTED_REVIEW_SURFACE,
          action: REVIEW_SNAPSHOT_ACTION,
        },
      },
      { assertion: assert_reviewed },
      { action: instance.publishReviewed },
      { assertion: assert_nothing_published },
    ],
    instance,
  };
});
