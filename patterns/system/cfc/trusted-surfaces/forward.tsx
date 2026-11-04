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

export const TRUSTED_FORWARD_SURFACE = "TrustedForwardSurface";

const PREPARE_FORWARD_ACTION = "TrustedPrepareForward";
const FORWARD_NOTE_ACTION = "TrustedForwardNote";

export const prepareTrustedForward = handler<
  void,
  {
    sourceNote: Writable<string>;
    recipientInput: Writable<string>;
    preparedPreview: Writable<string>;
  }
>((_, { sourceNote, recipientInput, preparedPreview }) => {
  const recipient = recipientInput.get().trim() || "ops@hotel.example";
  const excerpt = sourceNote.get().split(".")[0]?.trim() ?? sourceNote.get();
  preparedPreview.set(
    `Prepared for ${recipient}: ${excerpt}. Only the bounded itinerary excerpt will be forwarded.`,
  );
});

export const commitTrustedForward = handler<
  void,
  {
    preparedPreview: Writable<string>;
    forwardedNote: Writable<string>;
  }
>((_, { preparedPreview, forwardedNote }) => {
  forwardedNote.set(preparedPreview.get().trim());
});

export interface TrustedForwardSurfaceInput {
  sourceNote: Writable<string>;
  recipientInput: Writable<string>;
  preparedPreview: Writable<string>;
  forwardedNote: Writable<string>;
}

export interface TrustedForwardSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  recipientInput: string;
  preparedPreview: TrustedActionWrite<
    string,
    typeof prepareTrustedForward,
    typeof PREPARE_FORWARD_ACTION,
    typeof TRUSTED_FORWARD_SURFACE
  >;
  forwardedNote: TrustedActionWrite<
    string,
    typeof commitTrustedForward,
    typeof FORWARD_NOTE_ACTION,
    typeof TRUSTED_FORWARD_SURFACE
  >;
  prepareForward: Stream<void>;
  forwardNote: Stream<void>;
}

export const TrustedForwardSurface = pattern<
  TrustedForwardSurfaceInput,
  TrustedForwardSurfaceOutput
>(({ sourceNote, recipientInput, preparedPreview, forwardedNote }) => {
  const prepareForward = prepareTrustedForward({
    sourceNote,
    recipientInput,
    preparedPreview,
  });
  const forwardNote = commitTrustedForward({
    preparedPreview,
    forwardedNote,
  });

  return {
    [NAME]: computed(() => "Trusted Forward Surface"),
    [UI]: (
      <cf-card
        id="trusted-forward-surface"
        data-ui-pattern={TRUSTED_FORWARD_SURFACE}
        data-ui-event-integrity={TRUSTED_FORWARD_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-hstack justify="between" align="center" wrap>
            <cf-vstack gap="1">
              <cf-heading level={3}>Trusted forward</cf-heading>
              <cf-label>
                Prepare a bounded excerpt, then release it through the reviewed
                forward action.
              </cf-label>
            </cf-vstack>
          </cf-hstack>
          <cf-card data-ui-disclosure-kind="trusted-forward-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>Incoming note excerpt</cf-label>
              <div id="trusted-forward-source-note">{sourceNote}</div>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-forward-recipient">
              Forward recipient
            </cf-label>
            <cf-input
              id="trusted-forward-recipient"
              $value={recipientInput}
              placeholder="ops@hotel.example"
            />
          </cf-vgroup>
          <cf-hstack gap="2" wrap>
            <cf-button
              data-ui-action={PREPARE_FORWARD_ACTION}
              onClick={prepareForward}
            >
              Prepare forward
            </cf-button>
            <cf-button
              data-ui-action={FORWARD_NOTE_ACTION}
              onClick={forwardNote}
            >
              Forward trusted note
            </cf-button>
          </cf-hstack>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Prepared outbound request</cf-label>
              <div id="trusted-forward-prepared">{preparedPreview}</div>
              <cf-label>Committed release</cf-label>
              <div id="trusted-forward-result">{forwardedNote}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    recipientInput,
    preparedPreview,
    forwardedNote,
    prepareForward,
    forwardNote,
  };
});
