import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  type CellHandle,
  isCellHandle,
  NAME,
} from "@commonfabric/runtime-client";
import {
  type Mentionable,
  type MentionableArray,
  MentionableArraySchema,
  MentionableSchema,
} from "./mentionable.ts";
import { valueForDisplay } from "./value-for-display.ts";

/**
 * Configuration for the MentionController
 */
export interface MentionControllerConfig {
  /**
   * The trigger character for mentions (default: "@")
   */
  trigger?: string;

  /**
   * Callback when a mention is inserted
   */
  onInsert?: (markdown: string, mention: CellHandle<Mentionable>) => void;

  /**
   * Callback to get current cursor position in the input element
   */
  getCursorPosition?: () => number;

  /**
   * Callback to get the current editing content
   */
  getContent?: () => string;
}

/**
 * State for mention autocomplete
 */
export interface MentionState {
  showing: boolean;
  query: string;
  selectedIndex: number;
}

/**
 * MentionController - Reusable Lit controller for @-mention autocomplete
 *
 * Handles:
 * - Trigger detection (@)
 * - Query extraction and filtering
 * - Keyboard navigation (ArrowUp/Down, Enter, Escape)
 * - Mention insertion as markdown links [name](#entityId)
 *
 * Usage:
 * ```typescript
 * class MyComponent extends LitElement {
 *   private mentionController = new MentionController(this, {
 *     onInsert: (mention, markdown) => this.insertAtCursor(markdown),
 *     getCursorPosition: () => this.textarea.selectionStart,
 *     getContent: () => this.textarea.value
 *   });
 *
 *   // In your input handler:
 *   handleInput(e: Event) {
 *     this.mentionController.handleInput(e);
 *   }
 *
 *   // In your keydown handler:
 *   handleKeyDown(e: KeyboardEvent) {
 *     if (this.mentionController.handleKeyDown(e)) {
 *       return; // Mention controller handled it
 *     }
 *     // ... rest of your keyboard handling
 *   }
 * }
 * ```
 */
export class MentionController implements ReactiveController {
  private host: ReactiveControllerHost;
  private config: Required<MentionControllerConfig>;

  /** The mention state. */
  private _state: MentionState = {
    showing: false,
    query: "",
    selectedIndex: 0,
  };

  // Mentionable items
  private _mentionable: CellHandle<MentionableArray> | null = null;
  private _mentionableTyped: CellHandle<MentionableArray> | null = null;
  private _mentionableUnsubscribe: (() => void) | null = null;

  constructor(
    host: ReactiveControllerHost,
    config: MentionControllerConfig = {},
  ) {
    this.host = host;
    this.config = {
      trigger: config.trigger ?? "@",
      onInsert: config.onInsert ?? (() => {}),
      getCursorPosition: config.getCursorPosition ?? (() => 0),
      getContent: config.getContent ?? (() => ""),
    };
    host.addController(this);
  }

  hostConnected(): void {
    this._setupMentionableSubscription();
  }

  hostDisconnected(): void {
    this._cleanupMentionableSubscription();
  }

  /**
   * Set the mentionable items
   */
  setMentionable(mentionable: CellHandle<MentionableArray> | null): void {
    this._cleanupMentionableSubscription();
    this._mentionable = mentionable;

    // Set up new subscription
    this._setupMentionableSubscription();

    this.host.requestUpdate();
  }

  /**
   * Get current mention state
   */
  get state(): MentionState {
    return this._state;
  }

  /**
   * Check if mentions dropdown is showing
   */
  get isShowing(): boolean {
    return this._state.showing;
  }

  /**
   * Get filtered mentions based on current query
   */
  getFilteredMentions(): CellHandle<Mentionable>[] {
    const handle = this._mentionableTyped ?? this._mentionable;
    if (!handle) {
      return [];
    }

    // A list the worker refuses offers no mentions.
    const mentionableArray = valueForDisplay(handle);
    if (!Array.isArray(mentionableArray) || mentionableArray.length === 0) {
      return [];
    }

    const query = this._state.query.toLowerCase();

    const filtered: CellHandle<Mentionable>[] = [];
    for (let i = 0; i < mentionableArray.length; i++) {
      // Use .key(i) to get Cell reference, preserving cell-ness
      const mentionCell = handle.key(i);

      // Only call .get() to read the name for filtering
      const name = mentionCell.get()?.[NAME];

      if (!query || name?.toLowerCase().includes(query)) {
        filtered.push(mentionCell);
      }
    }

    return filtered;
  }

  /**
   * Handle input event to detect @ trigger and update query
   */
  handleInput(_event: Event): void {
    const content = this.config.getContent();
    const cursorPos = this.config.getCursorPosition();
    const textBeforeCursor = content.substring(0, cursorPos);
    const lastTriggerIndex = textBeforeCursor.lastIndexOf(this.config.trigger);

    if (
      lastTriggerIndex !== -1 &&
      lastTriggerIndex === textBeforeCursor.length - 1
    ) {
      // Just typed trigger - cursor is right after it
      this._state.showing = true;
      this._state.query = "";
      this._state.selectedIndex = 0;
      this.host.requestUpdate();
    } else if (lastTriggerIndex !== -1) {
      // There's a trigger before cursor
      const query = textBeforeCursor.substring(lastTriggerIndex + 1);
      if (!query.includes(" ")) {
        // Valid query - show mentions with query
        this._state.showing = true;
        this._state.query = query;
        this._state.selectedIndex = 0;
        this.host.requestUpdate();
      } else {
        // Space in query - hide mentions
        this.hide();
      }
    } else {
      // No trigger before cursor - hide mentions if showing
      if (this._state.showing) {
        this.hide();
      }
    }
  }

  /**
   * Handle keyboard events for mention navigation
   * Returns true if the event was handled, false otherwise
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this._state.showing) {
      return false;
    }

    const filteredMentions = this.getFilteredMentions();

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this._state.selectedIndex = Math.min(
          this._state.selectedIndex + 1,
          filteredMentions.length - 1,
        );
        this.host.requestUpdate();
        return true;

      case "ArrowUp":
        event.preventDefault();
        this._state.selectedIndex = Math.max(this._state.selectedIndex - 1, 0);
        this.host.requestUpdate();
        return true;

      case "Enter":
        // A selected row owns this keypress while its destination resolves.
        // Failure leaves the selection and popup intact for another attempt.
        if (filteredMentions[this._state.selectedIndex]) {
          event.preventDefault();
          this.insertMention(filteredMentions[this._state.selectedIndex]);
          return true;
        }
        // Let caller handle Enter when there are no matches.
        return false;

      case "Escape":
        event.preventDefault();
        this.hide();
        return true;

      default:
        return false;
    }
  }

  /**
   * Inserts a mention at the current cursor position.
   * Resolves the sub-cell to the real piece entity ID at insertion time.
   * An index row whose piece cannot resolve inserts nothing and remains
   * selected in the open popup.
   */
  async insertMention(mention: CellHandle<Mentionable>): Promise<void> {
    const markdown = await this.encodePieceAsMarkdown(mention);
    if (markdown === null) return;
    this.config.onInsert(markdown, mention);
    this.hide();
  }

  /**
   * Manually select a mention by index
   */
  selectMention(index: number): void {
    this._state.selectedIndex = index;
    this.host.requestUpdate();
  }

  /**
   * Hide the mentions dropdown
   */
  hide(): void {
    this._state.showing = false;
    this._state.query = "";
    this._state.selectedIndex = 0;
    this.host.requestUpdate();
  }

  /**
   * The entry's destination: a row's `piece` when it carries one, the
   * entry itself otherwise. An entry with `piece` is a derived index row
   * standing for the piece — encoding the entry would make every mention
   * name a row of somebody's bookkeeping. The row is detected by the KEY's
   * presence and its piece reached by ADDRESS: an `asCell` value crosses
   * the client boundary as an empty object, so the value itself can carry
   * no handle. Bound to the mentionable schema so field reads on the
   * destination materialize.
   */
  private _destinationOf(
    mention: CellHandle<Mentionable>,
  ): CellHandle<Mentionable> {
    return this._isIndexRow(mention)
      ? mention.key("piece").asSchema<Mentionable>(MentionableSchema)
      : mention;
  }

  /** Whether an entry is an index row standing for its `.piece`. */
  private _isIndexRow(mention: CellHandle<Mentionable>): boolean {
    const value = mention.get();
    return value != null && Object.hasOwn(value, "piece");
  }

  /**
   * Encodes a piece as markdown link `[name](/of:entityId)`.
   * Resolves the entry's destination to the real piece entity ID so
   * downstream consumers (LLM tools, read operations) can access the full
   * schema. The display name is the entry's own — for an index row, the
   * label it lists. Returns `null` when an index row's piece cannot resolve;
   * a direct entry can still fall back to its own raw reference.
   */
  private async encodePieceAsMarkdown(
    piece: CellHandle<Mentionable>,
  ): Promise<string | null> {
    const name = piece.get()?.[NAME] || "Unknown";
    try {
      const destination = this._destinationOf(piece);
      const resolved = await destination.resolveAsCell();
      return `[${name}](/${resolved.ref().id})`;
    } catch {
      // A direct entry is already the destination, so its raw ref remains a
      // usable fallback. An index row is only bookkeeping; without its piece
      // identity there is no valid mention to insert.
      if (this._isIndexRow(piece)) return null;
      return `[${name}](${this._buildHref(piece.ref())})`;
    }
  }

  /**
   * Decode piece reference from href (entity ID).
   * Matches against both the raw sub-cell ref path and the resolved piece ID,
   * since encodePieceAsMarkdown resolves to the stable entity ID.
   */
  async decodePieceFromHref(
    href: string | null,
  ): Promise<CellHandle<Mentionable> | null> {
    if (!href) return null;

    const all = this.readMentionables();

    // First pass: try matching the raw sub-cell ref path
    for (const mention of all) {
      if (href === this._buildHref(mention.ref())) {
        return mention;
      }
    }

    // Second pass: resolve each entry's destination and match against the
    // stable entity ID — the id the encode above persists, which for an
    // index row is the piece's and never the row's.
    for (const mention of all) {
      try {
        const resolved = await this._destinationOf(mention).resolveAsCell();
        if (href === `/${resolved.ref().id}`) {
          return mention;
        }
      } catch {
        // Skip unresolvable mentions
      }
    }

    return null;
  }

  /**
   * Extract all mentions from markdown text.
   * Returns array of CellHandle<Mentionable> objects referenced in the text.
   */
  async extractMentionsFromText(
    text: string,
  ): Promise<CellHandle<Mentionable>[]> {
    const mentions: CellHandle<Mentionable>[] = [];
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;

    while ((match = linkRegex.exec(text)) !== null) {
      const href = match[2];
      const mention = await this.decodePieceFromHref(href);
      if (mention) {
        mentions.push(mention);
      }
    }

    return mentions;
  }

  /** Build an href string from a CellRef in /of:id/path format. */
  private _buildHref(ref: { id: string; path?: readonly string[] }): string {
    let href = `/${ref.id}`;
    if (ref.path?.length) {
      // Encode path segments per RFC 6901 (JSON Pointer)
      for (const segment of ref.path) {
        href += `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      }
    }
    return href;
  }

  private readMentionables(): CellHandle<Mentionable>[] {
    const handle = this._mentionableTyped ?? this._mentionable;
    if (!handle) {
      return [];
    }

    // A list the worker refuses offers no mentions.
    const mentionableArray = valueForDisplay(handle);
    if (!Array.isArray(mentionableArray) || mentionableArray.length === 0) {
      return [];
    }

    // Use .key(i) to preserve cell-ness of items
    const mentions: CellHandle<Mentionable>[] = [];
    for (let i = 0; i < mentionableArray.length; i++) {
      const mentionCell = handle.key(i);
      if (mentionCell) {
        mentions.push(mentionCell);
      }
    }

    return mentions;
  }

  /**
   * Set up Cell subscription for mentionable array.
   * When the Cell's value changes, we need to re-render to show updated mentions.
   * @private
   */
  private _setupMentionableSubscription(): void {
    // Clean up any existing subscription first to prevent orphaned subscriptions
    // (e.g., if setMentionable() was called before hostConnected())
    this._cleanupMentionableSubscription();

    if (isCellHandle(this._mentionable)) {
      // Use asSchema() so the runtime resolves @link indirection before
      // delivering values — without this, cells from wish results / computed
      // cells deliver @link values hydrated as nested CellHandles.
      this._mentionableTyped = this._mentionable.asSchema<MentionableArray>(
        MentionableArraySchema,
      );
      const update = () => this.host.requestUpdate();
      this._mentionableUnsubscribe = this._mentionableTyped.subscribe(
        update,
        { onRefused: update },
      );
    }
  }

  /**
   * Clean up Cell subscription for mentionable array.
   * @private
   */
  private _cleanupMentionableSubscription(): void {
    if (this._mentionableUnsubscribe) {
      this._mentionableUnsubscribe();
      this._mentionableUnsubscribe = null;
    }
    this._mentionableTyped = null;
  }
}
