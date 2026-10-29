import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  TrustedRecipientConfirmSurface,
  TrustedRedactedReleaseSurface,
} from "../../system/cfc/trusted-surfaces/mod.ts";

export type ConfirmationReleaseExampleOutput = {
  [NAME]: string;
  [UI]: VNode;
  decoyStatus: string;
  recipientLabel?: string;
  payloadPreview?: string;
  confirmedRecipientRelease?: string;
  redactionLabel?: string;
  sourceText?: string;
  releasedRedactedContent?: string;
  confirmRecipientRelease?: Stream<void>;
  releaseRedactedContent?: Stream<void>;
  triggerDecoy: Stream<void>;
};

const setDecoyStatus = handler<
  void,
  { decoyStatus: Writable<string>; message: string }
>((_, { decoyStatus, message }) => {
  decoyStatus.set(message);
});

export const FinanceRecipientConfirmExample = pattern<
  Record<PropertyKey, never>,
  ConfirmationReleaseExampleOutput
>(() => {
  const recipientLabel = new Writable("finance@example.com");
  const payloadPreview = new Writable("Quarterly budget packet");
  const confirmedRecipientRelease = new Writable("");
  const decoyStatus = new Writable("Host finance shortcut is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message: "Host finance send shortcut is untrusted.",
  });
  const trusted = TrustedRecipientConfirmSurface({
    recipientLabel,
    payloadPreview,
    confirmedRecipientRelease,
  });

  return {
    [NAME]: computed(() => "Finance Recipient Confirmation"),
    [UI]: (
      <cf-screen title="Finance Recipient Confirmation">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted finance host</cf-heading>
              <cf-label>
                The host can suggest a send action, but the trusted recipient
                surface is the only authority to release it.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Send packet without confirmation
              </cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    recipientLabel,
    payloadPreview,
    confirmedRecipientRelease,
    decoyStatus,
    confirmRecipientRelease: trusted.confirmRecipientRelease,
    triggerDecoy,
  };
});

export const CustomerSupportRecipientConfirmExample = pattern<
  Record<PropertyKey, never>,
  ConfirmationReleaseExampleOutput
>(() => {
  const recipientLabel = new Writable("support lead");
  const payloadPreview = new Writable("case transcript excerpt");
  const confirmedRecipientRelease = new Writable("");
  const decoyStatus = new Writable("Host support shortcut is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message: "Host support reply shortcut is untrusted.",
  });
  const trusted = TrustedRecipientConfirmSurface({
    recipientLabel,
    payloadPreview,
    confirmedRecipientRelease,
  });

  return {
    [NAME]: computed(() => "Customer Support Recipient Confirmation"),
    [UI]: (
      <cf-screen title="Customer Support Recipient Confirmation">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted support host</cf-heading>
              <cf-label>
                The support console embeds a reviewed confirmation surface for
                the actual recipient and transcript excerpt.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Send reply without confirmation
              </cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    recipientLabel,
    payloadPreview,
    confirmedRecipientRelease,
    decoyStatus,
    confirmRecipientRelease: trusted.confirmRecipientRelease,
    triggerDecoy,
  };
});

export const PatientCaseRedactedReleaseExample = pattern<
  Record<PropertyKey, never>,
  ConfirmationReleaseExampleOutput
>(() => {
  const redactionLabel = new Writable("patient case");
  const sourceText = new Writable(
    "Patient secret code 123-45-6789 can be released only after redaction.",
  );
  const releasedRedactedContent = new Writable("");
  const decoyStatus = new Writable("Host patient export is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message: "Host patient export did not release content.",
  });
  const trusted = TrustedRedactedReleaseSurface({
    redactionLabel,
    sourceText,
    releasedRedactedContent,
  });

  return {
    [NAME]: computed(() => "Patient Case Redacted Release"),
    [UI]: (
      <cf-screen title="Patient Case Redacted Release">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted case host</cf-heading>
              <cf-label>
                The host offers a one-click export, while the trusted surface
                shows the source and commits only a redacted derivative.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Export original case text
              </cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    redactionLabel,
    sourceText,
    releasedRedactedContent,
    decoyStatus,
    releaseRedactedContent: trusted.releaseRedactedContent,
    triggerDecoy,
  };
});

export const SecurityIncidentRedactedReleaseExample = pattern<
  Record<PropertyKey, never>,
  ConfirmationReleaseExampleOutput
>(() => {
  const redactionLabel = new Writable("incident");
  const sourceText = new Writable(
    "Incident note contains secret escalation details for responders.",
  );
  const releasedRedactedContent = new Writable("");
  const decoyStatus = new Writable("Host incident export is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message: "Host incident export did not release content.",
  });
  const trusted = TrustedRedactedReleaseSurface({
    redactionLabel,
    sourceText,
    releasedRedactedContent,
  });

  return {
    [NAME]: computed(() => "Security Incident Redacted Release"),
    [UI]: (
      <cf-screen title="Security Incident Redacted Release">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted incident host</cf-heading>
              <cf-label>
                The incident console embeds the trusted redaction surface so the
                protected release is not an ambient host-side export.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Export incident note directly
              </cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    redactionLabel,
    sourceText,
    releasedRedactedContent,
    decoyStatus,
    releaseRedactedContent: trusted.releaseRedactedContent,
    triggerDecoy,
  };
});

const EXAMPLE_TITLES = [
  "Finance Recipient Confirmation",
  "Customer Support Recipient Confirmation",
  "Patient Case Redacted Release",
  "Security Incident Redacted Release",
] as const;

export default pattern<Record<PropertyKey, never>>(() => ({
  [NAME]: computed(() => "Confirmation and Redacted Release Examples"),
  [UI]: (
    <cf-screen title="Confirmation and Redacted Release Examples">
      <cf-vstack gap="3" style={{ padding: "1rem" }}>
        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-heading level={2}>
              Recipient confirmation and redacted release
            </cf-heading>
            <cf-label>
              These untrusted host wrappers embed trusted surfaces for recipient
              confirmation and source-visible redacted release.
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
        <div>{FinanceRecipientConfirmExample({})}</div>
        <div>{CustomerSupportRecipientConfirmExample({})}</div>
        <div>{PatientCaseRedactedReleaseExample({})}</div>
        <div>{SecurityIncidentRedactedReleaseExample({})}</div>
      </cf-vstack>
    </cf-screen>
  ),
  exampleCount: EXAMPLE_TITLES.length,
}));
