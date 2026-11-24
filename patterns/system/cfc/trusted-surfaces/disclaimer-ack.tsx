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

export const TRUSTED_DISCLAIMER_ACK_SURFACE = "TrustedDisclaimerAckSurface";
export const TRUSTED_DISCLAIMER_RENDERED_EVIDENCE =
  "TrustedDisclaimerRenderedEvidence";

const ACKNOWLEDGE_DISCLAIMER_ACTION = "TrustedAcknowledgeDisclaimer";

export const acknowledgeTrustedDisclaimer = handler<
  void,
  {
    disclaimerText: Writable<string>;
    acknowledgedDisclaimer: Writable<string>;
  }
>((_, { disclaimerText, acknowledgedDisclaimer }) => {
  const disclaimer = disclaimerText.get().trim();
  acknowledgedDisclaimer.set(
    disclaimer ? `Acknowledged trusted disclaimer: ${disclaimer}` : "",
  );
});

export interface TrustedDisclaimerAckSurfaceInput {
  disclaimerText: Writable<string>;
  acknowledgedDisclaimer: Writable<string>;
}

export interface TrustedDisclaimerAckSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  acknowledgedDisclaimer: TrustedActionWriteWithIntegrity<
    string,
    typeof acknowledgeTrustedDisclaimer,
    typeof ACKNOWLEDGE_DISCLAIMER_ACTION,
    typeof TRUSTED_DISCLAIMER_ACK_SURFACE,
    [
      typeof TRUSTED_DISCLAIMER_ACK_SURFACE,
      typeof TRUSTED_DISCLAIMER_RENDERED_EVIDENCE,
    ]
  >;
  acknowledgeDisclaimer: Stream<void>;
}

export const TrustedDisclaimerAckSurface = pattern<
  TrustedDisclaimerAckSurfaceInput,
  TrustedDisclaimerAckSurfaceOutput
>(({ disclaimerText, acknowledgedDisclaimer }) => {
  const acknowledgeDisclaimer = acknowledgeTrustedDisclaimer({
    disclaimerText,
    acknowledgedDisclaimer,
  });

  return {
    [NAME]: computed(() => "Trusted Disclaimer Ack Surface"),
    [UI]: (
      <cf-card
        id="trusted-disclaimer-ack-surface"
        data-ui-pattern={TRUSTED_DISCLAIMER_ACK_SURFACE}
        data-ui-event-integrity={`${TRUSTED_DISCLAIMER_ACK_SURFACE} ${TRUSTED_DISCLAIMER_RENDERED_EVIDENCE}`}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted disclaimer acknowledgment</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-disclaimer-ack-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                The trusted disclaimer must be rendered before acknowledgement.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label id="trusted-disclaimer-rendered">
            {TRUSTED_DISCLAIMER_RENDERED_EVIDENCE}
          </cf-label>
          <cf-label>{disclaimerText}</cf-label>
          <cf-button
            data-ui-action={ACKNOWLEDGE_DISCLAIMER_ACTION}
            onClick={acknowledgeDisclaimer}
          >
            Acknowledge disclaimer
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Acknowledgement result</cf-label>
              <div id="trusted-disclaimer-acknowledged">
                {acknowledgedDisclaimer}
              </div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    acknowledgedDisclaimer,
    acknowledgeDisclaimer,
  };
});
