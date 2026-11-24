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

export const TRUSTED_PUBLISH_SURFACE = "TrustedPublishSurface";

export const PUBLISH_SNAPSHOT_ACTION = "TrustedPublishSnapshot";

export type TrustedPublishedTitleUiContract = TrustedActionUiContract<
  string,
  typeof PUBLISH_SNAPSHOT_ACTION,
  typeof TRUSTED_PUBLISH_SURFACE
>;

export type TrustedPublishedBodyUiContract = TrustedActionUiContract<
  string,
  typeof PUBLISH_SNAPSHOT_ACTION,
  typeof TRUSTED_PUBLISH_SURFACE
>;

export const publishTrustedSnapshot = handler<
  void,
  {
    reviewedTitle: Writable<string>;
    reviewedBody: Writable<string>;
    publishedTitle: Writable<TrustedPublishedTitleUiContract>;
    publishedBody: Writable<TrustedPublishedBodyUiContract>;
  }
>((_, { reviewedTitle, reviewedBody, publishedTitle, publishedBody }) => {
  publishedTitle.set(reviewedTitle.get());
  publishedBody.set(reviewedBody.get());
});

export type TrustedPublishedTitleWrite = TrustedActionWrite<
  string,
  typeof publishTrustedSnapshot,
  typeof PUBLISH_SNAPSHOT_ACTION,
  typeof TRUSTED_PUBLISH_SURFACE
>;

export type TrustedPublishedBodyWrite = TrustedActionWrite<
  string,
  typeof publishTrustedSnapshot,
  typeof PUBLISH_SNAPSHOT_ACTION,
  typeof TRUSTED_PUBLISH_SURFACE
>;

export interface TrustedPublishSurfaceInput {
  reviewedTitle: Writable<string>;
  reviewedBody: Writable<string>;
  publishedTitle: Writable<TrustedPublishedTitleUiContract>;
  publishedBody: Writable<TrustedPublishedBodyUiContract>;
}

export interface TrustedPublishSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  publishedTitle: TrustedPublishedTitleUiContract;
  publishedBody: TrustedPublishedBodyUiContract;
  publishReviewed: Stream<void>;
}

export const TrustedPublishSurface = pattern<
  TrustedPublishSurfaceInput,
  TrustedPublishSurfaceOutput
>(({ reviewedTitle, reviewedBody, publishedTitle, publishedBody }) => {
  const publishReviewed = publishTrustedSnapshot({
    reviewedTitle,
    reviewedBody,
    publishedTitle,
    publishedBody,
  });

  return {
    [NAME]: computed(() => "Trusted Publish Surface"),
    [UI]: (
      <cf-card
        id="trusted-publish-surface"
        data-ui-pattern={TRUSTED_PUBLISH_SURFACE}
        data-ui-event-integrity={TRUSTED_PUBLISH_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted publish</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-publish-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed button means “copy the reviewed snapshot into the
                protected published output.”
              </cf-label>
            </cf-vstack>
          </cf-card>
          <div id="trusted-publish-source-title">{reviewedTitle}</div>
          <div id="trusted-publish-source-body">{reviewedBody}</div>
          <cf-button
            data-ui-action={PUBLISH_SNAPSHOT_ACTION}
            onClick={publishReviewed}
          >
            Publish
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    publishedTitle,
    publishedBody,
    publishReviewed,
  };
});
