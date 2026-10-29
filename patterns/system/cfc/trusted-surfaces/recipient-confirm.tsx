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

export const TRUSTED_RECIPIENT_CONFIRM_SURFACE =
  "TrustedRecipientConfirmSurface";

const CONFIRM_RECIPIENT_RELEASE_ACTION = "TrustedConfirmRecipientRelease";

export const confirmTrustedRecipientRelease = handler<
  void,
  {
    recipientLabel: Writable<string>;
    payloadPreview: Writable<string>;
    confirmedRecipientRelease: Writable<string>;
  }
>((_, { recipientLabel, payloadPreview, confirmedRecipientRelease }) => {
  const recipient = recipientLabel.get().trim() || "recipient";
  const preview = payloadPreview.get().trim() || "payload";
  confirmedRecipientRelease.set(
    `Confirmed release to ${recipient}: ${preview}`,
  );
});

export interface TrustedRecipientConfirmSurfaceInput {
  recipientLabel: Writable<string>;
  payloadPreview: Writable<string>;
  confirmedRecipientRelease: Writable<string>;
}

export interface TrustedRecipientConfirmSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  confirmedRecipientRelease: TrustedActionWrite<
    string,
    typeof confirmTrustedRecipientRelease,
    typeof CONFIRM_RECIPIENT_RELEASE_ACTION,
    typeof TRUSTED_RECIPIENT_CONFIRM_SURFACE
  >;
  confirmRecipientRelease: Stream<void>;
}

export const TrustedRecipientConfirmSurface = pattern<
  TrustedRecipientConfirmSurfaceInput,
  TrustedRecipientConfirmSurfaceOutput
>(({ recipientLabel, payloadPreview, confirmedRecipientRelease }) => {
  const confirmRecipientRelease = confirmTrustedRecipientRelease({
    recipientLabel,
    payloadPreview,
    confirmedRecipientRelease,
  });

  return {
    [NAME]: computed(() => "Trusted Recipient Confirm Surface"),
    [UI]: (
      <cf-card
        id="trusted-recipient-confirm-surface"
        data-ui-pattern={TRUSTED_RECIPIENT_CONFIRM_SURFACE}
        data-ui-event-integrity={TRUSTED_RECIPIENT_CONFIRM_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted recipient confirmation</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-recipient-confirm-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Confirm the concrete recipient and payload preview before
                releasing the protected action.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-recipient-label">Recipient</cf-label>
            <cf-input
              id="trusted-recipient-label"
              $value={recipientLabel}
              placeholder="finance@example.com"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-recipient-payload-preview">
              Payload preview
            </cf-label>
            <cf-textarea
              id="trusted-recipient-payload-preview"
              $value={payloadPreview}
              rows={3}
            />
          </cf-vgroup>
          <cf-button
            data-ui-action={CONFIRM_RECIPIENT_RELEASE_ACTION}
            onClick={confirmRecipientRelease}
          >
            Confirm recipient release
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Confirmed release</cf-label>
              <div id="trusted-recipient-confirm-result">
                {confirmedRecipientRelease}
              </div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    confirmedRecipientRelease,
    confirmRecipientRelease,
  };
});
