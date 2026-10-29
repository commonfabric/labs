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

export const TRUSTED_REVIEW_SURFACE = "TrustedReviewSurface";

export const REVIEW_SNAPSHOT_ACTION = "TrustedReviewSnapshot";

export type TrustedReviewedTitleUiContract = TrustedActionUiContract<
  string,
  typeof REVIEW_SNAPSHOT_ACTION,
  typeof TRUSTED_REVIEW_SURFACE
>;

export type TrustedReviewedBodyUiContract = TrustedActionUiContract<
  string,
  typeof REVIEW_SNAPSHOT_ACTION,
  typeof TRUSTED_REVIEW_SURFACE
>;

export const reviewTrustedSnapshot = handler<
  void,
  {
    savedTitle: Writable<string>;
    savedBody: Writable<string>;
    reviewedTitle: Writable<TrustedReviewedTitleUiContract>;
    reviewedBody: Writable<TrustedReviewedBodyUiContract>;
  }
>((_, { savedTitle, savedBody, reviewedTitle, reviewedBody }) => {
  reviewedTitle.set(savedTitle.get());
  reviewedBody.set(savedBody.get());
});

export type TrustedReviewedTitleWrite = TrustedActionWrite<
  string,
  typeof reviewTrustedSnapshot,
  typeof REVIEW_SNAPSHOT_ACTION,
  typeof TRUSTED_REVIEW_SURFACE
>;

export type TrustedReviewedBodyWrite = TrustedActionWrite<
  string,
  typeof reviewTrustedSnapshot,
  typeof REVIEW_SNAPSHOT_ACTION,
  typeof TRUSTED_REVIEW_SURFACE
>;

export interface TrustedReviewSurfaceInput {
  savedTitle: Writable<string>;
  savedBody: Writable<string>;
  reviewedTitle: Writable<TrustedReviewedTitleUiContract>;
  reviewedBody: Writable<TrustedReviewedBodyUiContract>;
}

export interface TrustedReviewSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  reviewedTitle: TrustedReviewedTitleUiContract;
  reviewedBody: TrustedReviewedBodyUiContract;
  reviewSaved: Stream<void>;
}

export const TrustedReviewSurface = pattern<
  TrustedReviewSurfaceInput,
  TrustedReviewSurfaceOutput
>(({ savedTitle, savedBody, reviewedTitle, reviewedBody }) => {
  const reviewSaved = reviewTrustedSnapshot({
    savedTitle,
    savedBody,
    reviewedTitle,
    reviewedBody,
  });

  return {
    [NAME]: computed(() => "Trusted Review Surface"),
    [UI]: (
      <cf-card
        id="trusted-review-surface"
        data-ui-pattern={TRUSTED_REVIEW_SURFACE}
        data-ui-event-integrity={TRUSTED_REVIEW_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted review</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-review-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed button means “promote the current saved snapshot
                into the protected reviewed copy.”
              </cf-label>
            </cf-vstack>
          </cf-card>
          <div id="trusted-review-source-title">{savedTitle}</div>
          <div id="trusted-review-source-body">{savedBody}</div>
          <cf-button
            data-ui-action={REVIEW_SNAPSHOT_ACTION}
            onClick={reviewSaved}
          >
            Mark reviewed
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    reviewedTitle,
    reviewedBody,
    reviewSaved,
  };
});
