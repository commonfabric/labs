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

export const TRUSTED_PROVENANCE_REVIEW_SURFACE =
  "TrustedProvenanceReviewSurface";
export const TRUSTED_PROVENANCE_RENDERED_EVIDENCE =
  "TrustedProvenanceRenderedEvidence";

const REVIEW_PROVENANCE_ACTION = "TrustedReviewProvenance";

export const reviewTrustedProvenance = handler<
  void,
  {
    provenanceText: Writable<string>;
    reviewedProvenance: Writable<string>;
  }
>((_, { provenanceText, reviewedProvenance }) => {
  const provenance = provenanceText.get().trim();
  reviewedProvenance.set(
    provenance ? `Reviewed provenance: ${provenance}` : "",
  );
});

export interface TrustedProvenanceReviewSurfaceInput {
  provenanceText: Writable<string>;
  reviewedProvenance: Writable<string>;
}

export interface TrustedProvenanceReviewSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  reviewedProvenance: TrustedActionWriteWithIntegrity<
    string,
    typeof reviewTrustedProvenance,
    typeof REVIEW_PROVENANCE_ACTION,
    typeof TRUSTED_PROVENANCE_REVIEW_SURFACE,
    [
      typeof TRUSTED_PROVENANCE_REVIEW_SURFACE,
      typeof TRUSTED_PROVENANCE_RENDERED_EVIDENCE,
    ]
  >;
  reviewProvenance: Stream<void>;
}

export const TrustedProvenanceReviewSurface = pattern<
  TrustedProvenanceReviewSurfaceInput,
  TrustedProvenanceReviewSurfaceOutput
>(({ provenanceText, reviewedProvenance }) => {
  const reviewProvenance = reviewTrustedProvenance({
    provenanceText,
    reviewedProvenance,
  });

  return {
    [NAME]: computed(() => "Trusted Provenance Review Surface"),
    [UI]: (
      <cf-card
        id="trusted-provenance-review-surface"
        data-ui-pattern={TRUSTED_PROVENANCE_REVIEW_SURFACE}
        data-ui-event-integrity={`${TRUSTED_PROVENANCE_REVIEW_SURFACE} ${TRUSTED_PROVENANCE_RENDERED_EVIDENCE}`}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted provenance review</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-provenance-review-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Review the provenance disclosure before reusing the content.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label id="trusted-provenance-rendered">
            {TRUSTED_PROVENANCE_RENDERED_EVIDENCE}
          </cf-label>
          <cf-label>{provenanceText}</cf-label>
          <cf-button
            data-ui-action={REVIEW_PROVENANCE_ACTION}
            onClick={reviewProvenance}
          >
            Accept provenance
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Reviewed provenance result</cf-label>
              <div id="trusted-provenance-reviewed">
                {reviewedProvenance}
              </div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    reviewedProvenance,
    reviewProvenance,
  };
});
