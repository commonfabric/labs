import {
  Cell,
  computed,
  type Confidential,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

const TRUSTED_HEALTH_DISCLOSURE_SURFACE = "TrustedHealthDisclosureSurface";
const TRUSTED_REVEAL_HEALTH_DATA_ACTION = "TrustedRevealHealthData";
const TRUSTED_CONCEAL_HEALTH_DATA_ACTION = "TrustedConcealHealthData";

const HEALTH_RECORD_CONFIDENTIALITY = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SensitiveHealthRecord",
  subject: "did:example:patient",
} as const;

type TrustedHealthDisclosureInput = {
  content: Writable<
    Confidential<string, readonly [typeof HEALTH_RECORD_CONFIDENTIALITY]>
  >;
  revealSensitive: Writable<boolean>;
};

type DirectHealthRenderInput = {
  content: Writable<
    Confidential<string, readonly [typeof HEALTH_RECORD_CONFIDENTIALITY]>
  >;
};

type LabelledContentArgument = {
  id: string;
  content: string;
};

export type TrustedHealthDisclosureOutput = {
  [NAME]: string;
  [UI]: VNode;
  revealSensitive: TrustedActionWrite<
    boolean,
    typeof setRevealSensitive,
    typeof TRUSTED_REVEAL_HEALTH_DATA_ACTION,
    typeof TRUSTED_HEALTH_DISCLOSURE_SURFACE
  >;
  reveal: Stream<unknown>;
  conceal: Stream<unknown>;
};

export type RenderPolicyDemoOutput = {
  [NAME]: string;
  [UI]: VNode;
  revealSensitive: TrustedActionWrite<
    boolean,
    typeof setRevealSensitive,
    typeof TRUSTED_REVEAL_HEALTH_DATA_ACTION,
    typeof TRUSTED_HEALTH_DISCLOSURE_SURFACE
  >;
  reveal: Stream<unknown>;
  conceal: Stream<unknown>;
};

export const setRevealSensitive = handler<
  unknown,
  { revealSensitive: Writable<boolean>; next: boolean }
>((_, { revealSensitive, next }) => {
  revealSensitive.set(next);
});

const makeConfidentialHealthText = lift<
  LabelledContentArgument,
  Writable<
    Confidential<string, readonly [typeof HEALTH_RECORD_CONFIDENTIALITY]>
  >
>((input) =>
  Cell.for<
    Confidential<string, readonly [typeof HEALTH_RECORD_CONFIDENTIALITY]>
  >(input.id).set(
    input.content as Confidential<
      string,
      readonly [typeof HEALTH_RECORD_CONFIDENTIALITY]
    >,
  )
);

export const UntrustedDirectHealthRender = pattern<
  DirectHealthRenderInput,
  { [NAME]: string; [UI]: VNode }
>(({ content }) => ({
  [NAME]: "Untrusted direct health render",
  [UI]: (
    <cf-card id="raw-health-attempt">
      <cf-vstack slot="content" gap="2">
        <cf-heading level={3}>Untrusted direct render attempt</cf-heading>
        <cf-label>
          This section intentionally has no trusted declassification surface, so
          the content below should stay hidden.
        </cf-label>
        <cf-cfc-render-boundary
          maxConfidentiality={[]}
          $value={content}
        >
          <div id="raw-health-direct">{content}</div>
        </cf-cfc-render-boundary>
      </cf-vstack>
    </cf-card>
  ),
}));

export const TrustedHealthDisclosureSurface = pattern<
  TrustedHealthDisclosureInput,
  TrustedHealthDisclosureOutput
>(({ content, revealSensitive }) => {
  const reveal = setRevealSensitive({ revealSensitive, next: true });
  const conceal = setRevealSensitive({ revealSensitive, next: false });
  const buttonLabel = computed(() =>
    revealSensitive.get()
      ? "Hide sensitive health data"
      : "Show sensitive health data"
  );
  const revealState = computed(() =>
    revealSensitive.get() ? "Reveal enabled" : "Reveal disabled"
  );
  const trustedContentStyle = computed(() => ({
    display: revealSensitive.get() ? "block" : "none",
  }));
  const trustedPlaceholderStyle = computed(() => ({
    display: revealSensitive.get() ? "none" : "block",
  }));

  return {
    [NAME]: "Trusted health disclosure surface",
    [UI]: (
      <cf-card
        id="trusted-health-surface"
        data-ui-surface={TRUSTED_HEALTH_DISCLOSURE_SURFACE}
        data-ui-pattern={TRUSTED_HEALTH_DISCLOSURE_SURFACE}
        data-ui-event-integrity={TRUSTED_HEALTH_DISCLOSURE_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted shoulder-surfing control</cf-heading>
          <cf-label>
            This trusted surface explains that confidential health data is about
            to be rendered. The render boundary only declassifies the matching
            label after this control is switched on.
          </cf-label>
          <cf-hstack gap="2">
            <cf-button
              data-ui-action={TRUSTED_REVEAL_HEALTH_DATA_ACTION}
              onClick={reveal}
            >
              {buttonLabel}
            </cf-button>
            <cf-button
              data-ui-action={TRUSTED_CONCEAL_HEALTH_DATA_ACTION}
              onClick={conceal}
            >
              Reset to private
            </cf-button>
          </cf-hstack>
          <cf-label id="reveal-state">
            {revealState}
          </cf-label>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Trusted render region</cf-label>
              <cf-cfc-render-boundary
                maxConfidentiality={[]}
                declassifyConfidentiality={[HEALTH_RECORD_CONFIDENTIALITY]}
                $value={content}
              >
                <div
                  id="trusted-health-blocked"
                  style={trustedPlaceholderStyle}
                >
                  Content hidden by policy
                </div>
                <div id="trusted-health-visible" style={trustedContentStyle}>
                  {content}
                </div>
              </cf-cfc-render-boundary>
            </cf-vstack>
          </cf-card>
          <cf-card>
            <cf-vstack slot="content" gap="1">
              <cf-label>Label attached to the protected value</cf-label>
              <cf-cfc-label
                data-cfc-label-surface="trusted-health-disclosure"
                $value={content}
              />
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    revealSensitive,
    reveal,
    conceal,
  };
});

export default pattern<unknown, RenderPolicyDemoOutput>(() => {
  const healthContent = makeConfidentialHealthText({
    id: "cfc-render-policy-demo-health-content",
    content:
      "Sensitive health data: migraine treatment plan includes medication review.",
  });
  const healthContentRender: Writable<
    Confidential<string, readonly [typeof HEALTH_RECORD_CONFIDENTIALITY]>
  > = healthContent as never;
  const revealSensitive = new Writable(false);
  const trustedDisclosure = TrustedHealthDisclosureSurface({
    content: healthContentRender,
    revealSensitive,
  });
  const rawAttempt = UntrustedDirectHealthRender({
    content: healthContentRender,
  });

  return {
    [NAME]: "CFC render policy demo",
    [UI]: (
      <cf-screen title="CFC render policy demo">
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="3">
              <cf-heading level={2}>Render-time confidentiality</cf-heading>
              <cf-label>
                The page below tries to render the same confidential health cell
                twice. The raw host attempt stays blocked by the default-low
                render boundary; the trusted surface can reveal it only inside
                its own disclosure region.
              </cf-label>
            </cf-vstack>
          </cf-card>

          {rawAttempt}
          {trustedDisclosure}
        </cf-vstack>
      </cf-screen>
    ),
    revealSensitive: trustedDisclosure.revealSensitive,
    reveal: trustedDisclosure.reveal,
    conceal: trustedDisclosure.conceal,
  };
});
