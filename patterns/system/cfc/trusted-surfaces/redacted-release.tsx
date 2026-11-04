import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWriteWithIntegrity,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export const TRUSTED_REDACTED_RELEASE_SURFACE = "TrustedRedactedReleaseSurface";
export const TRUSTED_REDACTION_RENDERED_EVIDENCE =
  "TrustedRedactionRenderedEvidence";

const RELEASE_REDACTED_CONTENT_ACTION = "TrustedReleaseRedactedContent";

export const releaseTrustedRedactedContent = handler<
  void,
  {
    redactionLabel: Writable<string>;
    sourceText: Writable<string>;
    releasedRedactedContent: Writable<string>;
  }
>((_, { redactionLabel, sourceText, releasedRedactedContent }) => {
  const label = redactionLabel.get().trim() || "content";
  const redacted = sourceText.get().trim()
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-id]")
    .replace(/secret/gi, "[redacted-secret]");
  releasedRedactedContent.set(
    redacted ? `Released redacted ${label}: ${redacted}` : "",
  );
});

export interface TrustedRedactedReleaseSurfaceInput {
  redactionLabel: Writable<string>;
  sourceText: Writable<string>;
  releasedRedactedContent: Writable<string>;
}

export interface TrustedRedactedReleaseSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  releasedRedactedContent: TrustedActionWriteWithIntegrity<
    string,
    typeof releaseTrustedRedactedContent,
    typeof RELEASE_REDACTED_CONTENT_ACTION,
    typeof TRUSTED_REDACTED_RELEASE_SURFACE,
    [
      typeof TRUSTED_REDACTED_RELEASE_SURFACE,
      typeof TRUSTED_REDACTION_RENDERED_EVIDENCE,
    ]
  >;
  releaseRedactedContent: Stream<void>;
}

export const TrustedRedactedReleaseSurface = pattern<
  TrustedRedactedReleaseSurfaceInput,
  TrustedRedactedReleaseSurfaceOutput
>(({ redactionLabel, sourceText, releasedRedactedContent }) => {
  const releaseRedactedContent = releaseTrustedRedactedContent({
    redactionLabel,
    sourceText,
    releasedRedactedContent,
  });

  return {
    [NAME]: computed(() => "Trusted Redacted Release Surface"),
    [UI]: (
      <cf-card
        id="trusted-redacted-release-surface"
        data-ui-pattern={TRUSTED_REDACTED_RELEASE_SURFACE}
        data-ui-event-integrity={`${TRUSTED_REDACTED_RELEASE_SURFACE} ${TRUSTED_REDACTION_RENDERED_EVIDENCE}`}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted redacted release</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-redacted-release-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Render the source and release only a redacted derivative.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label id="trusted-redaction-rendered">
            {TRUSTED_REDACTION_RENDERED_EVIDENCE}
          </cf-label>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-redaction-label">Release label</cf-label>
            <cf-input
              id="trusted-redaction-label"
              $value={redactionLabel}
              placeholder="support case"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-redaction-source">Source text</cf-label>
            <cf-textarea
              id="trusted-redaction-source"
              $value={sourceText}
              rows={4}
            />
          </cf-vgroup>
          <cf-button
            data-ui-action={RELEASE_REDACTED_CONTENT_ACTION}
            onClick={releaseRedactedContent}
          >
            Release redacted content
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Released redacted content</cf-label>
              <div id="trusted-redacted-release-result">
                {releasedRedactedContent}
              </div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    releasedRedactedContent,
    releaseRedactedContent,
  };
});
