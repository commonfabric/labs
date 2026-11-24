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

export const TRUSTED_FACT_CHECK_GATE_SURFACE = "TrustedFactCheckGateSurface";
export const TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE =
  "TrustedFactCheckDisclaimerEvidence";

const FACT_CHECK_GATE_ACTION = "TrustedApproveFactCheckGate";

export const commitTrustedFactCheckGate = handler<
  void,
  {
    factCheckClaim: Writable<string>;
    factCheckResult: Writable<string>;
  }
>((_, { factCheckClaim, factCheckResult }) => {
  const claim = factCheckClaim.get().trim();
  factCheckResult.set(
    claim ? `Fact-check gate opened for: ${claim}` : "",
  );
});

export interface TrustedFactCheckGateSurfaceInput {
  factCheckClaim: Writable<string>;
  factCheckResult: Writable<string>;
}

export interface TrustedFactCheckGateSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  factCheckResult: TrustedActionWriteWithIntegrity<
    string,
    typeof commitTrustedFactCheckGate,
    typeof FACT_CHECK_GATE_ACTION,
    typeof TRUSTED_FACT_CHECK_GATE_SURFACE,
    [
      typeof TRUSTED_FACT_CHECK_GATE_SURFACE,
      typeof TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE,
    ]
  >;
  releaseFactCheckGate: Stream<void>;
}

export const TrustedFactCheckGateSurface = pattern<
  TrustedFactCheckGateSurfaceInput,
  TrustedFactCheckGateSurfaceOutput
>(({ factCheckClaim, factCheckResult }) => {
  const releaseFactCheckGate = commitTrustedFactCheckGate({
    factCheckClaim,
    factCheckResult,
  });

  return {
    [NAME]: computed(() => "Trusted Fact Check Gate Surface"),
    [UI]: (
      <cf-card
        id="trusted-fact-check-gate-surface"
        data-ui-pattern={TRUSTED_FACT_CHECK_GATE_SURFACE}
        data-ui-event-integrity={`${TRUSTED_FACT_CHECK_GATE_SURFACE} ${TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE}`}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted fact-check gate</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-fact-check-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Fact-check the claim before allowing it to leave the trusted
                boundary.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label id="trusted-fact-check-rendered">
            {TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE}
          </cf-label>
          <cf-label>{factCheckClaim}</cf-label>
          <cf-button
            data-ui-action={FACT_CHECK_GATE_ACTION}
            onClick={releaseFactCheckGate}
          >
            Release after fact-check
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Fact-check result</cf-label>
              <div id="trusted-fact-check-result">{factCheckResult}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    factCheckResult,
    releaseFactCheckGate,
  };
});
