import { css, html, nothing, render } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import {
  type CellHandle,
  NAME,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import type { DID } from "@commonfabric/identity";
import { BaseElement } from "../../core/base-element.ts";
import {
  AmbientThemeWatch,
  applyThemeToElement,
  type CFTheme,
  copyThemeProperties,
} from "../theme-context.ts";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";
import { uploadFile } from "../../utils/file-cell-storage.ts";
import {
  type Mentionable,
  type MentionableArray,
} from "../../core/mentionable.ts";
import { MentionController } from "../../core/mention-controller.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { hasIncompleteUpload, toSendAttachment } from "./send-attachments.ts";
import "../cf-button/index.ts";
import "../cf-chip/index.ts";
import "../cf-voice-input/index.ts";

/**
 * Attachment data structure
 */
export interface PromptAttachment {
  id: string; // UUID for reference
  name: string; // Display name
  type: "file" | "clipboard";
  data?: File | Blob | string;
  // Populated when `uploadAttachments` is enabled and a runtime + space
  // context are present: the file's bytes are uploaded to the content-addressed
  // blob store and the lightweight result is carried here, so a consumer can
  // persist/reference the blob instead of shipping the raw bytes. (cf-file-input
  // does the same upload via the shared uploadFile() util.)
  url?: string; // Blob-store URL once uploaded
  mediaType?: string; // Resolved media type, e.g. "image/png"
  size?: number; // Size in bytes
  uploading?: boolean; // True while the upload is in flight
  error?: string; // Upload error message, if it failed
  previewUrl?: string; // Local object URL for an instant image thumbnail
}

/**
 * Model picker item structure
 */
export interface ModelItem {
  label: string;
  value: string;
}

/**
 * CFPromptInput - Enhanced textarea input component with @-mentions and attachments support
 * Based on cf-message-input but with multiline support and prompt-specific features
 *
 * @element cf-prompt-input
 *
 * @attr {string} placeholder - Placeholder text for the textarea
 * @attr {string} buttonText - Text for the send button (default: "Send")
 * @attr {boolean} disabled - Whether the textarea and button are disabled (prevents any action)
 * @attr {boolean} pending - Whether the component is in pending state (blocks submit, shows stop button)
 * @attr {string} value - Current textarea value
 * @attr {boolean} autoResize - Whether textarea auto-resizes to fit content (default: true)
 * @attr {number} rows - Initial number of rows for the textarea (default: 1)
 * @attr {number} maxRows - Maximum number of rows for auto-resize (default: 10)
 * @attr {CellHandle<MentionableArray>} mentionable - Array of mentionable items for @-mention autocomplete
 * @attr {ModelItem[]} modelItems - Array of model options for the model picker
 * @attr {CellHandle<string>|string} model - Selected model value (supports Cell binding)
 *
 * @fires cf-send - Fired when send button is clicked or Enter is pressed. detail: { text: string, attachments: PromptAttachment[], mentions: [] }
 * @fires cf-stop - Fired when stop button is clicked during pending state
 * @fires cf-input - Fired when textarea value changes. detail: { value: string }
 * @fires cf-attachment-add - Fired when an attachment is added (file uploaded, clipboard). detail: { attachment: PromptAttachment }
 * @fires cf-attachment-remove - Fired when an attachment is removed from the composer. detail: { id: string }
 *
 * @example
 * <cf-prompt-input
 *   placeholder="Ask me anything..."
 *   button-text="Send"
 *   .mentionable=${mentionableCell}
 *   @cf-send="${(e) => console.log(e.detail.text, e.detail.mentions)}"
 * ></cf-prompt-input>
 */
export class CFPromptInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;

        /* CSS variables for customization */
        --cf-prompt-input-gap: var(
          --cf-theme-spacing-normal,
          var(--cf-spacing-2, 0.5rem)
        );
        --cf-prompt-input-padding: var(
          --cf-theme-spacing-loose,
          var(--cf-spacing-3, 0.75rem)
        );
        --cf-prompt-input-border-radius: var(
          --cf-theme-border-radius,
          var(--cf-radius-md, 0.375rem)
        );
        --cf-prompt-input-border: var(
          --cf-theme-color-border,
          var(--cf-border-color, #e2e8f0)
        );
        --cf-prompt-input-background: var(
          --cf-theme-color-background,
          var(--cf-background, #ffffff)
        );
        --cf-prompt-input-min-height: var(--cf-size-lg-height, 40px);
        --cf-prompt-input-max-height: 12rem;
        --cf-prompt-input-action-gap: var(
          --cf-theme-spacing-tight,
          var(--cf-spacing-1, 0.25rem)
        );
      }

      .container {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: var(--cf-prompt-input-gap);
        padding: var(--cf-prompt-input-padding);
        background: var(--cf-prompt-input-background);
        border: 1px solid var(--cf-prompt-input-border);
        border-radius: var(--cf-prompt-input-border-radius);
        transition: all var(--cf-theme-animation-duration, 150ms)
          cubic-bezier(0.4, 0, 0.2, 1);
      }

      .container:focus-within {
        border-color: var(--cf-theme-color-primary, #3b82f6);
        box-shadow: 0 0 0 0.5px
          var(--cf-theme-color-primary, rgba(59, 130, 246, 0.1));
      }

      .input-row {
        position: relative;
        display: flex;
        align-items: flex-end;
        gap: var(--cf-prompt-input-action-gap);
      }

      .textarea-wrapper {
        flex: 1;
        position: relative;
        min-width: 0;
      }

      textarea {
        width: 100%;
        border: none;
        background: transparent;
        padding: 0;
        min-height: var(--cf-prompt-input-min-height);
        max-height: var(--cf-prompt-input-max-height);
        resize: none;
        font-family: var(--cf-theme-font-family, inherit);
        font-size: 0.875rem;
        line-height: 1.25rem;
        color: var(--cf-theme-color-text, #111827);
        overflow-y: auto;
      }

      textarea:focus {
        outline: none;
      }

      textarea::placeholder {
        color: var(--cf-theme-color-text-muted, #9ca3af);
      }

      .send-button-wrapper {
        display: flex;
        align-items: flex-end;
        gap: var(--cf-theme-spacing-tight, var(--cf-spacing-1, 0.25rem));
        padding-bottom: 0.125rem;
        flex: 0 0 auto;
      }

      .controls-row {
        display: flex;
        align-items: center;
        gap: var(--cf-theme-spacing-tight, var(--cf-spacing-1, 0.25rem));
      }

      cf-button {
        white-space: nowrap;
        min-width: auto;
      }

      /* Disabled state */
      :host([disabled]) .container {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Size variants */
      :host([size="sm"]) {
        --cf-prompt-input-padding: var(
          --cf-theme-spacing-normal,
          var(--cf-spacing-2, 0.5rem)
        );
        --cf-prompt-input-min-height: var(--cf-size-md-height, 32px);
      }

      :host([size="lg"]) {
        --cf-prompt-input-padding: var(
          --cf-theme-spacing-loose,
          var(--cf-spacing-4, 1rem)
        );
        --cf-prompt-input-min-height: var(--cf-size-xl-height, 48px);
      }

      /* Compact variant - minimal padding */
      :host([variant="compact"]) {
        --cf-prompt-input-padding: var(
          --cf-theme-spacing-normal,
          var(--cf-spacing-2, 0.5rem)
        );
        --cf-prompt-input-gap: var(
          --cf-theme-spacing-tight,
          var(--cf-spacing-1, 0.25rem)
        );
      }

      /* Pills list styles */
      .pills-list {
        display: flex;
        flex-wrap: wrap;
        gap: var(--cf-theme-spacing-tight, var(--cf-spacing-1, 0.25rem));
      }

      /* Image attachment thumbnail in a chip's icon slot */
      .attachment-thumb {
        width: 1.5rem;
        height: 1.5rem;
        object-fit: cover;
        border-radius: 4px;
        display: block;
      }

      /* File upload styles */
      .upload-button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.5rem;
        height: var(--cf-size-sm-height, 24px);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-radius-sm, 0.25rem)
        );
        cursor: pointer;
        transition: background-color 0.15s;
        color: var(--cf-theme-color-text-muted, #6b7280);
        font-size: 1rem;
      }

      .upload-button:hover {
        background: var(--cf-theme-color-surface, #f3f4f6);
        color: var(--cf-theme-color-text, #111827);
      }

      input[type="file"] {
        display: none;
      }

      /* Model picker styles */
      .model-select {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.25rem 0.625rem;
        background: var(--cf-theme-color-surface, #f5f5f5);
        color: var(--cf-theme-color-text, #212121);
        border: 1px solid var(--cf-theme-color-border, #e0e0e0);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        font-size: 0.8125rem;
        line-height: 1;
        font-family: var(--cf-theme-font-family, inherit);
        cursor: pointer;
        transition:
          background-color var(--cf-theme-animation-duration, 200ms) ease,
          border-color var(--cf-theme-animation-duration, 200ms) ease;
        appearance: none;
        -moz-appearance: none;
        -webkit-appearance: none;
        outline: none;
        height: auto;
        min-width: 80px;
        max-width: 150px;
      }

      .model-select:hover {
        background: var(--cf-theme-color-surface-hover, #eeeeee);
      }

      .model-select:focus {
        border-color: var(--cf-theme-color-primary, #3b82f6);
        box-shadow: 0 0 0 0.5px
          var(--cf-theme-color-primary, rgba(59, 130, 246, 0.1));
      }

      /* Embedded voice input - compact styling */
      .voice-wrapper cf-voice-input {
        --cf-theme-spacing-normal: 0;
      }

      .voice-wrapper cf-voice-input::part(container) {
        gap: 0;
      }

      /* Override the voice input button to fit the controls row */
      .voice-wrapper {
        display: flex;
        align-items: center;
      }
    `,
  ];

  static override properties = {
    placeholder: { type: String },
    buttonText: { type: String, attribute: "button-text" },
    disabled: { type: Boolean, reflect: true },
    pending: { type: Boolean, reflect: true },
    value: { type: String },
    autoResize: { type: Boolean, attribute: "auto-resize" },
    rows: { type: Number },
    maxRows: { type: Number, attribute: "max-rows" },
    size: { type: String, reflect: true },
    variant: { type: String, reflect: true },
    theme: { type: Object, attribute: false },
    mentionable: { type: Object, attribute: false },
    modelItems: { type: Array, attribute: false },
    model: { type: Object, attribute: false },
    voice: { type: Boolean, reflect: true },
    uploadAttachments: { type: Boolean, attribute: "upload-attachments" },
  };

  declare placeholder: string;
  declare buttonText: string;
  declare disabled: boolean;
  declare pending: boolean;
  declare value: string;
  declare autoResize: boolean;
  declare rows: number;
  declare maxRows: number;
  declare size: string;
  declare variant: string;
  declare mentionable: CellHandle<MentionableArray> | null;
  declare modelItems: Array<ModelItem | undefined>;
  declare model: CellHandle<string> | string | null;
  declare voice: boolean;

  /**
   * Whether to upload `File`/`Blob` attachments to the blob store on add.
   * Default off, so a consumer that does not opt in keeps the raw-`File`
   * pass-through behavior.
   */
  declare uploadAttachments: boolean;

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  /**
   * The runtime, consumed so the component can upload attachment bytes itself
   * when `uploadAttachments` is set.
   */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  /** The space the runtime uploads into, consumed alongside `runtime`. */
  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  private _textareaElement?: HTMLElement;
  private _modelSelectElement?: HTMLSelectElement;

  /** The attachments, keyed by attachment id. */
  private attachments: Map<string, PromptAttachment> = new Map();

  /**
   * In-flight upload promises, keyed by attachment id, so a submit can wait
   * for them before emitting (see `_handleSend()`).
   */
  private _uploadPromises: Map<string, Promise<void>> = new Map();

  /**
   * Whether a submit is awaiting in-flight uploads, which disables the send
   * button.
   */
  private _sending = false;

  /** The mention controller. */
  private mentionController = new MentionController(this, {
    onInsert: (markdown, mentionCell) =>
      this._insertMentionAtCursor(markdown, mentionCell),
    getCursorPosition: () => this._getCursorPosition(),
    getContent: () => this.value,
  });

  /** Cell controller for the model binding. */
  private _modelController = createCellController<string>(this, {
    timing: { strategy: "immediate" },
  });

  // Overlay management for mentions dropdown (rendered in body)
  private _mentionsOverlay: HTMLDivElement | null = null;
  private _resizeObs?: ResizeObserver;
  private _raf?: number;

  constructor() {
    super();
    new AmbientThemeWatch(this, () => {
      if (this._mentionsOverlay) {
        copyThemeProperties(this, this._mentionsOverlay);
      }
    });
    this.placeholder = "";
    this.buttonText = "Send";
    this.disabled = false;
    this.pending = false;
    this.value = "";
    this.autoResize = true;
    this.rows = 1;
    this.maxRows = 10;
    this.size = "";
    this.variant = "";
    this.mentionable = null;
    this.modelItems = [];
    this.model = null;
    this.voice = false;
    this.uploadAttachments = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._resizeObs = new ResizeObserver(() =>
      this._repositionMentionsOverlay()
    );
    this._resizeObs.observe(this);
    globalThis.addEventListener("resize", this._onWindowChange, {
      passive: true,
    });
    globalThis.addEventListener("scroll", this._onWindowChange, true);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const att of this.attachments.values()) this._revokePreview(att);
    this._resizeObs?.disconnect();
    this._resizeObs = undefined;
    globalThis.removeEventListener("resize", this._onWindowChange);
    globalThis.removeEventListener("scroll", this._onWindowChange, true);
    this._unmountMentionsOverlay();
  }

  private _onWindowChange = () => {
    if (!this.mentionController.isShowing) return;
    this._repositionMentionsOverlay();
  };

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    this._textareaElement = this.shadowRoot?.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    this._modelSelectElement = this.shadowRoot?.querySelector(
      ".model-select",
    ) as HTMLSelectElement;
    this._applyModelValueToDom();
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
      if (this._mentionsOverlay) {
        copyThemeProperties(this, this._mentionsOverlay);
      }
    }
    if (changedProperties.has("mentionable")) {
      this.mentionController.setMentionable(this.mentionable);
    }
    if (changedProperties.has("model") && this.model != null) {
      this._modelController.bind(this.model);
    }
    if (
      changedProperties.has("model") ||
      changedProperties.has("modelItems")
    ) {
      this._applyModelValueToDom();
    }

    // Manage mentions overlay based on controller state
    // The MentionController will trigger requestUpdate when state changes
    if (this.mentionController.isShowing) {
      this._mountMentionsOverlay();
      this._renderMentionsOverlay();
      this._positionMentionsOverlay();
    } else {
      this._unmountMentionsOverlay();
    }
  }

  private async _handleSend(event?: Event) {
    event?.preventDefault();

    if (this.disabled || this.pending || this._sending) return;

    const textarea = this._textareaElement as any;
    if (!textarea || !textarea.value?.trim()) return;

    const text = textarea.value;

    // Wait for any in-flight attachment uploads so each attachment carries its
    // blob `url` before we emit. Without this, a quick submit races the async
    // upload and the consumer receives a ref-less attachment (the bug that made
    // a captured image silently vanish). The send button is disabled while
    // _sending so the user sees the brief wait.
    const pending = Array.from(this._uploadPromises.values());
    if (pending.length > 0) {
      this._sending = true;
      this.requestUpdate();
      try {
        await Promise.allSettled(pending);
      } finally {
        this._sending = false;
        this.requestUpdate();
      }
    }

    // Block the send if any opted-in upload failed or never produced a `url`.
    // Emitting it would hand the consumer an attachment with neither a usable
    // `url` nor the raw bytes (the upload consumed them) — silent data loss. We
    // keep the textarea + attachments intact so the user can retry or remove;
    // the failing pill already shows a ⚠️ with the error and a remove button.
    const hasContext = !!(this.runtime && this.space);
    if (
      hasIncompleteUpload(this.attachments.values(), {
        uploadAttachments: this.uploadAttachments,
        hasContext,
      })
    ) {
      this.requestUpdate();
      return;
    }

    // Emit a serializable view of each attachment (see toSendAttachment): the
    // raw `data` is dropped ONLY for a successfully-uploaded blob (the consumer
    // uses its `url`; a non-cloneable File would be dropped by structured-clone
    // into a sandboxed handler, which silently lost the uploaded `url`). For
    // non-uploaded attachments — upload off, no runtime/space, or string
    // clipboard content — `data` is preserved so default-off consumers are
    // unaffected (backward compatible). `previewUrl` (a local blob: URL) is
    // never emitted.
    const attachments = Array.from(this.attachments.values()).map(
      toSendAttachment,
    );

    // Clear the textarea and attachments
    textarea.value = "";
    this.value = "";
    for (const att of this.attachments.values()) this._revokePreview(att);
    this.attachments.clear();
    this._uploadPromises.clear();

    // Emit the send event. `attachments` is the lightweight (File-free) view
    // built above, which serializes cleanly into a sandboxed handler — a raw
    // File in the detail silently dropped the whole attachment.
    this.emit("cf-send", {
      text,
      attachments,
      mentions: [], // Mentions are now in the text as markdown links
      message: text,
    });
  }

  private _handleStop(event?: Event) {
    event?.preventDefault();

    if (this.disabled) return;

    // Emit the stop event
    this.emit("cf-stop");
  }

  private _handleKeyDown(event: KeyboardEvent) {
    // Don't handle shortcuts if disabled
    if (this.disabled) return;

    // Let mention controller handle keyboard events first
    if (this.mentionController.handleKeyDown(event)) {
      return;
    }

    // Enter without Shift sends the message (blocked if pending)
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!this.pending) {
        this._handleSend();
      }
      return;
    }

    // Shift+Enter adds new line (default textarea behavior)
    // Ctrl/Cmd+Enter also sends (alternative shortcut, blocked if pending)
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!this.pending) {
        this._handleSend();
      }
      return;
    }
  }

  private _handleInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    this.value = textarea.value;

    // Auto-resize textarea if enabled
    if (this.autoResize) {
      textarea.style.height = "auto";
      textarea.style.height = `${
        Math.min(
          textarea.scrollHeight,
          parseFloat(
            getComputedStyle(this).getPropertyValue(
              "--cf-prompt-input-max-height",
            ) || "12rem",
          ) * 16,
        )
      }px`;
    }

    // Let mention controller handle input changes
    this.mentionController.handleInput(event);

    // Emit input event for external listeners
    this.emit("cf-input", { value: this.value });
  }

  /**
   * Handle paste event for large content detection
   */
  private _handlePaste(event: ClipboardEvent) {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    // Collect attachment files from BOTH `files` and `items`. A web-copied
    // image frequently lands only in `items` (not `files`) — that asymmetry is
    // why a native screenshot attached but a copied web image did not.
    const collected: File[] = [];
    const seen = new Set<string>();
    const add = (f: File | null) => {
      if (!f) return;
      const key = `${f.name}|${f.size}|${f.type}`;
      if (seen.has(key)) return;
      seen.add(key);
      collected.push(f);
    };
    for (const f of Array.from(clipboardData.files)) add(f);
    for (const item of Array.from(clipboardData.items)) {
      if (item.kind === "file") add(item.getAsFile());
    }
    if (collected.length > 0) {
      event.preventDefault();
      for (const file of collected) {
        this.addAttachment({
          id: this._generateAttachmentId(),
          name: file.name ||
            (file.type.startsWith("image/") ? "Pasted image" : "Pasted file"),
          type: "clipboard",
          data: file,
        });
      }
      return;
    }

    // Web-copied image with no bytes on the clipboard — only an <img> in the
    // HTML flavor. Fetch it (handles data: URIs and CORS-permitting remotes).
    // We must preventDefault synchronously (the event is consumed the moment
    // this handler returns) but the fetch is async, so capture the plain-text
    // flavor NOW and restore it if the fetch fails — otherwise a CORS/network
    // failure would silently swallow the paste entirely.
    if (this.uploadAttachments) {
      const html = clipboardData.getData("text/html");
      const src = html ? this._firstImgSrc(html) : null;
      if (src) {
        const plain = clipboardData.getData("text");
        // Don't fall back to a giant base64 data: URI as text; only a real
        // text flavor (or an http(s) src) is worth restoring.
        const fallbackText = plain || (src.startsWith("data:") ? "" : src);
        event.preventDefault();
        void this._attachRemoteImage(src).then((ok) => {
          if (!ok) this._insertTextAtCursor(fallbackText);
        });
        return;
      }
    }

    // Check for large text content (>1000 chars)
    const text = clipboardData.getData("text");
    if (text && text.length > 1000) {
      event.preventDefault();

      const id = this._generateAttachmentId();
      const attachment: PromptAttachment = {
        id,
        name: `Pasted content (${text.length} chars)`,
        type: "clipboard",
        data: text,
      };

      this.addAttachment(attachment);

      // Insert reference to the attachment in the text
      const textarea = this._textareaElement as HTMLTextAreaElement;
      const cursorPos = textarea.selectionStart;
      const beforeCursor = this.value.substring(0, cursorPos);
      const afterCursor = this.value.substring(textarea.selectionEnd);

      const reference = `[${attachment.name}](#${id})`;
      this.value = beforeCursor + reference + afterCursor;
      textarea.value = this.value;

      // Set cursor after the reference
      const newCursorPos = beforeCursor.length + reference.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);

      this.requestUpdate();
    }
  }

  /**
   * Get current cursor position in the textarea
   */
  private _getCursorPosition(): number {
    const textarea = this._textareaElement as HTMLTextAreaElement;
    return textarea?.selectionStart ?? 0;
  }

  /**
   * Insert mention at cursor position
   */
  private _insertMentionAtCursor(
    markdown: string,
    _mentionCell: CellHandle<Mentionable>,
  ): void {
    const textarea = this._textareaElement as HTMLTextAreaElement;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = this.value.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex === -1) return;

    const beforeMention = this.value.substring(0, lastAtIndex);
    const afterMention = this.value.substring(cursorPos);

    // Use the markdown link from the mention controller, which includes
    // the resolved piece entity ID (not the array sub-path)
    this.value = beforeMention + markdown + afterMention;
    textarea.value = this.value;

    // Set cursor after the inserted mention
    const newCursorPos = beforeMention.length + markdown.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);
    textarea.focus();

    this.requestUpdate();
  }

  /** Extract the first <img src> from pasted HTML (data: or http(s) only). */
  private _firstImgSrc(html: string): string | null {
    const m = html.match(/<img[^>]+\bsrc=["']([^"']+)["']/i);
    if (!m) return null;
    const src = m[1].trim();
    if (src.startsWith("data:image/") || /^https?:\/\//i.test(src)) return src;
    return null;
  }

  /**
   * Fetch a remote/data image URL and attach it as an uploadable blob. Returns
   * true if an attachment was added, false on any failure (non-ok response,
   * non-image content, CORS/network error) so the caller can restore the
   * plain-text flavor it suppressed with preventDefault().
   */
  private async _attachRemoteImage(src: string): Promise<boolean> {
    try {
      const resp = await fetch(src);
      if (!resp.ok) return false;
      const blob = await resp.blob();
      if (!blob.type.startsWith("image/")) return false;
      this.addAttachment({
        id: this._generateAttachmentId(),
        name: this._imageNameFromUrl(src, blob.type),
        type: "clipboard",
        data: blob,
      });
      return true;
    } catch {
      // CORS or network failure — caller restores the suppressed text paste.
      return false;
    }
  }

  /** Insert text at the current cursor (or append if the textarea is absent). */
  private _insertTextAtCursor(text: string): void {
    if (!text) return;
    const textarea = this._textareaElement as HTMLTextAreaElement | null;
    if (!textarea) {
      this.value = this.value + text;
      this.requestUpdate();
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = this.value.substring(0, start);
    const after = this.value.substring(end);
    this.value = before + text + after;
    textarea.value = this.value;
    const pos = before.length + text.length;
    textarea.setSelectionRange(pos, pos);
    this.requestUpdate();
  }

  private _imageNameFromUrl(src: string, mimeType: string): string {
    const ext = mimeType.split("/")[1]?.split("+")[0] || "png";
    if (src.startsWith("data:")) return `pasted-image.${ext}`;
    try {
      const path = new URL(src).pathname;
      const base = path.substring(path.lastIndexOf("/") + 1);
      if (base && base.includes(".")) return base;
      if (base) return `${base}.${ext}`;
    } catch {
      // not a parseable URL — fall through
    }
    return `pasted-image.${ext}`;
  }

  override render() {
    return html`
      <div style="position: relative;">
        <div class="container">
          ${this._renderPillsList()}

          <div class="input-row">
            <div class="textarea-wrapper">
              <textarea
                placeholder="${this.placeholder}"
                .value="${this.value}"
                rows="${this.rows}"
                ?disabled="${this.disabled}"
                spellcheck="true"
                @input="${this._handleInput}"
                @keydown="${this._handleKeyDown}"
                @paste="${this._handlePaste}"
                part="textarea"
              ></textarea>
              <!-- Mentions dropdown now rendered in body via overlay -->

              <!-- Send/Stop button overlayed on right -->
              <div class="send-button-wrapper">
                ${this.pending
                  ? html`
                    <cf-button
                      id="cf-prompt-input-stop-button"
                      color="neutral"
                      variant="outline"
                      size="${this.size === "sm"
                        ? "sm"
                        : this.size === "lg"
                        ? "lg"
                        : "md"}"
                      ?disabled="${this.disabled}"
                      @click="${this._handleStop}"
                      part="stop-button"
                    >
                      Stop
                    </cf-button>
                  `
                  : html`
                    <cf-button
                      id="cf-prompt-input-send-button"
                      color="primary"
                      variant="solid"
                      size="${this.size === "sm"
                        ? "sm"
                        : this.size === "lg"
                        ? "lg"
                        : "md"}"
                      ?disabled="${this.disabled || !this.value?.trim() ||
                        this._sending}"
                      @click="${this._handleSend}"
                      part="send-button"
                    >
                      ${this.buttonText}
                    </cf-button>
                  `}
              </div>
            </div>
          </div>

          <!-- Controls row underneath -->
          <div class="controls-row">
            <!-- Hidden file input -->
            <input
              type="file"
              multiple
              @change="${this._handleFileSelect}"
            />

            <!-- Model picker -->
            ${this.modelItems && this.modelItems.length > 0
              ? html`
                <select
                  class="model-select"
                  @change="${this._handleModelChange}"
                  ?disabled="${this.disabled || this.pending}"
                  title="Select model"
                >
                  ${(this.modelItems.filter(Boolean) as ModelItem[]).map(
                    (
                      item,
                    ) =>
                      html`
                        <option value="${item.value}">
                          ${item.label}
                        </option>
                      `,
                  )}
                </select>
              `
              : ""}

            <!-- Upload button -->
            <div
              class="upload-button"
              @click="${this._handleUploadClick}"
              role="button"
              aria-label="Upload file"
              title="Upload file"
            >
              📎
            </div>

            <!-- Voice input -->
            ${this.voice
              ? html`
                <div class="voice-wrapper">
                  <cf-voice-input
                    recordingMode="hold"
                    autoTranscribe
                    .showWaveform="${false}"
                    ?disabled="${this.disabled}"
                    @cf-transcription-complete="${this
                      ._handleTranscription}"
                  ></cf-voice-input>
                </div>
              `
              : ""}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Generate a unique ID for attachments
   */
  private _generateAttachmentId(): string {
    return `attachment-${Date.now()}-${
      Math.random().toString(36).substring(2, 9)
    }`;
  }

  /**
   * Add an attachment
   */
  addAttachment(attachment: PromptAttachment): void {
    this._makeImagePreview(attachment);
    this.attachments.set(attachment.id, attachment);
    this.emit("cf-attachment-add", { attachment });
    this.requestUpdate();
    // Track the upload promise so a submit can await it (see _handleSend); it
    // mutates the attachment + requestUpdate()s as its state changes, and
    // re-emits cf-attachment-add when the url is ready.
    const p = this._maybeUploadAttachment(attachment).finally(() => {
      this._uploadPromises.delete(attachment.id);
    });
    this._uploadPromises.set(attachment.id, p);
  }

  /**
   * Remove an attachment by ID
   */
  removeAttachment(id: string): void {
    const existing = this.attachments.get(id);
    this._revokePreview(existing);
    this.attachments.delete(id);
    // Drop the tracked upload promise too, so a still-in-flight upload for an
    // attachment the user already removed cannot delay the next send (_handleSend
    // awaits _uploadPromises before emitting).
    this._uploadPromises.delete(id);
    this.emit("cf-attachment-remove", { id });
    this.requestUpdate();
  }

  /**
   * Give image attachments an instant local thumbnail (revoked on remove/send).
   */
  private _makeImagePreview(attachment: PromptAttachment): void {
    const data = attachment.data;
    if (
      (data instanceof File || data instanceof Blob) &&
      (data.type || "").startsWith("image/")
    ) {
      try {
        attachment.previewUrl = URL.createObjectURL(data);
      } catch {
        // No object URL available (non-browser env) — fall back to the icon.
      }
    }
  }

  private _revokePreview(attachment: PromptAttachment | undefined): void {
    if (attachment?.previewUrl) {
      try {
        URL.revokeObjectURL(attachment.previewUrl);
      } catch {
        // ignore
      }
      attachment.previewUrl = undefined;
    }
  }

  /**
   * Upload a File/Blob attachment to the blob store when opted in. We own this
   * component and it's bound to our runtime, so it can upload directly rather
   * than handing the consumer raw bytes it can't persist. Mutates the
   * attachment in place (uploading/url/error) and requestUpdate()s.
   */
  private async _maybeUploadAttachment(
    attachment: PromptAttachment,
  ): Promise<void> {
    const data = attachment.data;
    if (!this.uploadAttachments) return;
    if (!(data instanceof File) && !(data instanceof Blob)) return;
    // No runtime/space context — leave the raw data for the consumer.
    if (!this.runtime || !this.space) return;

    attachment.uploading = true;
    this.requestUpdate();
    try {
      const file = data instanceof File
        ? data
        : new File([data], attachment.name || "file", { type: data.type });
      const stored = await uploadFile({
        file,
        runtime: this.runtime,
        space: this.space,
      });
      attachment.url = stored.url;
      attachment.mediaType = stored.mediaType;
      attachment.size = stored.size;
      attachment.error = undefined;
    } catch (err) {
      attachment.error = err instanceof Error ? err.message : String(err);
    } finally {
      attachment.uploading = false;
      this.requestUpdate();
      // Re-emit so consumers listening on cf-attachment-add receive the url.
      this.emit("cf-attachment-add", { attachment });
    }
  }

  /**
   * Get icon for attachment type
   */
  private _getAttachmentIcon(type: PromptAttachment["type"]): string {
    switch (type) {
      case "file":
        return "📎";
      case "clipboard":
        return "📋";
      default:
        return "📄";
    }
  }

  private _getAttachmentVariant(
    type: PromptAttachment["type"],
  ): "default" | "primary" | "accent" {
    switch (type) {
      case "clipboard":
        return "accent";
      case "file":
      default:
        return "default";
    }
  }

  /**
   * Render pills list for attachments
   */
  private _renderPillsList() {
    if (this.attachments.size === 0) {
      return "";
    }

    const attachmentsArray = Array.from(this.attachments.values());

    return html`
      <div class="pills-list">
        ${attachmentsArray.map((attachment) => {
          // Prefer a local object URL for an instant preview, then the uploaded
          // blob URL once it lands; only images get a thumbnail.
          const dataType =
            (attachment.data instanceof File || attachment.data instanceof Blob)
              ? attachment.data.type
              : "";
          const isImage = (attachment.mediaType || dataType || "")
            .startsWith("image/");
          const thumb = attachment.previewUrl ??
            (isImage ? attachment.url : undefined);
          return html`
            <cf-chip
              variant="${this._getAttachmentVariant(attachment.type)}"
              removable
              @cf-remove="${() => this.removeAttachment(attachment.id)}"
            >
              ${attachment.uploading
                ? html`
                  <span>⏳ </span>
                `
                : ""}${attachment
                  .error
                ? html`
                  <span title="${attachment.error}">⚠️ </span>
                `
                : ""}${attachment.name} ${thumb
                ? html`
                  <img
                    slot="icon"
                    class="attachment-thumb"
                    src="${thumb}"
                    alt="${attachment.name}"
                  />
                `
                : html`
                  <span slot="icon">${this._getAttachmentIcon(
                    attachment.type,
                  )}</span>
                `}
            </cf-chip>
          `;
        })}
      </div>
    `;
  }

  /**
   * Handle voice transcription complete - append text to textarea
   */
  private _handleTranscription(e: CustomEvent) {
    const text = e.detail?.transcription?.text;
    if (!text) return;

    const textarea = this._textareaElement as HTMLTextAreaElement;
    if (!textarea) return;

    this.value = this.value + (this.value ? " " : "") + text;
    textarea.value = this.value;

    // Auto-resize and notify
    if (this.autoResize) {
      textarea.style.height = "auto";
      textarea.style.height = `${
        Math.min(
          textarea.scrollHeight,
          parseFloat(
            getComputedStyle(this).getPropertyValue(
              "--cf-prompt-input-max-height",
            ) || "12rem",
          ) * 16,
        )
      }px`;
    }

    this.emit("cf-input", { value: this.value });
    textarea.focus();
  }

  /**
   * Handle file upload button click
   */
  private _handleUploadClick() {
    const fileInput = this.shadowRoot?.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fileInput?.click();
  }

  /**
   * Handle file selection
   */
  private _handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;

    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      const id = this._generateAttachmentId();
      const attachment: PromptAttachment = {
        id,
        name: file.name,
        type: "file",
        data: file,
      };

      this.addAttachment(attachment);
    }

    // Reset the input so the same file can be selected again
    input.value = "";
  }

  /**
   * Handle model selection change
   */
  private _handleModelChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    const newValue = select.value;
    this._modelController.setValue(newValue);

    // When model is a plain string (not bound to Cell), update it directly
    if (typeof this.model === "string") {
      this.model = newValue;
    }
  }

  /**
   * Apply the current model value to the DOM select element
   * This ensures the select element shows the correct selected option
   */
  private _applyModelValueToDom() {
    // Re-query if we don't have a reference (e.g., model picker appeared after first render)
    if (!this._modelSelectElement) {
      this._modelSelectElement = this.shadowRoot?.querySelector(
        ".model-select",
      ) as HTMLSelectElement;
    }

    if (!this._modelSelectElement) return;

    const currentValue = this._modelController.getValue();
    if (currentValue != null) {
      this._modelSelectElement.value = String(currentValue);
    }
  }

  /**
   * Mount the mentions overlay in the document body
   */
  private _mountMentionsOverlay() {
    if (this._mentionsOverlay) return;
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.inset = "0 auto auto 0";
    el.style.zIndex = "1000";
    el.style.pointerEvents = "auto";
    el.dataset.cfPromptInputMentionsOverlay = "";
    document.body.appendChild(el);
    this._mentionsOverlay = el;
    copyThemeProperties(this, el);
  }

  /**
   * Unmount the mentions overlay from the document body
   */
  private _unmountMentionsOverlay() {
    if (this._mentionsOverlay) {
      render(nothing, this._mentionsOverlay);
      this._mentionsOverlay.remove();
      this._mentionsOverlay = null;
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = undefined;
  }

  /**
   * Render the mentions dropdown into the overlay
   */
  private _renderMentionsOverlay() {
    if (!this._mentionsOverlay) return;

    const filteredMentions = this.mentionController.getFilteredMentions();

    if (filteredMentions.length === 0) {
      this._unmountMentionsOverlay();
      return;
    }

    // Inline styles so overlay has its own styling
    const tpl = html`
      <style>
      .mentions-dropdown {
        position: absolute;
        background: var(--cf-theme-color-surface, #fff);
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(--cf-theme-border-radius, 0.375rem);
        box-shadow: var(--cf-shadow-md, 0 10px 15px -3px rgba(0,0,0,0.1),
          0 4px 6px -2px rgba(0,0,0,0.05));
        max-height: 200px;
        overflow-y: auto;
        min-width: 200px;
        pointer-events: auto;
      }
      .mention-item {
        padding: 0.5rem 0.75rem;
        cursor: pointer;
        border-bottom: 1px solid var(--cf-theme-color-border, #e5e7eb);
        transition: background-color 0.1s;
      }
      .mention-item:last-child {
        border-bottom: none;
      }
      .mention-item:hover,
      .mention-item.selected {
        background-color: var(--cf-theme-color-surface, #f3f4f6);
      }
      .mention-name {
        font-weight: 500;
        color: var(--cf-theme-color-text, #111827);
      }
      </style>
      <div class="mentions-dropdown" role="listbox">
        ${filteredMentions.map((mentionCell, index) =>
          html`
            <div
              class="mention-item ${index ===
                  this.mentionController.state.selectedIndex
                ? "selected"
                : ""}"
              role="option"
              @click="${() =>
                this.mentionController.insertMention(mentionCell)}"
              @mouseenter="${() => this.mentionController.selectMention(index)}"
            >
              <div class="mention-name">${mentionCell.get()?.[NAME]}</div>
            </div>
          `
        )}
      </div>
    `;
    render(tpl, this._mentionsOverlay);
  }

  /**
   * Position the mentions overlay relative to the textarea
   */
  private _positionMentionsOverlay() {
    if (!this._mentionsOverlay) return;
    const dropdown = this._mentionsOverlay.querySelector(
      ".mentions-dropdown",
    ) as HTMLElement | null;
    if (!dropdown) return;

    const textarea = this._textareaElement as HTMLTextAreaElement;
    if (!textarea) return;

    const rect = textarea.getBoundingClientRect();
    // Start below the textarea
    let top = rect.bottom + 2;
    let left = rect.left;

    // Temporarily set position for measurement
    dropdown.style.top = `${Math.round(top)}px`;
    dropdown.style.left = `${Math.round(left)}px`;
    dropdown.style.right = "auto";
    dropdown.style.bottom = "auto";

    // Next frame, measure and adjust to viewport
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      const vw = globalThis.innerWidth;
      const vh = globalThis.innerHeight;
      const dr = dropdown.getBoundingClientRect();

      // Horizontal clamping
      if (dr.right > vw - 8) {
        left = Math.max(8, vw - dr.width - 8);
      }
      if (left < 8) left = 8;

      // Vertical flip if overflow bottom
      if (dr.bottom > vh - 8) {
        const above = rect.top - dr.height - 2;
        if (above >= 8) top = above; // place above if space
        else top = Math.max(8, vh - dr.height - 8); // clamp
      }

      dropdown.style.top = `${Math.round(top)}px`;
      dropdown.style.left = `${Math.round(left)}px`;
    });
  }

  /**
   * Reposition the mentions overlay (for resize/scroll)
   */
  private _repositionMentionsOverlay() {
    this._positionMentionsOverlay();
  }

  /**
   * Focus the textarea programmatically
   */
  override focus(): void {
    (this._textareaElement as any)?.focus?.();
  }

  /**
   * Clear the textarea value
   */
  clear(): void {
    const textarea = this._textareaElement as any;
    if (textarea) {
      textarea.value = "";
      this.value = "";
    }
  }

  /**
   * Check if the input has content
   */
  get hasContent(): boolean {
    return !!this.value?.trim();
  }
}
