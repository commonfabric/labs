import { BuiltInLLMMessagesArraySchema } from "@commonfabric/runner/component-read-contract";
import { type CellHandle } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";

import "../cf-chat-message/index.ts";

import "../cf-tool-call/index.ts";

import type {
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commonfabric/api";

import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  defaultTheme,
  getSemanticSpacing,
  mergeWithDefaultTheme,
  tokenAround,
} from "../theme-context.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * CFChat - Chat container that handles message flow and tool call correlation
 *
 * @element cf-chat
 *
 * @prop {CellHandle<BuiltInLLMMessage[]>|BuiltInLLMMessage[]} messages - Messages array or Cell containing messages
 * @prop {boolean} pending - Show animated typing indicator for assistant response
 * @prop {CFTheme} theme - Theme configuration for chat components
 *
 * @example
 * <cf-chat .messages=${messagesCell} .pending=${true}></cf-chat>
 */
export class CFChat extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
      }

      .message-item {
        margin-bottom: var(--cf-spacing-1, 0.25rem);
      }

      .message-item.grouped {
        margin-bottom: var(--cf-spacing-1, 0.25rem);
      }

      .message-item.last-in-group {
        margin-bottom: var(--cf-spacing-4, 1rem);
      }

      .tool-attachments-only {
        display: flex;
        flex-direction: column;
        gap: var(--cf-spacing-1, 0.25rem);
        max-width: 70%;
        align-self: flex-start;
      }

      .pending-message {
        display: flex;
        align-items: flex-start;
        margin-bottom: var(
          --cf-theme-spacing-message-bottom,
          var(--cf-spacing-1, 0.25rem)
        );
      }

      .pending-bubble {
        background-color: var(
          --cf-theme-color-surface,
          #f2f3f6
        );
        color: var(--cf-theme-color-text-muted, #16181d);
        padding: var(
          --cf-theme-spacing-padding-bubble,
          var(--cf-spacing-3, 0.75rem)
        )
          var(
          --cf-theme-spacing-padding-bubble-horizontal,
          var(--cf-spacing-4, 1rem)
        );
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-lg, 0.5rem)
        );
        border: 1px solid var(--cf-theme-color-border-muted, #eceef1);
        max-width: 70%;
        display: flex;
        align-items: center;
        gap: var(--cf-theme-spacing-tight, var(--cf-spacing-1, 0.25rem));
      }

      .typing-dots {
        display: flex;
        gap: var(--cf-theme-spacing-tight, 4px);
      }

      .typing-dot {
        width: 8px;
        height: 8px;
        background-color: var(
          --cf-theme-color-text-muted,
          #b3b6bc
        );
        border-radius: 50%;
        animation: typingBounce 1.4s infinite ease-in-out;
      }

      .typing-dot:nth-child(1) {
        animation-delay: -0.32s;
      }

      .typing-dot:nth-child(2) {
        animation-delay: -0.16s;
      }

      @keyframes typingBounce {
        0%,
        80%,
        100% {
          opacity: 0.3;
          transform: scale(0.8);
        }
        40% {
          opacity: 1;
          transform: scale(1);
        }
      }
    `,
  ];

  /** Cell controller for messages binding */
  private _cellController = createCellController<BuiltInLLMMessage[]>(this, {
    timing: { strategy: "immediate" },
    onChange: () => {
      this.requestUpdate();
      // Emit event for parent scroll containers
      this.dispatchEvent(
        new CustomEvent("cf-chat-updated", {
          bubbles: true,
          composed: true,
        }),
      );
    },
  });

  @property({ type: Array })
  accessor messages: CellHandle<BuiltInLLMMessage[]> | BuiltInLLMMessage[] = [];

  @property({ type: Boolean, reflect: true })
  accessor pending = false;

  /**
   * A theme given to this element directly, partial or full, written over the
   * theme it would otherwise inherit. Left empty, the element draws the
   * ambient theme.
   */
  @property({ type: Object })
  accessor theme: any = {};

  /** The ambient theme, whose density the chat's own spacing follows. */
  @consume({ context: cfThemeContext, subscribe: true })
  @property({ attribute: false })
  accessor parentTheme: CFTheme = defaultTheme;

  /**
   * Whether a given theme's tokens are on the host, to be taken off when it
   * is withdrawn; tokens the element did not write are left alone.
   */
  #wroteGivenTheme = false;

  constructor() {
    super();
    this.messages = [];
    this.pending = false;
    this.theme = {};
  }

  private get _messagesArray(): readonly BuiltInLLMMessage[] {
    return this._cellController.getValue() || [];
  }

  override firstUpdated(changedProperties: Map<string, any>) {
    super.firstUpdated(changedProperties);
    // Initialize cell controller binding
    this._cellController.bind(this.messages, BuiltInLLMMessagesArraySchema);
  }

  /**
   * Writes the given theme, if any, and the chat's own spacing, which no
   * theme element sets and which follows the density in effect here.
   */
  #applyTheme() {
    const given = this.theme && Object.keys(this.theme).length > 0
      ? mergeWithDefaultTheme(this.theme, this.parentTheme)
      : undefined;
    if (given || this.#wroteGivenTheme) {
      applyThemeToElement(this, given, this.parentTheme);
    }
    this.#wroteGivenTheme = given !== undefined;
    const { density } = given ?? this.parentTheme;
    const spacing = {
      "message-bottom": getSemanticSpacing(density, "sm", "tight"),
      "padding-bubble": getSemanticSpacing(density, "lg", "normal"),
      "padding-bubble-horizontal": getSemanticSpacing(density, "xl", "normal"),
    };
    // A host that sets one of these by CSS keeps it: a token written here
    // would hide the host's.
    for (const [name, value] of Object.entries(spacing)) {
      const token = `--cf-theme-spacing-${name}`;
      if (tokenAround(this, token)) this.style.removeProperty(token);
      else this.style.setProperty(token, value);
    }
  }

  override willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);

    // If the messages property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("messages")) {
      // Bind the new messages (Cell or plain array) to the controller
      this._cellController.bind(this.messages, BuiltInLLMMessagesArraySchema);
    }

    if (
      !this.hasUpdated || changedProperties.has("theme") ||
      changedProperties.has("parentTheme")
    ) {
      this.#applyTheme();
    }
  }

  private _buildToolResultMap(): Map<string, BuiltInLLMToolResultPart> {
    const resultMap = new Map<string, BuiltInLLMToolResultPart>();

    this._messagesArray.forEach((message) => {
      if (message.role === "tool" && Array.isArray(message.content)) {
        message.content.forEach((part) => {
          if (part.type === "tool-result") {
            resultMap.set(part.toolCallId, part);
          }
        });
      }
    });

    return resultMap;
  }

  private _getMessageGroupClasses(messageIndex: number): string {
    const messages = this._messagesArray;
    const currentMessage = messages[messageIndex];
    const prevMessage = messages[messageIndex - 1];
    const nextMessage = messages[messageIndex + 1];

    const classes = ["message-item"];

    // Check if this message should be grouped with the previous one
    const shouldGroupWithPrev = prevMessage &&
      this._isSameGroup(prevMessage.role, currentMessage.role);

    // Check if this message should be grouped with the next one
    const shouldGroupWithNext = nextMessage &&
      this._isSameGroup(currentMessage.role, nextMessage.role);

    if (shouldGroupWithPrev || shouldGroupWithNext) {
      classes.push("grouped");
    }

    // Mark as last in group if not grouping with next message
    if (!shouldGroupWithNext) {
      classes.push("last-in-group");
    }

    return classes.join(" ");
  }

  private _isSameGroup(role1: string, role2: string): boolean {
    // User messages only group with other user messages
    if (role1 === "user") return role2 === "user";

    // Assistant and tool messages group together
    if (role1 === "assistant") return role2 === "assistant" || role2 === "tool";
    if (role1 === "tool") return role2 === "assistant" || role2 === "tool";

    return false;
  }

  private _renderMessage(
    message: BuiltInLLMMessage,
    toolResultMap: Map<string, BuiltInLLMToolResultPart>,
    messageIndex: number,
  ) {
    if (message.role === "tool") {
      // Don't render tool messages directly, they're handled as part of tool calls
      return null;
    }

    // For assistant messages with tool calls, we need to inject the results
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const toolCalls = message.content.filter(
        (part): part is BuiltInLLMToolCallPart => part.type === "tool-call",
      );
      const textParts = message.content.filter(
        (part) => part.type === "text",
      );

      if (toolCalls.length > 0) {
        // Create enhanced content with tool results
        const enhancedContent = [...message.content];

        toolCalls.forEach((toolCall) => {
          const result = toolResultMap.get(toolCall.toolCallId);
          if (result) {
            enhancedContent.push(result);
          }
        });

        // If there's no text content, render only the tool calls
        if (textParts.length === 0) {
          return html`
            <div class="${this._getMessageGroupClasses(messageIndex)}">
              <div class="tool-attachments-only">
                ${toolCalls.map((toolCall) => {
                  const toolResult = toolResultMap.get(toolCall.toolCallId);
                  return html`
                    <cf-tool-call
                      .call="${toolCall}"
                      .result="${toolResult}"
                    ></cf-tool-call>
                  `;
                })}
              </div>
            </div>
          `;
        }

        return html`
          <div class="${this._getMessageGroupClasses(messageIndex)}">
            <cf-chat-message
              .role="${message.role}"
              .content="${enhancedContent}"
            ></cf-chat-message>
          </div>
        `;
      }
    }

    return html`
      <div class="${this._getMessageGroupClasses(messageIndex)}">
        <cf-chat-message
          .role="${message.role}"
          .content="${message.content}"
        ></cf-chat-message>
      </div>
    `;
  }

  private _renderPendingMessage() {
    if (!this.pending) return null;

    return html`
      <div class="pending-message">
        <div class="pending-bubble">
          <div class="typing-dots">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
          </div>
        </div>
      </div>
    `;
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);

    // Emit event when pending state changes
    if (changed.has("pending")) {
      this.dispatchEvent(
        new CustomEvent("cf-chat-updated", {
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  override render() {
    const toolResultMap = this._buildToolResultMap();

    return html`
      ${this._messagesArray.map((message, index) =>
        this._renderMessage(message, toolResultMap, index)
      )} ${this._renderPendingMessage()}
    `;
  }
}
