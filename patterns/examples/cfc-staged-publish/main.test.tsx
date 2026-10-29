import { assert, handler, pattern, TESTS, Writable } from "commonfabric";
import {
  PUBLISH_SNAPSHOT_ACTION,
  REVIEW_SNAPSHOT_ACTION,
  SAVE_DRAFT_ACTION,
  TRUSTED_PUBLISH_SURFACE,
  TRUSTED_REVIEW_SURFACE,
  TRUSTED_SAVE_DRAFT_SURFACE,
} from "../../system/cfc/trusted-surfaces/mod.ts";
import StagedPublish from "./main.tsx";

const setDraft = handler<
  void,
  {
    draftTitle: Writable<string>;
    draftBody: Writable<string>;
    title: string;
    body: string;
  }
>((_, { draftTitle, draftBody, title, body }) => {
  draftTitle.set(title);
  draftBody.set(body);
});

export default pattern(() => {
  const draftTitle = new Writable("");
  const draftBody = new Writable("");
  const savedTitle = new Writable("");
  const savedBody = new Writable("");
  const reviewedTitle = new Writable("");
  const reviewedBody = new Writable("");
  const publishedTitle = new Writable("");
  const publishedBody = new Writable("");

  const instance = StagedPublish({
    draftTitle,
    draftBody,
    savedTitle,
    savedBody,
    reviewedTitle,
    reviewedBody,
    publishedTitle,
    publishedBody,
  });

  const action_set_draft = setDraft({
    draftTitle,
    draftBody,
    title: "Launch checklist",
    body: "Ship the staged publish demo with trusted UI gates.",
  });
  const action_edit_draft = setDraft({
    draftTitle,
    draftBody,
    title: "Launch checklist v2",
    body: "Edited after save but before review.",
  });

  const assert_initial_stage = assert(() => instance.stage === "drafting");
  const assert_saved_snapshot = assert(() =>
    savedTitle.get() === "Launch checklist" &&
    savedBody.get() === "Ship the staged publish demo with trusted UI gates." &&
    instance.stage === "saved"
  );
  const assert_saved_stays_stable_after_edit = assert(() =>
    savedTitle.get() === "Launch checklist" &&
    savedBody.get() === "Ship the staged publish demo with trusted UI gates."
  );
  const assert_reviewed_snapshot = assert(() =>
    reviewedTitle.get() === "Launch checklist" &&
    reviewedBody.get() ===
      "Ship the staged publish demo with trusted UI gates." &&
    instance.stage === "reviewed"
  );
  const assert_published_snapshot = assert(() =>
    publishedTitle.get() === "Launch checklist" &&
    publishedBody.get() ===
      "Ship the staged publish demo with trusted UI gates." &&
    instance.stage === "published"
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_stage },
      { action: action_set_draft },
      // Each stage's write is gated on its reviewed surface's trusted
      // gesture (TrustedAction UI contracts on saved/reviewed/published).
      {
        action: instance.saveDraft,
        trustedUi: {
          surface: TRUSTED_SAVE_DRAFT_SURFACE,
          action: SAVE_DRAFT_ACTION,
        },
      },
      { assertion: assert_saved_snapshot },
      { action: action_edit_draft },
      { assertion: assert_saved_stays_stable_after_edit },
      {
        action: instance.reviewSaved,
        trustedUi: {
          surface: TRUSTED_REVIEW_SURFACE,
          action: REVIEW_SNAPSHOT_ACTION,
        },
      },
      { assertion: assert_reviewed_snapshot },
      {
        action: instance.publishReviewed,
        trustedUi: {
          surface: TRUSTED_PUBLISH_SURFACE,
          action: PUBLISH_SNAPSHOT_ACTION,
        },
      },
      { assertion: assert_published_snapshot },
    ],
    instance,
  };
});
