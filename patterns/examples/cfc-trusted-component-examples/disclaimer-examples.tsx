import {
  Cell,
  computed,
  type Confidential,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

type PromptInfluenceContent = Confidential<
  string,
  readonly [typeof PROMPT_INFLUENCE_ATOM]
>;
type SourceProvenanceContent = Confidential<
  string,
  readonly [typeof SOURCE_PROVENANCE_ATOM]
>;
type FactCheckRequiredContent = Confidential<
  string,
  readonly [typeof FACT_CHECK_REQUIRED_ATOM]
>;

const PROMPT_INFLUENCE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "prompt-influence",
  source: {
    type: "https://commonfabric.org/cfc/atom/Resource",
    class: "PromptInfluenceSource",
    subject: "did:example:cfc-disclaimer-gallery",
  },
} as const;
const SOURCE_PROVENANCE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SourceProvenance",
  subject: "did:example:cfc-disclaimer-gallery",
} as const;
const FACT_CHECK_REQUIRED_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "fact-check-required",
  source: {
    type: "https://commonfabric.org/cfc/atom/Resource",
    class: "ExternalClaim",
    subject: "did:example:cfc-disclaimer-gallery",
  },
} as const;
type LabelledContentArgument = {
  id: string;
  content: string;
};

type DisclaimerHostInput = {
  title: Writable<string>;
  summary: Writable<string>;
  content: Writable<PromptInfluenceContent>;
  disclaimerText: Writable<string>;
  acknowledgedDisclaimer: Writable<string>;
  fakeButton: Writable<string>;
  fakeMessage: Writable<string>;
  fakeStatus: Writable<string>;
};

type ProvenanceHostInput = {
  title: Writable<string>;
  summary: Writable<string>;
  content: Writable<SourceProvenanceContent>;
  provenanceText: Writable<string>;
  reviewedProvenance: Writable<string>;
  fakeButton: Writable<string>;
  fakeMessage: Writable<string>;
  fakeStatus: Writable<string>;
};

type FactCheckHostInput = {
  title: Writable<string>;
  summary: Writable<string>;
  content: Writable<FactCheckRequiredContent>;
  factCheckClaim: Writable<string>;
  factCheckResult: Writable<string>;
  fakeButton: Writable<string>;
  fakeMessage: Writable<string>;
  fakeStatus: Writable<string>;
};

export type DisclosureExampleOutput = {
  [NAME]: string;
  [UI]: VNode;
  content: string;
  disclaimerText?: string;
  acknowledgedDisclaimer?: string;
  provenanceText?: string;
  reviewedProvenance?: string;
  factCheckClaim?: string;
  factCheckResult?: string;
  fakeStatus: string;
  triggerLookalike: Stream<void>;
};

const makePromptInfluenceContent = lift<
  LabelledContentArgument,
  Writable<PromptInfluenceContent>
>((input) =>
  Cell.for<PromptInfluenceContent>(input.id).set(
    input.content as PromptInfluenceContent,
  )
);

const makeSourceProvenanceContent = lift<
  LabelledContentArgument,
  Writable<SourceProvenanceContent>
>((input) =>
  Cell.for<SourceProvenanceContent>(input.id).set(
    input.content as SourceProvenanceContent,
  )
);

const makeFactCheckContent = lift<
  LabelledContentArgument,
  Writable<FactCheckRequiredContent>
>((input) =>
  Cell.for<FactCheckRequiredContent>(input.id).set(
    input.content as FactCheckRequiredContent,
  )
);

const setLookalikeStatus = handler<
  void,
  { fakeStatus: Writable<string>; fakeMessage: Writable<string> }
>((_, { fakeStatus, fakeMessage }) => {
  fakeStatus.set(fakeMessage.get());
});

export const TrustedDisclaimerAckHost = pattern<
  DisclaimerHostInput,
  DisclosureExampleOutput
>(
  ({
    title,
    summary,
    content,
    disclaimerText,
    acknowledgedDisclaimer,
    fakeButton,
    fakeMessage,
    fakeStatus,
  }) => {
    const triggerLookalike = setLookalikeStatus({
      fakeStatus,
      fakeMessage,
    });

    return {
      [NAME]: computed(() => title.get()),
      [UI]: (
        <cf-screen title={title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{title}</cf-heading>
                <cf-label>{summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{content}</div>
                  </cf-vstack>
                </cf-card>
                <cf-card data-ui-disclosure-kind="trusted-label-disclosure">
                  <cf-vstack slot="content" gap="2">
                    <cf-heading level={3}>
                      Trusted label disclosure
                    </cf-heading>
                    <cf-label>
                      The trusted disclosure is rendered with the content label;
                      no acknowledgement click is required.
                    </cf-label>
                    <cf-label>{disclaimerText}</cf-label>
                    <cf-cfc-label
                      className="trusted-disclaimer-label"
                      data-cfc-label-surface="prompt-influence"
                      $value={content}
                    />
                  </cf-vstack>
                </cf-card>
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host control</cf-label>
                    <cf-button onClick={triggerLookalike}>
                      {fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      content,
      disclaimerText,
      acknowledgedDisclaimer,
      fakeStatus,
      triggerLookalike,
    };
  },
);

export const TrustedProvenanceReviewHost = pattern<
  ProvenanceHostInput,
  DisclosureExampleOutput
>(
  ({
    title,
    summary,
    content,
    provenanceText,
    reviewedProvenance,
    fakeButton,
    fakeMessage,
    fakeStatus,
  }) => {
    const triggerLookalike = setLookalikeStatus({
      fakeStatus,
      fakeMessage,
    });

    return {
      [NAME]: computed(() => title.get()),
      [UI]: (
        <cf-screen title={title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{title}</cf-heading>
                <cf-label>{summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{content}</div>
                  </cf-vstack>
                </cf-card>
                <cf-card data-ui-disclosure-kind="trusted-label-disclosure">
                  <cf-vstack slot="content" gap="2">
                    <cf-heading level={3}>
                      Trusted provenance disclosure
                    </cf-heading>
                    <cf-label>
                      Provenance is rendered as label context next to the
                      content; no provenance review click is required.
                    </cf-label>
                    <cf-label>{provenanceText}</cf-label>
                    <cf-cfc-label
                      className="trusted-disclaimer-label"
                      data-cfc-label-surface="source-provenance"
                      $value={content}
                    />
                  </cf-vstack>
                </cf-card>
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host provenance card</cf-label>
                    <cf-button onClick={triggerLookalike}>
                      {fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      content,
      provenanceText,
      reviewedProvenance,
      fakeStatus,
      triggerLookalike,
    };
  },
);

export const TrustedFactCheckGateHost = pattern<
  FactCheckHostInput,
  DisclosureExampleOutput
>(
  ({
    title,
    summary,
    content,
    factCheckClaim,
    factCheckResult,
    fakeButton,
    fakeMessage,
    fakeStatus,
  }) => {
    const triggerLookalike = setLookalikeStatus({
      fakeStatus,
      fakeMessage,
    });

    return {
      [NAME]: computed(() => title.get()),
      [UI]: (
        <cf-screen title={title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{title}</cf-heading>
                <cf-label>{summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{content}</div>
                  </cf-vstack>
                </cf-card>
                <cf-card data-ui-disclosure-kind="trusted-label-disclosure">
                  <cf-vstack slot="content" gap="2">
                    <cf-heading level={3}>
                      Trusted fact-check disclosure
                    </cf-heading>
                    <cf-label>
                      The fact-check label is shown with the claim; no approval
                      click is required for this disclosure demo.
                    </cf-label>
                    <cf-label>{factCheckClaim}</cf-label>
                    <cf-cfc-label
                      className="trusted-disclaimer-label"
                      data-cfc-label-surface="fact-check-required"
                      $value={content}
                    />
                  </cf-vstack>
                </cf-card>
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host fact-check card</cf-label>
                    <cf-button onClick={triggerLookalike}>
                      {fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      content,
      factCheckClaim,
      factCheckResult,
      fakeStatus,
      triggerLookalike,
    };
  },
);

export const DisclaimerPromptRoutingAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("Prompt routing ack"),
    summary: new Writable(
      "A routing-sensitive disclaimer must be rendered before the recipient can be acknowledged.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-prompt-routing",
      content: "Route this note to the verified recipient only.",
    }),
    disclaimerText: new Writable(
      "Routing can be influenced by prompt-derived text.",
    ),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake route ack"),
    fakeMessage: new Writable(
      "Lookalike routing ack did not update the trusted output.",
    ),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Prompt routing ack"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerAIGeneratedContentAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("AI-generated content disclaimer"),
    summary: new Writable(
      "An AI-generated disclosure is rendered alongside the content before the user can acknowledge it.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-ai-generated-content",
      content: "Draft social copy for the launch announcement.",
    }),
    disclaimerText: new Writable(
      "This content was generated by AI and may need review.",
    ),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake AI ack"),
    fakeMessage: new Writable(
      "The host lookalike did not acknowledge the trusted disclaimer.",
    ),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "AI-generated content disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerMedicalInfoAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("Medical-style information disclaimer"),
    summary: new Writable(
      "An informational disclaimer is bound to the content before the acknowledgment can produce the trusted output.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-medical-info",
      content: "Medication summary and dosage reminder.",
    }),
    disclaimerText: new Writable("Informational only. Not medical advice."),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake medical ack"),
    fakeMessage: new Writable("Lookalike health disclaimer was not accepted."),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Medical-style information disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerInfluenceDisclosureAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("Influence disclosure ack"),
    summary: new Writable(
      "A persuasion/influence disclosure is rendered before the associated recommendation can be acknowledged.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-influence-disclosure",
      content: "Recommendation copy generated by a campaign-tuned assistant.",
    }),
    disclaimerText: new Writable(
      "This recommendation may be influenced by campaign goals.",
    ),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake influence ack"),
    fakeMessage: new Writable(
      "The lookalike influence notice did not update trusted state.",
    ),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Influence disclosure ack"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerRedactedSummaryAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("Redacted summary disclaimer"),
    summary: new Writable(
      "The host shows a redacted derivative only after the trusted disclaimer is rendered with it.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-redacted-summary",
      content: "Redacted incident summary for the internal audience.",
    }),
    disclaimerText: new Writable("Redacted from a more detailed report."),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake redaction ack"),
    fakeMessage: new Writable(
      "Lookalike redaction note did not update the protected summary.",
    ),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Redacted summary disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerConfidentialSourceAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("Confidential source disclaimer"),
    summary: new Writable(
      "A confidentiality disclaimer is required before the host can acknowledge the source-restricted content.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-confidential-source",
      content: "Sensitive source excerpt for internal circulation only.",
    }),
    disclaimerText: new Writable(
      "Do not redistribute outside the approved group.",
    ),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake confidential ack"),
    fakeMessage: new Writable(
      "Lookalike confidential note left the trusted output unchanged.",
    ),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Confidential source disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerPublicPostAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("Public-post disclaimer"),
    summary: new Writable(
      "A publication disclaimer is rendered with the post before acknowledgment is possible.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-public-post",
      content: "Draft public post for the product launch.",
    }),
    disclaimerText: new Writable(
      "Public-facing content. Review for accuracy before publish.",
    ),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake public-post ack"),
    fakeMessage: new Writable(
      "Lookalike publish note did not acknowledge the trusted post.",
    ),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Public-post disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerSourceProvenanceReviewExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedProvenanceReviewHost({
    title: new Writable("Source provenance review"),
    summary: new Writable(
      "A provenance review surface binds the source and the review note together before releasing the reviewed text.",
    ),
    content: makeSourceProvenanceContent({
      id: "disclaimer-source-provenance",
      content: "Shared source excerpt for the design review.",
    }),
    provenanceText: new Writable(
      "Source provenance: shared by the project owner.",
    ),
    reviewedProvenance: new Writable(""),
    fakeButton: new Writable("Fake provenance review"),
    fakeMessage: new Writable(
      "The lookalike provenance card did not update the reviewed text.",
    ),
    fakeStatus: new Writable("Lookalike provenance control is idle."),
  });

  return {
    [NAME]: computed(() => "Source provenance review"),
    [UI]: host[UI],
    content: host.content,
    provenanceText: host.provenanceText,
    reviewedProvenance: host.reviewedProvenance,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerCitationProvenanceReviewExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedProvenanceReviewHost({
    title: new Writable("Citation provenance review"),
    summary: new Writable(
      "The trusted provenance review is paired with citations before the host can claim the content is review-backed.",
    ),
    content: makeSourceProvenanceContent({
      id: "disclaimer-citation-provenance",
      content: "Claim that requires citation provenance.",
    }),
    provenanceText: new Writable("Citations verified against the source list."),
    reviewedProvenance: new Writable(""),
    fakeButton: new Writable("Fake citation review"),
    fakeMessage: new Writable(
      "The lookalike citation provenance card did not change output.",
    ),
    fakeStatus: new Writable("Lookalike provenance control is idle."),
  });

  return {
    [NAME]: computed(() => "Citation provenance review"),
    [UI]: host[UI],
    content: host.content,
    provenanceText: host.provenanceText,
    reviewedProvenance: host.reviewedProvenance,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerPublicPostProvenanceReviewExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedProvenanceReviewHost({
    title: new Writable("Public-post provenance review"),
    summary: new Writable(
      "The public-post example exposes provenance review before release to the wider audience.",
    ),
    content: makeSourceProvenanceContent({
      id: "disclaimer-public-post-provenance",
      content: "Public status update draft.",
    }),
    provenanceText: new Writable(
      "Provenance review required before public release.",
    ),
    reviewedProvenance: new Writable(""),
    fakeButton: new Writable("Fake public review"),
    fakeMessage: new Writable(
      "The lookalike public-post card left the trusted output alone.",
    ),
    fakeStatus: new Writable("Lookalike provenance control is idle."),
  });

  return {
    [NAME]: computed(() => "Public-post provenance review"),
    [UI]: host[UI],
    content: host.content,
    provenanceText: host.provenanceText,
    reviewedProvenance: host.reviewedProvenance,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerFactCheckBriefExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedFactCheckGateHost({
    title: new Writable("Fact-check brief gate"),
    summary: new Writable(
      "A fact-check gate is rendered with the brief before the trusted approved output is produced.",
    ),
    content: makeFactCheckContent({
      id: "disclaimer-fact-check-brief",
      content: "External brief about launch performance.",
    }),
    factCheckClaim: new Writable("External brief about launch performance."),
    factCheckResult: new Writable(""),
    fakeButton: new Writable("Fake fact-check"),
    fakeMessage: new Writable(
      "The lookalike fact-check gate did not approve the brief.",
    ),
    fakeStatus: new Writable("Lookalike fact-check gate is idle."),
  });

  return {
    [NAME]: computed(() => "Fact-check brief gate"),
    [UI]: host[UI],
    content: host.content,
    factCheckClaim: host.factCheckClaim,
    factCheckResult: host.factCheckResult,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerFactCheckReleaseExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedFactCheckGateHost({
    title: new Writable("Fact-check release gate"),
    summary: new Writable(
      "The release gate ensures the verified brief is shown with its disclaimer before approval.",
    ),
    content: makeFactCheckContent({
      id: "disclaimer-fact-check-release",
      content: "Release note for the launch checklist.",
    }),
    factCheckClaim: new Writable("Release note for the launch checklist."),
    factCheckResult: new Writable(""),
    fakeButton: new Writable("Fake release gate"),
    fakeMessage: new Writable(
      "The lookalike release gate never updated the approved text.",
    ),
    fakeStatus: new Writable("Lookalike fact-check gate is idle."),
  });

  return {
    [NAME]: computed(() => "Fact-check release gate"),
    [UI]: host[UI],
    content: host.content,
    factCheckClaim: host.factCheckClaim,
    factCheckResult: host.factCheckResult,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerFactCheckClaimsExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedFactCheckGateHost({
    title: new Writable("Fact-check claims gate"),
    summary: new Writable(
      "A claims gate sits next to the drafted claim before the trusted approval output can change.",
    ),
    content: makeFactCheckContent({
      id: "disclaimer-fact-check-claims",
      content: "Claim about the incident response timeline.",
    }),
    factCheckClaim: new Writable("Claim about the incident response timeline."),
    factCheckResult: new Writable(""),
    fakeButton: new Writable("Fake claims gate"),
    fakeMessage: new Writable(
      "The lookalike claims gate left the approved text unchanged.",
    ),
    fakeStatus: new Writable("Lookalike fact-check gate is idle."),
  });

  return {
    [NAME]: computed(() => "Fact-check claims gate"),
    [UI]: host[UI],
    content: host.content,
    factCheckClaim: host.factCheckClaim,
    factCheckResult: host.factCheckResult,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerLookalikeHostExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: new Writable("Lookalike disclaimer host"),
    summary: new Writable(
      "This example renders a visible host control that looks similar but does not call the trusted acknowledgement stream.",
    ),
    content: makePromptInfluenceContent({
      id: "disclaimer-lookalike-host",
      content: "Host-controlled disclaimer demo.",
    }),
    disclaimerText: new Writable(
      "Trusted output only changes when the reviewed button is used.",
    ),
    acknowledgedDisclaimer: new Writable(""),
    fakeButton: new Writable("Fake trusted button"),
    fakeMessage: new Writable(
      "The host lookalike never changed the trusted output.",
    ),
    fakeStatus: new Writable("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Lookalike disclaimer host"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    triggerLookalike: host.triggerLookalike,
  };
});

const EXAMPLE_TITLES = [
  "Prompt routing ack",
  "AI-generated content disclaimer",
  "Medical-style information disclaimer",
  "Influence disclosure ack",
  "Redacted summary disclaimer",
  "Confidential source disclaimer",
  "Public-post disclaimer",
  "Source provenance review",
  "Citation provenance review",
  "Public-post provenance review",
  "Fact-check brief gate",
  "Fact-check release gate",
  "Fact-check claims gate",
  "Lookalike disclaimer host",
] as const;

export const DISCLAIMER_EXAMPLE_COUNT = 14;
export const DISCLAIMER_RENDERED_EXAMPLE_COUNT = 14;

export default pattern<Record<PropertyKey, never>>(() => {
  const renderedExamples = [
    DisclaimerPromptRoutingAckExample({}),
    DisclaimerAIGeneratedContentAckExample({}),
    DisclaimerMedicalInfoAckExample({}),
    DisclaimerInfluenceDisclosureAckExample({}),
    DisclaimerRedactedSummaryAckExample({}),
    DisclaimerConfidentialSourceAckExample({}),
    DisclaimerPublicPostAckExample({}),
    DisclaimerSourceProvenanceReviewExample({}),
    DisclaimerCitationProvenanceReviewExample({}),
    DisclaimerPublicPostProvenanceReviewExample({}),
    DisclaimerFactCheckBriefExample({}),
    DisclaimerFactCheckReleaseExample({}),
    DisclaimerFactCheckClaimsExample({}),
    DisclaimerLookalikeHostExample({}),
  ];

  return {
    [NAME]: computed(() => "Disclaimer Example Gallery"),
    [UI]: (
      <cf-screen title="Disclaimer Example Gallery">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>
                Disclaimer and provenance examples
              </cf-heading>
              <cf-label>
                These examples are untrusted host wrappers embedding trusted
                disclaimer, provenance, influence-disclosure, and fact-check
                surfaces. Lookalike host controls remain visible but cannot
                update the protected outputs.
              </cf-label>
              <cf-label>
                The gallery currently exposes {EXAMPLE_TITLES.length}{" "}
                example patterns.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Catalog</cf-heading>
              {EXAMPLE_TITLES.map((title, index) => (
                <div>
                  {index + 1}. {title}
                </div>
              ))}
            </cf-vstack>
          </cf-card>
          {renderedExamples.map((example) => <div>{example[UI] as never}</div>)}
        </cf-vstack>
      </cf-screen>
    ),
    exampleCount: DISCLAIMER_EXAMPLE_COUNT,
    renderedExampleCount: renderedExamples.length,
  };
});
