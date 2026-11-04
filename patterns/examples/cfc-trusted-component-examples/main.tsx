import { computed, NAME, pattern, UI, type VNode } from "commonfabric";
import ConfirmationReleaseExamples from "./confirmation-release-examples.tsx";
import DisclaimerExamples from "./disclaimer-examples.tsx";
import ProcessExamples from "./process-examples.tsx";
import SendPublishExamples from "./send-publish-examples.tsx";

const TOTAL_EXAMPLES = 52;

export interface TrustedComponentExamplesOutput {
  [NAME]: string;
  [UI]: VNode;
  totalExamples: number;
}

export default pattern<
  Record<PropertyKey, never>,
  TrustedComponentExamplesOutput
>(() => ({
  [NAME]: computed(() => "CFC Trusted Component Example Gallery"),
  [UI]: (
    <cf-screen title="CFC Trusted Component Example Gallery">
      <cf-vscroll style="flex: 1;">
        <cf-vstack gap="4" style={{ padding: "1rem 1.25rem 2rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>Trusted UI components in hosts</cf-heading>
              <cf-label>
                This gallery collects untrusted host examples that embed
                reusable trusted surfaces for send/publish flows, disclaimer
                gates, provenance review, fact-check release, scoped policies,
                visible long-running jobs, recipient confirmation, and redacted
                release.
              </cf-label>
              <cf-label>
                Total untrusted example patterns: {TOTAL_EXAMPLES}.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <div>{SendPublishExamples({})}</div>
          <div>{DisclaimerExamples({})}</div>
          <div>{ProcessExamples({})}</div>
          <div>{ConfirmationReleaseExamples({})}</div>
        </cf-vstack>
      </cf-vscroll>
    </cf-screen>
  ),
  totalExamples: TOTAL_EXAMPLES,
}));
