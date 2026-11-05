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

export const TRUSTED_CONVERSATION_SEND_SURFACE =
  "TrustedConversationSendSurface";

const CONVERSATION_SEND_ACTION = "TrustedConversationSend";

export const commitTrustedConversationSend = handler<
  void,
  {
    conversationTitle: Writable<string>;
    audienceInput: Writable<string>;
    messageDraft: Writable<string>;
    sentMessage: Writable<string>;
  }
>((_, { conversationTitle, audienceInput, messageDraft, sentMessage }) => {
  const title = conversationTitle.get().trim() || "conversation";
  const audience = audienceInput.get().trim() || "thread";
  const message = messageDraft.get().trim();
  sentMessage.set(
    message ? `Sent in ${title} to ${audience}: ${message}` : "",
  );
});

export interface TrustedConversationSendSurfaceInput {
  conversationTitle: Writable<string>;
  audienceInput: Writable<string>;
  messageDraft: Writable<string>;
  sentMessage: Writable<string>;
}

export interface TrustedConversationSendSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  sentMessage: TrustedActionWrite<
    string,
    typeof commitTrustedConversationSend,
    typeof CONVERSATION_SEND_ACTION,
    typeof TRUSTED_CONVERSATION_SEND_SURFACE
  >;
  sendMessage: Stream<void>;
}

export const TrustedConversationSendSurface = pattern<
  TrustedConversationSendSurfaceInput,
  TrustedConversationSendSurfaceOutput
>(({ conversationTitle, audienceInput, messageDraft, sentMessage }) => {
  const sendMessage = commitTrustedConversationSend({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Trusted Conversation Send Surface"),
    [UI]: (
      <cf-card
        id="trusted-conversation-send-surface"
        data-ui-pattern={TRUSTED_CONVERSATION_SEND_SURFACE}
        data-ui-event-integrity={TRUSTED_CONVERSATION_SEND_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted conversation send</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-conversation-send-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Send a message from within the current conversation context.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-conversation-title">
              Conversation title
            </cf-label>
            <cf-input
              id="trusted-conversation-title"
              $value={conversationTitle}
              placeholder="Project sync"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-conversation-audience">
              Audience within conversation
            </cf-label>
            <cf-input
              id="trusted-conversation-audience"
              $value={audienceInput}
              placeholder="team thread"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-conversation-message">Message</cf-label>
            <cf-textarea
              id="trusted-conversation-message"
              $value={messageDraft}
              rows={3}
            />
          </cf-vgroup>
          <cf-button
            data-ui-action={CONVERSATION_SEND_ACTION}
            onClick={sendMessage}
          >
            Send in conversation
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Sent message</cf-label>
              <div id="trusted-conversation-sent">{sentMessage}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    sentMessage,
    sendMessage,
  };
});
