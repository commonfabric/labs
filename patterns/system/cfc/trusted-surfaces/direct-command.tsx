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

export const TRUSTED_DIRECT_COMMAND_SURFACE = "TrustedDirectCommandSurface";

const CAPTURE_COMMAND_ACTION = "TrustedCaptureDirectCommand";
const PREPARE_BRIEF_ACTION = "TrustedPrepareResearchBrief";
const AUTHORIZE_SEND_ACTION = "TrustedAuthorizeResearchSend";

export const captureTrustedDirectCommand = handler<
  void,
  {
    commandInput: Writable<string>;
    capturedCommand: Writable<string>;
    preparedBrief: Writable<string>;
  }
>((_, { commandInput, capturedCommand, preparedBrief }) => {
  capturedCommand.set(commandInput.get().trim());
  preparedBrief.set("");
});

export const prepareTrustedResearchBrief = handler<
  void,
  {
    capturedCommand: Writable<string>;
    preparedBrief: Writable<string>;
  }
>((_, { capturedCommand, preparedBrief }) => {
  const command = capturedCommand.get().trim();
  preparedBrief.set(
    command
      ? `Prepared outbound draft: concise summary for "${command}". The send action stays separately gated.`
      : "",
  );
});

export const commitTrustedResearchSend = handler<
  void,
  {
    capturedCommand: Writable<string>;
    preparedBrief: Writable<string>;
    authorizedSend: Writable<string>;
  }
>((_, { capturedCommand, preparedBrief, authorizedSend }) => {
  const command = capturedCommand.get().trim();
  const preview = preparedBrief.get().trim();
  authorizedSend.set(
    preview ? `Authorized outbound message for "${command}": ${preview}` : "",
  );
});

export interface TrustedDirectCommandSurfaceInput {
  commandInput: Writable<string>;
  capturedCommand: Writable<string>;
  preparedBrief: Writable<string>;
  authorizedSend: Writable<string>;
}

export interface TrustedDirectCommandSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  commandInput: string;
  capturedCommand: TrustedActionWrite<
    string,
    typeof captureTrustedDirectCommand,
    typeof CAPTURE_COMMAND_ACTION,
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  preparedBrief: TrustedActionWrite<
    string,
    typeof prepareTrustedResearchBrief,
    typeof PREPARE_BRIEF_ACTION,
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  authorizedSend: TrustedActionWrite<
    string,
    typeof commitTrustedResearchSend,
    typeof AUTHORIZE_SEND_ACTION,
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  captureCommand: Stream<void>;
  prepareBrief: Stream<void>;
  authorizeSend: Stream<void>;
}

export const TrustedDirectCommandSurface = pattern<
  TrustedDirectCommandSurfaceInput,
  TrustedDirectCommandSurfaceOutput
>(({ commandInput, capturedCommand, preparedBrief, authorizedSend }) => {
  const captureCommand = captureTrustedDirectCommand({
    commandInput,
    capturedCommand,
    preparedBrief,
  });
  const prepareBrief = prepareTrustedResearchBrief({
    capturedCommand,
    preparedBrief,
  });
  const authorizeSend = commitTrustedResearchSend({
    capturedCommand,
    preparedBrief,
    authorizedSend,
  });

  return {
    [NAME]: computed(() => "Trusted Direct Command Surface"),
    [UI]: (
      <cf-card
        id="trusted-direct-command-surface"
        data-ui-pattern={TRUSTED_DIRECT_COMMAND_SURFACE}
        data-ui-event-integrity={TRUSTED_DIRECT_COMMAND_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted direct command</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-direct-command-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface captures a bounded agent command, prepares
                a draft, and requires a separate release click to send it.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-command-input">Direct command</cf-label>
            <cf-textarea
              data-ui-surface="DirectAgentCommand"
              data-ui-role="assistant"
              $value={commandInput}
              rows={4}
            />
          </cf-vgroup>
          <cf-hstack gap="2" wrap>
            <cf-button
              data-ui-action={CAPTURE_COMMAND_ACTION}
              onClick={captureCommand}
            >
              Capture direct command
            </cf-button>
            <cf-button
              data-ui-action={PREPARE_BRIEF_ACTION}
              onClick={prepareBrief}
            >
              Prepare brief
            </cf-button>
            <cf-button
              data-ui-action={AUTHORIZE_SEND_ACTION}
              onClick={authorizeSend}
            >
              Authorize research send
            </cf-button>
          </cf-hstack>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Captured command</cf-label>
              <div id="trusted-command-captured">{capturedCommand}</div>
              <cf-label>Prepared brief</cf-label>
              <div id="trusted-command-prepared">{preparedBrief}</div>
              <cf-label>Committed outbound action</cf-label>
              <div id="trusted-command-result">{authorizedSend}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
    captureCommand,
    prepareBrief,
    authorizeSend,
  };
});
