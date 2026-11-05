import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export const TRUSTED_AUDIENCE_PUBLISH_SURFACE = "TrustedAudiencePublishSurface";

const PREPARE_AUDIENCE_PUBLISH_ACTION = "TrustedPrepareAudiencePublish";
const PUBLISH_AUDIENCE_POST_ACTION = "TrustedPublishAudiencePost";

export const prepareTrustedAudiencePublish = handler<
  void,
  {
    targetAudience: Writable<string>;
    publishSubject: Writable<string>;
    publishBody: Writable<string>;
    preparedAudiencePublish: Writable<string>;
  }
>((_, {
  targetAudience,
  publishSubject,
  publishBody,
  preparedAudiencePublish,
}) => {
  const audience = targetAudience.get().trim() || "public";
  const subject = publishSubject.get().trim() || "Untitled";
  const body = publishBody.get().trim();
  preparedAudiencePublish.set(
    body
      ? `Prepared publish for ${audience}: ${subject} — ${body}`
      : `Prepared publish for ${audience}: ${subject}`,
  );
});

export const commitTrustedAudiencePublish = handler<
  void,
  {
    preparedAudiencePublish: Writable<string>;
    publishedAudiencePost: Writable<string>;
  }
>((_, { preparedAudiencePublish, publishedAudiencePost }) => {
  publishedAudiencePost.set(preparedAudiencePublish.get().trim());
});

export interface TrustedAudiencePublishSurfaceInput {
  targetAudience: Writable<string>;
  publishSubject: Writable<string>;
  publishBody: Writable<string>;
  preparedAudiencePublish: Writable<string>;
  publishedAudiencePost: Writable<string>;
}

export interface TrustedAudiencePublishSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  preparedAudiencePublish: TrustedActionWrite<
    string,
    typeof prepareTrustedAudiencePublish,
    typeof PREPARE_AUDIENCE_PUBLISH_ACTION,
    typeof TRUSTED_AUDIENCE_PUBLISH_SURFACE
  >;
  publishedAudiencePost: TrustedActionWrite<
    string,
    typeof commitTrustedAudiencePublish,
    typeof PUBLISH_AUDIENCE_POST_ACTION,
    typeof TRUSTED_AUDIENCE_PUBLISH_SURFACE
  >;
  prepareAudiencePublish: Stream<void>;
  publishAudiencePost: Stream<void>;
}

export const TrustedAudiencePublishSurface = pattern<
  TrustedAudiencePublishSurfaceInput,
  TrustedAudiencePublishSurfaceOutput
>(
  ({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  }) => {
    const prepareAudiencePublish = prepareTrustedAudiencePublish({
      targetAudience,
      publishSubject,
      publishBody,
      preparedAudiencePublish,
    });
    const publishAudiencePost = commitTrustedAudiencePublish({
      preparedAudiencePublish,
      publishedAudiencePost,
    });

    return {
      [NAME]: computed(() => "Trusted Audience Publish Surface"),
      [UI]: (
        <cf-card
          id="trusted-audience-publish-surface"
          data-ui-pattern={TRUSTED_AUDIENCE_PUBLISH_SURFACE}
          data-ui-event-integrity={TRUSTED_AUDIENCE_PUBLISH_SURFACE}
        >
          <cf-vstack slot="content" gap="3">
            <cf-heading level={3}>Trusted audience publish</cf-heading>
            <cf-card data-ui-disclosure-kind="trusted-audience-publish-disclosure">
              <cf-vstack slot="content" gap="1">
                <cf-label>
                  Stage a publish and then commit it to a named audience.
                </cf-label>
              </cf-vstack>
            </cf-card>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-audience-target">Audience</cf-label>
              <cf-input
                id="trusted-audience-target"
                $value={targetAudience}
                placeholder="public"
              />
            </cf-vgroup>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-audience-subject">Subject</cf-label>
              <cf-input
                id="trusted-audience-subject"
                $value={publishSubject}
                placeholder="Status update"
              />
            </cf-vgroup>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-audience-body">Body</cf-label>
              <cf-textarea
                id="trusted-audience-body"
                $value={publishBody}
                rows={3}
              />
            </cf-vgroup>
            <cf-hstack gap="2" wrap>
              <cf-button
                data-ui-action={PREPARE_AUDIENCE_PUBLISH_ACTION}
                onClick={prepareAudiencePublish}
              >
                Prepare publish
              </cf-button>
              <cf-button
                data-ui-action={PUBLISH_AUDIENCE_POST_ACTION}
                onClick={publishAudiencePost}
              >
                Publish to audience
              </cf-button>
            </cf-hstack>
            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-label>Prepared audience release</cf-label>
                <div id="trusted-audience-prepared">
                  {preparedAudiencePublish}
                </div>
                <cf-label>Committed audience release</cf-label>
                <div id="trusted-audience-published">
                  {publishedAudiencePost}
                </div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-card>
      ),
      preparedAudiencePublish,
      publishedAudiencePost,
      prepareAudiencePublish,
      publishAudiencePost,
    };
  },
);
