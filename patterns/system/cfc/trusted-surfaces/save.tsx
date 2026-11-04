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

export const TRUSTED_SAVE_SURFACE = "TrustedSaveSurface";

export const SAVE_TITLE_ACTION = "TrustedSaveTitle";

export type TrustedSaveTitleUiContract = TrustedActionUiContract<
  string,
  typeof SAVE_TITLE_ACTION,
  typeof TRUSTED_SAVE_SURFACE
>;

export const commitTrustedSaveTitle = handler<
  void,
  {
    draftTitle: Writable<string>;
    savedTitle: Writable<TrustedSaveTitleUiContract>;
  }
>((_, { draftTitle, savedTitle }) => {
  savedTitle.set(draftTitle.get().trim());
});

export type TrustedSaveTitleWrite = TrustedActionWrite<
  string,
  typeof commitTrustedSaveTitle,
  typeof SAVE_TITLE_ACTION,
  typeof TRUSTED_SAVE_SURFACE
>;

export interface TrustedSaveSurfaceInput {
  draftTitle: Writable<string>;
  savedTitle: Writable<TrustedSaveTitleUiContract>;
}

export interface TrustedSaveSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  savedTitle: TrustedSaveTitleUiContract;
  save: Stream<void>;
}

export const TrustedSaveSurface = pattern<
  TrustedSaveSurfaceInput,
  TrustedSaveSurfaceOutput
>(({ draftTitle, savedTitle }) => {
  const save = commitTrustedSaveTitle({ draftTitle, savedTitle });

  return {
    [NAME]: computed(() => "Trusted Save Surface"),
    [UI]: (
      <cf-card
        id="trusted-save-surface"
        data-ui-pattern={TRUSTED_SAVE_SURFACE}
        data-ui-event-integrity={TRUSTED_SAVE_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted save</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-save-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface means “copy the current draft title into
                the protected saved field.”
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-save-draft-input">Draft title</cf-label>
            <cf-input
              id="trusted-save-draft-input"
              $value={draftTitle}
              placeholder="Draft title"
            />
          </cf-vgroup>
          <cf-button data-ui-action={SAVE_TITLE_ACTION} onClick={save}>
            Save title
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    savedTitle,
    save,
  };
});
