import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionUiContract,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export const TRUSTED_SAVE_DRAFT_SURFACE = "TrustedSaveDraftSurface";

export const SAVE_DRAFT_ACTION = "TrustedSaveDraft";

export type TrustedSavedDraftTitleUiContract = TrustedActionUiContract<
  string,
  typeof SAVE_DRAFT_ACTION,
  typeof TRUSTED_SAVE_DRAFT_SURFACE
>;

export type TrustedSavedDraftBodyUiContract = TrustedActionUiContract<
  string,
  typeof SAVE_DRAFT_ACTION,
  typeof TRUSTED_SAVE_DRAFT_SURFACE
>;

export const saveTrustedDraftSnapshot = handler<
  void,
  {
    draftTitle: Writable<string>;
    draftBody: Writable<string>;
    savedTitle: Writable<TrustedSavedDraftTitleUiContract>;
    savedBody: Writable<TrustedSavedDraftBodyUiContract>;
  }
>((_, { draftTitle, draftBody, savedTitle, savedBody }) => {
  savedTitle.set(draftTitle.get().trim());
  savedBody.set(draftBody.get().trim());
});

export type TrustedSavedDraftTitleWrite = TrustedActionWrite<
  string,
  typeof saveTrustedDraftSnapshot,
  typeof SAVE_DRAFT_ACTION,
  typeof TRUSTED_SAVE_DRAFT_SURFACE
>;

export type TrustedSavedDraftBodyWrite = TrustedActionWrite<
  string,
  typeof saveTrustedDraftSnapshot,
  typeof SAVE_DRAFT_ACTION,
  typeof TRUSTED_SAVE_DRAFT_SURFACE
>;

export interface TrustedSaveDraftSurfaceInput {
  draftTitle: Writable<string>;
  draftBody: Writable<string>;
  savedTitle: Writable<TrustedSavedDraftTitleUiContract>;
  savedBody: Writable<TrustedSavedDraftBodyUiContract>;
}

export interface TrustedSaveDraftSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  savedTitle: TrustedSavedDraftTitleUiContract;
  savedBody: TrustedSavedDraftBodyUiContract;
  saveDraft: Stream<void>;
}

export const TrustedSaveDraftSurface = pattern<
  TrustedSaveDraftSurfaceInput,
  TrustedSaveDraftSurfaceOutput
>(({ draftTitle, draftBody, savedTitle, savedBody }) => {
  const saveDraft = saveTrustedDraftSnapshot({
    draftTitle,
    draftBody,
    savedTitle,
    savedBody,
  });

  return {
    [NAME]: computed(() => "Trusted Save Draft Surface"),
    [UI]: (
      <cf-card
        id="trusted-save-draft-surface"
        data-ui-pattern={TRUSTED_SAVE_DRAFT_SURFACE}
        data-ui-event-integrity={TRUSTED_SAVE_DRAFT_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted save draft</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-save-draft-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface snapshots the current draft title and body
                into the protected saved copy.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-save-draft-title-input">
              Draft title
            </cf-label>
            <cf-input
              id="trusted-save-draft-title-input"
              $value={draftTitle}
              placeholder="Draft title"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-save-draft-body-input">Draft body</cf-label>
            <cf-input
              id="trusted-save-draft-body-input"
              $value={draftBody}
              placeholder="Draft body"
            />
          </cf-vgroup>
          <cf-button data-ui-action={SAVE_DRAFT_ACTION} onClick={saveDraft}>
            Save draft
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    savedTitle,
    savedBody,
    saveDraft,
  };
});
