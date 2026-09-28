import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  Completion,
  CompletionContext,
  completionKeymap,
  CompletionResult,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { css as createCss } from "@codemirror/lang-css";
import { html as createHtml } from "@codemirror/lang-html";
import { javascript as createJavaScript } from "@codemirror/lang-javascript";
import { json as createJson } from "@codemirror/lang-json";
import { markdown as createMarkdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  Extension,
  Prec,
  Transaction,
} from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { type DID, isDID } from "@commonfabric/identity/did";
import { parseFabricUrl } from "@commonfabric/runner/fabric-url";
import { stringSchema } from "@commonfabric/runner/schemas";
import {
  type CellHandle,
  cellRefToIdentityKey,
  isCellHandle,
  NAME,
  type PresenceEvent,
  type PresenceRecord,
  type PresenceRoomHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { GFM } from "@lezer/markdown";
import { consume } from "@lit/context";
import { html, PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import { type InputTimingOptions } from "../../core/input-timing-controller.ts";
import {
  dedupeByDestination,
  labelForToken,
  type MentionRef,
  type MentionRefMap,
  MentionRefMapSchema,
  mintRefKey,
} from "../../core/mention-refs.ts";
import {
  Mentionable,
  MentionableArray,
  MentionableArraySchema,
  MentionableSchema,
} from "../../core/mentionable.ts";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";
import { type StoredFile, uploadFile } from "../../utils/file-cell-storage.ts";
import { mentionIdFromCellId } from "../../utils/mention-id.ts";
import {
  atomicBacklinkRanges,
  backlinkEditFilter,
  backlinkField,
  createBacklinkDecorationPlugin,
} from "./features/backlinks.ts";
import {
  atomicMentionRefRanges,
  createMentionRefDecorationPlugin,
  findRefToken,
  mentionRefEditFilter,
  mentionRefField,
  type MentionRefInfo,
  mentionRefs,
  refShortNameField,
  refShortNames,
  scanRefKeys,
  setKnownRefKeys,
  setRefShortNames,
  shortNameQueryAt,
} from "./features/mention-refs.ts";
import { createProseMarkdownPlugin } from "./features/prose-markdown.ts";
import { styles } from "./styles.ts";
import {
  CodeMirrorCollaborationController,
  CodeMirrorReconciliationError,
  codeMirrorRewriteDedupeEffect,
  type CodeMirrorSynchronizationSnapshot,
} from "./codemirror-collaboration.ts";
import {
  codeMirrorPresence,
  codeMirrorPresenceClearEffect,
  codeMirrorPresenceCursorEffect,
  codeMirrorPresenceRemoveEffect,
  codeMirrorPresenceUpsertEffect,
  mapSelectionToConfirmed,
  presenceSelectionToJSON,
} from "./codemirror-presence.ts";
import {
  CARET_FACET,
  caretFacetOf,
  participantFromRecord,
  type PresenceFailureCategory,
  presenceFailureCategory,
} from "./presence-facets.ts";

/** A unique noteId, so notes created from a mention do not collide. */
function generateNoteId(): string {
  return `${Date.now().toString(36)}-${
    Math.random().toString(36).slice(2, 11)
  }`;
}

/**
 * The name a universe row's own collection calls the member by, or the empty
 * string. A row without one is a row no `#42` query can match, which is every
 * row of a universe whose collection names nothing.
 */
function shortNameOf(entry: Mentionable | undefined): string {
  const name = entry?.shortName;
  return typeof name === "string" ? name : "";
}

/**
 * Whether a universe row's own collection name begins with `query`.
 *
 * Prefix rather than substring: a member name is a number, and `4` offering
 * `42` beside `14` and `24` buries the one that is being typed. Case-folded
 * to match the display-name query beside it, which costs nothing on a
 * numbered collection and keeps the two from disagreeing on a named one.
 */
function shortNameMatches(
  entry: Mentionable | undefined,
  query: string,
): boolean {
  const name = shortNameOf(entry);
  return name !== "" && name.toLowerCase().startsWith(query.toLowerCase());
}

/** Whether two short-name records hold the same names under the same keys. */
function sameShortNames(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key]);
}

function escapeMarkdownImageAltText(text: string): string {
  return text.replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\r?\n/g, " ");
}

/**
 * Supported MIME types for syntax highlighting
 */
export const MimeType = Object.freeze(
  {
    css: "text/css",
    html: "text/html",
    javascript: "text/javascript",
    jsx: "text/x.jsx",
    typescript: "text/x.typescript",
    json: "application/json",
    markdown: "text/markdown",
  } as const,
);

export type MimeType = (typeof MimeType)[keyof typeof MimeType];

// Language registry
const langRegistry = new Map<MimeType, LanguageSupport>();
const markdownLang = createMarkdown({
  defaultCodeLanguage: createJavaScript({ jsx: true }),
  extensions: GFM,
});
const defaultLang = markdownLang;

langRegistry.set(MimeType.javascript, createJavaScript());
langRegistry.set(MimeType.jsx, createJavaScript({ jsx: true }));
langRegistry.set(
  MimeType.typescript,
  createJavaScript({ jsx: true, typescript: true }),
);
langRegistry.set(MimeType.css, createCss());
langRegistry.set(MimeType.html, createHtml());
langRegistry.set(MimeType.markdown, markdownLang);
langRegistry.set(MimeType.json, createJson());

const getLangExtFromMimeType = (mime: MimeType) => {
  return langRegistry.get(mime) ?? defaultLang;
};

/**
 * CFCodeEditor - Code editor component with syntax highlighting and debounced changes
 *
 * @element cf-code-editor
 *
 * @attr {string|CellHandle<string>} value - Editor content (supports both plain string and CellHandle<string>)
 * @attr {string} language - MIME type for syntax highlighting
 * @attr {boolean} disabled - Whether the editor is disabled
 * @attr {boolean} readonly - Whether the editor is read-only
 * @attr {string} placeholder - Placeholder text when empty
 * @attr {boolean} autofocus - Auto-focus the editor after initialization (default: false)
 * @attr {"start"|"end"} cursorPosition - Initial cursor position (default: "start")
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 500)
 * @attr {CellHandle<MentionableArray>} mentionable - Cell of mentionable items for @/@[[ completion
 * @attr {Array} mentioned - Optional Cell of live Pieces mentioned in content
 * @attr {Array<string>} fabricHosts - Extra hosts whose page URLs name pieces
 * @attr {CellHandle<MentionRefMap>} references - Optional Cell of the document's
 *   mention references. Given one, a new mention is written as `[Label][key]`
 *   and its destination lives in the map; without one, mentions stay
 *   `[[Name (id)]]` wiki-links.
 * @attr {boolean} wordWrap - Enable soft line wrapping (default: true)
 * @attr {boolean} lineNumbers - Show line numbers gutter (default: false)
 * @attr {number|string} maxLineWidth - Optional max line width. Numbers are
 *   treated as ch units (e.g. 80 → "80ch"), strings are used as-is
 *   (e.g. "700px", "50rem"). Default: undefined
 * @attr {number} tabSize - Tab size (spaces shown for a tab, default: 2)
 * @attr {boolean} tabIndent - Indent on Tab key (default: true)
 * @attr {"light"|"dark"} theme - Editor theme mode; "dark" enables oneDark.
 * @attr {"code"|"prose"} mode - Editor mode; "prose" enables markdown prose editing.
 * @attr {CellHandle<string>} pattern - Optional pattern piece used for backlink context.
 * @attr {boolean} collaborative - Use Memory's operation protocol for concurrent editing.
 * @attr {string} presenceRoom - Optional opaque room override for ephemeral
 *   co-presence. Without one the runtime derives the room from the bound
 *   text Cell's resolved field.
 * @attr {string} participantName - Plain-text display name which enables
 *   co-presence. The editor joins the room of the field it is bound to, where
 *   everyone editing that field meets, one entry per browser tab, and
 *   publishes its caret there with `focused` reporting whether it owns focus.
 *   Presence travels over the runtime's memory connection; no endpoint is
 *   configured.
 *
 * @fires cf-change - Fired when content changes with detail: { value, oldValue, language }
 * @fires cf-focus - Fired on focus
 * @fires cf-blur - Fired on blur
 * @fires cf-collaboration-reconcile - Fired when an epoch changes while local
 *   edits are pending. Detail preserves localValue, canonicalValue, and cursors.
 * @fires cf-presence-error - Fired when ephemeral presence fails independently
 *   of document collaboration. Detail contains a safe failure category.
 * @fires backlink-click - Fired when a backlink is clicked with Cmd/Ctrl+Enter with detail: { text, piece }
 * @fires backlink-create - Fired when a novel backlink is activated (Cmd/Ctrl+Click)
 *   or confirmed with Enter during autocomplete with no matches. Detail:
 *   { text: string, pieceId: any, piece: Cell<MentionablePiece>, navigate: boolean }
 * @fires mention-ref-label-changed - Fired when a mention's label is edited in
 *   reference mode, with detail: { key, label, modifiedTitle, destination }
 *
 * @example
 * <cf-code-editor language="text/javascript" placeholder="Enter code..."></cf-code-editor>
 */
export class CFCodeEditor extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];

  static override properties = {
    value: { type: String },
    language: { type: String },
    disabled: { type: Boolean },
    readonly: { type: Boolean },
    placeholder: { type: String },
    timingStrategy: { type: String },
    timingDelay: { type: Number },
    mentionable: { type: Object },
    mentioned: { type: Array },
    references: { type: Object },
    fabricHosts: { type: Array },
    pattern: { type: Object },
    // New editor configuration props
    wordWrap: { type: Boolean },
    lineNumbers: { type: Boolean },
    maxLineWidth: {
      converter: {
        fromAttribute(value: string | null) {
          if (value === null) return undefined;
          const num = Number(value);
          return Number.isNaN(num) ? value : num;
        },
        toAttribute(value: number | string | undefined) {
          return value?.toString() ?? null;
        },
      },
    },
    tabSize: { type: Number },
    tabIndent: { type: Boolean },
    theme: { type: String, reflect: true },
    mode: { type: String, reflect: true },
    autofocus: { type: Boolean },
    cursorPosition: { type: String },
    collaborative: { type: Boolean },
    presenceRoom: { type: String },
    participantName: { type: String },
  };

  declare value: CellHandle<string> | string;
  declare language: MimeType;
  declare disabled: boolean;
  declare readonly: boolean;
  declare placeholder: string;
  declare timingStrategy: InputTimingOptions["strategy"];
  declare timingDelay: number;

  /**
   * Mentionable items for @ completion.
   */
  declare mentionable?: CellHandle<MentionableArray> | null;

  declare mentioned?: CellHandle<MentionableArray>;

  /**
   * The document's mention references. Its presence selects the reference
   * form for newly minted mentions; wiki-links already in the document keep
   * working either way.
   */
  declare references?: CellHandle<MentionRefMap> | null;

  /**
   * Hosts, besides this document's own, whose page URLs name pieces. A pasted
   * URL from anywhere else is a link to a web page.
   */
  declare fabricHosts: string[];

  declare pattern: CellHandle<string>;
  declare wordWrap: boolean;
  declare lineNumbers: boolean;
  declare maxLineWidth?: number | string;
  declare tabSize: number;
  declare tabIndent: boolean;
  declare theme: "light" | "dark";
  declare mode: "code" | "prose";
  declare autofocus: boolean;
  declare cursorPosition: "start" | "end";
  declare collaborative: boolean;
  declare presenceRoom: string;
  declare participantName: string;

  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  accessor contextSpace: DID | undefined = undefined;

  private _editorView: EditorView | undefined;
  private _lang = new Compartment();
  private _readonly = new Compartment();
  private _wrap = new Compartment();
  private _gutters = new Compartment();
  private _tabSizeComp = new Compartment();
  private _tabIndentComp = new Compartment();
  private _maxLineWidthComp = new Compartment();
  private _indentUnitComp = new Compartment();
  private _themeComp = new Compartment();
  private _setupComp = new Compartment();
  private _modeComp = new Compartment();
  private _proseMarkdownComp = new Compartment();
  private _collaborationComp = new Compartment();
  private _presenceComp = new Compartment();
  private _collaboration: CodeMirrorCollaborationController | undefined;
  private _collaborationSyncUnsub: (() => void) | undefined;
  private _presence: PresenceRoomHandle | undefined;
  private _presenceUnsubscribe: (() => void) | undefined;
  private _presenceJoining = false;
  private _presenceGeneration = 0;
  private _presenceParticipantId: string | undefined;
  private _presenceHasSelection = false;
  private _presenceEpoch: number | undefined;
  private _presenceRoom: string | undefined;
  private _presenceFailure:
    | {
      category: PresenceFailureCategory;
      configurationKey: string;
    }
    | undefined;
  private _collaborationTransition: Promise<void> | undefined;
  private _collaborationGeneration = 0;
  private _collaborationFailed = false;
  private _cleanupFns: Array<() => void> = [];
  private _mentionableUnsub: (() => void) | null = null;
  private _mentionedUnsub: (() => void) | null = null;
  private _autofocusPending = false;
  private _autofocusFrame: number | null = null;
  private _autofocusIntersectionObserver: IntersectionObserver | null = null;
  private _autofocusResizeObserver: ResizeObserver | null = null;

  /**
   * Previous backlink names, kept to detect changes for syncing to the piece
   * `NAME`.
   */
  private _previousBacklinkNames = new Map<string, string>();

  /** Subscriptions to piece `NAME` cells, for bidirectional sync. */
  private _pieceNameSubscriptions = new Map<string, () => void>();

  /**
   * Cache of resolved piece cell ids: index in the mentionable array → stable
   * piece cell id. Populated asynchronously when the mentionable changes, via
   * `resolveAsCell()`.
   */
  private _resolvedPieceIds = new Map<number, string>();

  /**
   * The resolved cell behind each mentionable entry, which a reference stores
   * directly rather than by id. Populated by the same pass.
   */
  private _resolvedPieceCells = new Map<number, CellHandle<Mentionable>>();

  /**
   * Which resolution pass may publish its maps. The mentionable _handle_ stays
   * identical when its contents change, so identity alone cannot stop an older
   * pass finishing late and overwriting a newer pass's ordering.
   */
  private _resolveGeneration = 0;

  /**
   * Whether `$mentioned` reconciliation is deferred. It cannot be reconciled
   * while an index row has no piece id; calls made during that window leave
   * the latest content for the current resolution pass to reconcile when it
   * publishes.
   */
  private _mentionResolutionPending = false;

  private _deferredMentionedContent: string | null = null;

  /**
   * Whether a completion source withheld a matching index row and asks the
   * current resolution pass to query it again once the row has a usable
   * identity.
   */
  private _completionAwaitingResolution = false;

  private _referencesUnsub: (() => void) | null = null;

  /** Label text last seen for each reference key, to detect a user's edit. */
  private _previousRefLabels = new Map<string, string>();

  /**
   * Subscriptions to each referenced destination, carrying the identity they
   * were opened against so a key repointed at a different piece resubscribes
   * rather than keeping the old one alive.
   */
  private _refDestinationSubscriptions = new Map<
    string,
    { id: string; unsub: () => void }
  >();

  /**
   * Each referenced destination's name, as its subscription last delivered it.
   */
  private _refNames = new Map<string, string>();

  /** Whether a publication of the mentions' short names is waiting to run. */
  private _refShortNamesPublishPending = false;

  /**
   * Keys the document held when it loaded, plus those this editor minted.
   * Collection only removes entries from this set, so a key another client
   * added while this one was open is never swept away. `null` until the
   * document has loaded, which is what keeps an empty editor from collecting
   * the whole map.
   */
  private _refKeysAtLoad: Set<string> | null = null;

  /**
   * Signature of the last `$mentioned` write in reference mode; `null` forces
   * the next attempt, which is how an unresolved key gets retried.
   */
  private _lastMentionedSignature: string | null = null;

  /**
   * Transaction annotation marking cell-originated updates. This is the
   * idiomatic CodeMirror 6 way to distinguish programmatic changes from user
   * input. The update listener checks this annotation and skips `setValue()`
   * for cell-originated changes, preventing the feedback loop: cell → editor
   * → update listener → `setValue()` → cell...
   */
  private static _cellSyncAnnotation = Annotation.define<boolean>();

  private _cellController = createStringCellController(this, {
    timing: {
      strategy: "debounce",
      delay: 500,
    },
    onChange: (newValue: string, oldValue: string) => {
      this.emit("cf-change", {
        value: newValue,
        oldValue,
        language: this.language,
      });
      // Keep $mentioned in sync with content changes
      this._updateMentionedFromContent();
    },
  });

  constructor() {
    super();
    this.value = "";
    this.language = MimeType.markdown;
    this.disabled = false;
    this.readonly = false;
    this.placeholder = "";
    this.timingStrategy = "debounce";
    this.timingDelay = 500;
    // Defaults for new props
    this.wordWrap = true;
    this.lineNumbers = false;
    this.maxLineWidth = undefined;
    this.tabSize = 2;
    this.tabIndent = true;
    this.theme = "light";
    this.mode = "code";
    this.autofocus = false;
    this.cursorPosition = "start";
    this.collaborative = false;
    this.presenceRoom = "";
    this.participantName = "";
    this.mentionable = null;
    this.references = null;
    this.fabricHosts = [];
  }

  /** Whether a reference map is available to mint mentions into. */
  private get _refMode(): boolean {
    return !!this.references;
  }

  /** The reference map's current contents. */
  private _refMap(): MentionRefMap {
    return (this.references?.get() ?? {}) as MentionRefMap;
  }

  /**
   * Create a backlink completion source for [[backlinks]]
   * The dropdown stays open as long as cursor is inside [[...
   */
  private createBacklinkCompletionSource() {
    return (context: CompletionContext): CompletionResult | null => {
      this._completionAwaitingResolution = false;
      // Look for incomplete backlinks: [[ followed by optional text (not yet closed)
      const backlink = context.matchBefore(/\[\[([^\]]*)?/);

      if (!backlink) {
        return null;
      }

      // Check if this is already a complete backlink WITH an ID (not just auto-closed brackets)
      // Pattern: [[Name (id)]] - if there's an ID, don't show dropdown
      const afterCursor = context.state.doc.sliceString(
        context.pos,
        context.pos + 50, // Look ahead for potential ]] and ID pattern
      );
      const hasIdPattern = afterCursor.match(/^\s*\([^)]+\)\]\]/);
      if (hasIdPattern) {
        // This is a complete backlink with ID - don't show dropdown
        return null;
      }

      const query = backlink.text.slice(2); // Remove [[ prefix

      const mentionable = this.getFilteredMentionable(query);
      this._completionAwaitingResolution = this
        ._hasUnresolvedIndexRowFor(query);

      // Check if auto-close added ]] after cursor
      const hasAutoCloseBrackets = afterCursor.startsWith("]]");

      // Build options from existing mentionable items
      const options: Completion[] = mentionable.map(([piece, index]) => {
        const pieceId = this._getPieceId(index);
        const pieceName = piece.key(NAME).get() || "";
        // Identity now, for the reason the short-name source takes one: the
        // index is a position, and the list it indexes may recompute before
        // this option is picked.
        const destination = this._resolvedPieceCells.get(index);
        const insertText = `${labelForToken(pieceName)} (${pieceId})`;
        return {
          label: pieceName,
          // Use apply function to handle auto-closed brackets
          apply: (view, _completion, from, to) => {
            // If auto-close added ]], extend replacement to include them
            const replaceTo = hasAutoCloseBrackets ? to + 2 : to;
            // `from` sits after the `[[` that opened the query, and the
            // reference form replaces those two characters too. Read rather
            // than assumed: were they anything else, extending the replacement
            // backwards would eat two characters of the user's prose, and do
            // it silently.
            const opensQuery = view.state.doc.sliceString(from - 2, from) ===
              "[[";
            if (this._refMode && opensQuery && destination) {
              const key = this._writeRefEntry(
                destination as CellHandle<unknown>,
              );
              if (key) {
                this._insertRefToken(view, from - 2, replaceTo, pieceName, key);
                return;
              }
            }
            view.dispatch({
              changes: { from, to: replaceTo, insert: insertText + "]]" },
              selection: { anchor: from + insertText.length + 2 },
            });
          },
          type: "text",
          info: "Link to " + pieceName,
        };
      });

      // Only show existing pieces - no "Create" option
      // Enter will complete with exact match or create new piece
      return {
        from: backlink.from + 2, // Start after [[ (original behavior)
        options,
      };
    };
  }

  /**
   * Create the completion source for a `#42` citation.
   *
   * The query is the digits after the sigil, matched against each universe
   * row's own `shortName` — its collection's copy of what it calls the member
   * — so offering the list reads no member. A row carrying no short name
   * matches nothing, which is every row of a universe whose collection names
   * nothing.
   *
   * A sigil inside a mention gesture the document already carries opens no
   * query at all; `_shortNameQueryIsClear()` says which those are.
   */
  private createShortNameCompletionSource() {
    return (context: CompletionContext): CompletionResult | null => {
      const line = context.state.doc.lineAt(context.pos);
      const typed = context.state.doc.sliceString(line.from, context.pos);
      const query = shortNameQueryAt(typed);
      if (!query) return null;

      const from = line.from + query.from;
      if (!this._shortNameQueryIsClear(context.state, from)) return null;

      // A row withheld for want of a resolved piece is one this query would
      // have offered, so the resolution pass owes it a second look.
      this._completionAwaitingResolution = this._hasUnresolvedIndexRowFor(
        query.query,
      );

      const options: Completion[] = this._matchingShortNames(query.query).map(
        ([row, index, name]) => {
          const rowName = row.key(NAME).get() || "";
          // The row's IDENTITY, taken now. An index is a position in a list
          // that recomputes, so a universe reordered or shortened between the
          // dropdown opening and a pick would make the same index name a
          // different member — or none.
          const destination = this._resolvedPieceCells.get(index);
          const pieceId = this._getPieceId(index);
          return {
            // The sigil is part of the label so that CodeMirror's own
            // filtering measures what was typed against what is offered.
            label: `#${name}`,
            detail: rowName,
            // The range comes from the CALLBACK, not from the closure: a
            // transaction between offering this option and applying it maps
            // the query's position, and the captured `from` would then
            // replace text the query no longer covers.
            apply: (
              view: EditorView,
              _completion: Completion,
              applyFrom: number,
              applyTo: number,
            ) => {
              this._insertMentionOf(
                view,
                applyFrom,
                applyTo,
                rowName,
                destination,
                pieceId,
              );
            },
            type: "text",
            info: `Link to ${rowName}`,
          };
        },
      );

      return { from, options };
    };
  }

  /**
   * Whether a `#` at `from` opens a citation, rather than sitting inside a
   * mention gesture that owns the text around it.
   *
   * Two overlaps, and neither is caught by the sigil's own shape. A `#`
   * anywhere inside an unclosed `[[` belongs to the backlink query, which owns
   * that gesture: its source reads back over the two brackets and extends
   * across an auto-closed `]]`, and inserting from here does neither, so
   * `[[|]]` would complete to `[[[Label][key]]]`. The whole query is the
   * gesture, not the two characters at its head — `[[note #4` is still inside
   * it. A `#` inside an existing mention's label — the label is ordinary
   * editable text — would nest a token inside a token. Neither corrupts the
   * reference map; both leave junk on screen for the user to unpick.
   */
  private _shortNameQueryIsClear(state: EditorState, from: number): boolean {
    const line = state.doc.lineAt(from);
    // The same shape `_currentBacklinkQuery` reads: `[[` with no `]` since.
    if (/\[\[[^\]]*$/.test(state.doc.sliceString(line.from, from))) {
      return false;
    }
    return !mentionRefs(state).some((ref) => from > ref.from && from < ref.to);
  }

  /**
   * The universe rows whose own short name begins with `query`, each with the
   * index that addresses it and the name that matched.
   */
  private _matchingShortNames(
    query: string,
  ): Array<[CellHandle<Mentionable>, number, string]> {
    const handle = this.mentionable;
    if (!handle) return [];

    const rows = (handle.get() ?? []) as MentionableArray;
    const matches: Array<[CellHandle<Mentionable>, number, string]> = [];

    for (let i = 0; i < rows.length; i++) {
      // The same withholding rule the backlink surfaces use: an index row
      // whose piece has not resolved has no identity a mention could store.
      if (this._isIndexRow(i) && !this._resolvedPieceIds.has(i)) continue;
      if (!shortNameMatches(rows[i], query)) continue;
      matches.push([
        handle.key(i) as CellHandle<Mentionable>,
        i,
        shortNameOf(rows[i]),
      ]);
    }

    return matches;
  }

  /**
   * Replace the range `from`–`to` with a mention of the universe row at
   * `index`.
   *
   * The reference form where the document has a map to mint into, and the
   * wiki-link form where it does not — the same choice the backlink
   * completion makes at its own insertion point.
   */
  private _insertMentionOf(
    view: EditorView,
    from: number,
    to: number,
    label: string,
    destination: CellHandle<Mentionable> | undefined,
    pieceId: string,
  ): void {
    if (this._refMode && destination) {
      const key = this._writeRefEntry(destination as CellHandle<unknown>);
      if (key) {
        this._insertRefToken(view, from, to, label, key);
        return;
      }
    }

    // Through the same sanitizer the reference form uses: a name holding a
    // `]` or a newline would otherwise mint a token no parse reads back.
    const insert = `[[${labelForToken(label)} (${pieceId})]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
  }

  /**
   * Get filtered mentionable items based on query.
   * Returns tuples of [CellHandle, originalIndex] so callers can look up
   * the stable resolved piece ID via _getPieceId(index).
   */
  private getFilteredMentionable(
    query: string,
  ): Array<[CellHandle<Mentionable>, number]> {
    const handle = this.mentionable;
    if (!handle) {
      return [];
    }

    const mentionableData = (handle.get() ?? []) as MentionableArray;

    if (mentionableData.length === 0) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const matches: Array<[CellHandle<Mentionable>, number]> = [];

    for (let i = 0; i < mentionableData.length; i++) {
      const mention = mentionableData[i];
      // An index row is withheld until its piece resolves: a completion
      // taken from it before then could only persist an id naming the row.
      // Resolution starts when the list binds, so the window is the round
      // trips of `_resolvePieceIds`, not something a user waits on.
      if (this._isIndexRow(i) && !this._resolvedPieceIds.has(i)) continue;
      // A member's own number is offered here too, so someone who knows a
      // board's name for a member reaches it without switching sigils. What
      // Enter completes is unchanged: an exact match is asked of the display
      // name alone, so a query of digits still creates rather than picking.
      if (
        mention &&
        (mention[NAME]
          ?.toLowerCase()
          ?.includes(queryLower) ||
          shortNameMatches(mention, query))
      ) {
        matches.push([handle.key(i) as CellHandle<Mentionable>, i]);
      }
    }

    return matches;
  }

  /**
   * Whether an unresolved index row contains or exactly matches `query`.
   *
   * The loose form asks the short name as well as the display name, because
   * both completion surfaces offer a row on either: a `#42` query, and a
   * `[[42` query since the backlink source began matching numbers too. Only
   * the display name settles an EXACT match, which is what decides whether
   * Enter completes or creates.
   */
  private _hasUnresolvedIndexRowFor(
    query: string,
    match: "contains" | "exact" = "contains",
  ): boolean {
    const mentionableData = (this.mentionable?.get() ?? []) as MentionableArray;
    const queryLower = query.toLowerCase();
    return mentionableData.some((mention, index) => {
      if (!this._isIndexRow(index) || this._resolvedPieceIds.has(index)) {
        return false;
      }
      const name = mention?.[NAME]?.toLowerCase();
      if (match === "exact") return name === queryLower;
      return !!name?.includes(queryLower) || shortNameMatches(mention, query);
    });
  }

  /**
   * Restarts a query that withheld a matching index row.
   *
   * One signal for both triggers: a row is withheld for want of a resolved
   * piece whichever sigil asked for it, and a completion that is not reopened
   * leaves the user typing at a list that will never fill.
   */
  private _refreshCompletion(): void {
    if (!this._completionAwaitingResolution) return;
    this._completionAwaitingResolution = false;

    const view = this._editorView;
    if (!view?.hasFocus) return;
    if (
      this._currentBacklinkQuery(view) !== null ||
      this._currentShortNameQuery(view) !== null
    ) {
      startCompletion(view);
    }
  }

  /** The `#42` query under the cursor, or null — the sigil's own reader. */
  private _currentShortNameQuery(view: EditorView): string | null {
    const state = view.state;
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const query = shortNameQueryAt(state.doc.sliceString(line.from, pos));
    if (!query) return null;
    return this._shortNameQueryIsClear(state, line.from + query.from)
      ? query.query
      : null;
  }

  /**
   * Find exact case-insensitive match in mentionable items.
   * Returns [CellHandle, originalIndex] or null.
   */
  private _findExactMentionable(
    query: string,
  ): [CellHandle<Mentionable>, number] | null {
    const handle = this.mentionable;
    if (!handle) return null;

    const mentionableData = (handle.get() ?? []) as MentionableArray;

    const queryLower = query.toLowerCase();

    for (let i = 0; i < mentionableData.length; i++) {
      // Same withholding rule as the filtered list: an unresolved index
      // row cannot be completed against, exactly or otherwise.
      if (this._isIndexRow(i) && !this._resolvedPieceIds.has(i)) continue;
      const mention = mentionableData[i];
      const name = mention?.[NAME] ?? "";
      if (name.toLowerCase() === queryLower) {
        return [handle.key(i), i];
      }
    }

    return null;
  }

  /** Completes an exact mention or creates when no exact row is present. */
  private _completeBacklinkQuery(view: EditorView, text: string): void {
    const exactMatch = this._findExactMentionable(text);
    if (exactMatch) {
      const [matchCell, matchIndex] = exactMatch;
      const pieceName = matchCell.key(NAME).get() || text;
      if (
        !this._refMode ||
        !this._completeMentionRef(view, pieceName, matchIndex)
      ) {
        const pieceId = this._getPieceId(matchIndex);
        this._completeBacklinkWithId(view, text, pieceName, pieceId);
      }
      return;
    }

    // An exact row without an identity is an existing piece, not permission
    // to create another one. Keep the query intact and reopen its completion
    // after this pass, starting a fresh pass if the previous one failed.
    if (this._hasUnresolvedIndexRowFor(text, "exact")) {
      this._completionAwaitingResolution = true;
      if (!this._mentionResolutionPending) void this._resolvePieceIds();
      return;
    }

    if (!this.pattern) return;
    if (this._refMode) {
      this._createMentionRefFromPattern(view, text);
    } else {
      this._completeBacklinkText(view);
      this.createBacklinkFromPattern(text, false);
    }
  }

  /**
   * Complete a backlink by inserting the full [[Name (id)]] format
   */
  private _completeBacklinkWithId(
    view: EditorView,
    _queryText: string,
    pieceName: string,
    pieceId: string,
  ): void {
    // Find the [[ start position
    const pos = view.state.selection.main.head;
    const doc = view.state.doc.toString();
    const beforeCursor = doc.slice(0, pos);
    const bracketPos = beforeCursor.lastIndexOf("[[");

    if (bracketPos === -1) return;

    // Check if there are auto-closed brackets after cursor
    const afterCursor = doc.slice(pos, pos + 2);
    const hasAutoClose = afterCursor === "]]";

    // Build the complete backlink
    const fullBacklink = `[[${labelForToken(pieceName)} (${pieceId})]]`;

    // Calculate replacement range
    const replaceFrom = bracketPos;
    const replaceTo = hasAutoClose ? pos + 2 : pos;

    view.dispatch({
      changes: { from: replaceFrom, to: replaceTo, insert: fullBacklink },
      selection: { anchor: replaceFrom + fullBacklink.length },
    });
  }

  /**
   * Complete a backlink as pending (just [[text]] without ID)
   */
  private _completeBacklinkText(view: EditorView): void {
    const pos = view.state.selection.main.head;
    const afterCursor = view.state.doc.sliceString(pos, pos + 2);

    if (afterCursor === "]]") {
      // Already has closing brackets - just move cursor past them
      view.dispatch({
        selection: { anchor: pos + 2 },
      });
    } else {
      // Insert ]] to complete the backlink
      view.dispatch({
        changes: { from: pos, to: pos, insert: "]]" },
        selection: { anchor: pos + 2 },
      });
    }
  }

  /**
   * The mentions the document currently holds, as parsed against the map.
   */
  private _documentRefs(): MentionRefInfo[] {
    return this._editorView ? mentionRefs(this._editorView.state) : [];
  }

  /**
   * Every key already spoken for: the map's own, plus any in the document that
   * the map has not caught up with (a pasted token, or one this editor minted
   * moments ago).
   */
  private _takenRefKeys(): Set<string> {
    const taken = new Set(Object.keys(this._refMap()));
    const doc = this._editorView?.state.doc.toString();
    if (doc) { for (const key of scanRefKeys(doc)) taken.add(key); }
    return taken;
  }

  /**
   * Record a destination in the reference map and return the key naming it.
   *
   * The entry is written before the token reaches the document. An entry no
   * token names is inert; a token no entry resolves is a dead link, so if only
   * one of the two writes lands it should be this one.
   */
  private _writeRefEntry(destination: CellHandle<unknown>): string | null {
    const map = this.references;
    if (!map) return null;

    const key = mintRefKey(this._takenRefKeys());
    map.key(key).set(
      { destination, modifiedTitle: false } as unknown as MentionRef,
    );
    // Ours to collect: a key this editor minted can be swept when its token
    // goes, without waiting for a reload to observe it.
    this._refKeysAtLoad?.add(key);
    return key;
  }

  /**
   * Record the mentionable item at `index` as a destination, or refuse.
   *
   * Only a RESOLVED cell will do. `mentionable.key(index)` addresses a
   * position in a list rather than a piece: the list recomputes, and a mention
   * persisted against that path would later name whatever had moved into the
   * slot. `_resolvePieceIds` follows the indirection; until it has, this
   * returns null and the caller mints a wiki-link instead — the older form,
   * but one whose id comes from the same resolution. An index row cannot
   * reach either fallback: the completion surfaces withhold it until it is
   * resolved, so a row arriving here always finds its piece in the cache.
   */
  private _createRefEntry(index: number): string | null {
    const destination = this._resolvedPieceCells.get(index);
    if (!destination) return null;
    return this._writeRefEntry(destination as CellHandle<unknown>);
  }

  /** Replace a range with a mention in reference form. */
  private _insertRefToken(
    view: EditorView,
    from: number,
    to: number,
    label: string,
    key: string,
  ): void {
    const safe = labelForToken(label);
    const token = `[${safe}][${key}]`;
    view.dispatch({
      changes: { from, to, insert: token },
      selection: { anchor: from + token.length },
    });
    this._previousRefLabels.set(key, safe);
  }

  /**
   * Complete a mention in reference form, replacing the `[[query` the user
   * typed (and any brackets auto-close added after it).
   */
  private _completeMentionRef(
    view: EditorView,
    label: string,
    index: number,
  ): boolean {
    const pos = view.state.selection.main.head;
    const doc = view.state.doc.toString();
    const bracketPos = doc.slice(0, pos).lastIndexOf("[[");
    if (bracketPos === -1) return false;

    const key = this._createRefEntry(index);
    if (!key) return false;

    const hasAutoClose = doc.slice(pos, pos + 2) === "]]";
    this._insertRefToken(
      view,
      bracketPos,
      hasAutoClose ? pos + 2 : pos,
      label,
      key,
    );
    return true;
  }

  /**
   * Create a piece for a mention that matched nothing, and reference it.
   *
   * The token goes in first, with a key the map does not hold yet, so it reads
   * as ordinary text for as long as the create takes. That window belongs to
   * the user: the token is unprotected, so it can be edited or deleted before
   * the create returns. Both ends therefore find the token by its KEY rather
   * than by the text that was inserted — an edited label still matches — and
   * treat its absence as the user having removed the mention.
   */
  private async _createMentionRefFromPattern(
    view: EditorView,
    label: string,
  ): Promise<void> {
    const pos = view.state.selection.main.head;
    const doc = view.state.doc.toString();
    const bracketPos = doc.slice(0, pos).lastIndexOf("[[");
    if (bracketPos === -1) return;

    const key = mintRefKey(this._takenRefKeys());
    const hasAutoClose = doc.slice(pos, pos + 2) === "]]";
    this._insertRefToken(
      view,
      bracketPos,
      hasAutoClose ? pos + 2 : pos,
      label,
      key,
    );

    const rt = this.pattern.runtime();
    try {
      const program = this.pattern.get();
      if (!program) throw new Error("Could not read pattern.");

      // Same input bag the wiki-link path builds, and typed the same way.
      const inputs: Record<string, unknown> = {
        title: label,
        content: "",
        noteId: generateNoteId(),
      };
      const piece = await rt.createPiece(
        JSON.parse(program),
        this.pattern.space(),
        inputs,
      );
      if (!piece) throw new Error("Could not create piece.");

      // The piece exists whether or not its token survived, so the host hears
      // about it either way and can register it.
      this.emit("backlink-create", {
        text: label,
        pieceId: piece.id(),
        piece: piece.cell(),
        navigate: false,
      });

      // Its token is gone, so an entry would name nothing. Skipping the write
      // is what keeps a mention the user abandoned from persisting as a map
      // entry no key in the document reaches.
      if (!this._findRefToken(key)) return;

      const destination = piece.cell() as unknown as CellHandle<unknown>;
      this.references?.key(key).set(
        { destination, modifiedTitle: false } as unknown as MentionRef,
      );
      this._refKeysAtLoad?.add(key);
    } catch (error) {
      // A disposal race (logout, runtime swap) cancels the create; that is
      // cancellation, not a failure to surface.
      if (rt.signal.aborted) return;
      console.error("Error creating mention reference:", error);
      this._removeRefToken(key);
    }
  }

  /**
   * Locate a reference token by its key, whatever its label now reads.
   *
   * The label is ordinary editable text, so the only durable handle on a token
   * is the key inside it. Finding it by the string that was inserted would
   * miss a token the user has since retyped.
   */
  private _findRefToken(
    key: string,
  ): { from: number; to: number; label: string } | null {
    const view = this._editorView;
    return view ? findRefToken(view.state.doc.toString(), key) : null;
  }

  /**
   * Unwind a reference token to its bare label, leaving the words the user
   * typed. A token the user has already removed leaves nothing to unwind.
   */
  private _removeRefToken(key: string): void {
    this._previousRefLabels.delete(key);

    const token = this._findRefToken(key);
    if (!token || !this._editorView) return;

    this._editorView.dispatch({
      changes: { from: token.from, to: token.to, insert: token.label },
    });
  }

  /**
   * Handle backlink clicks:
   * - Click on pill: navigate to linked piece
   * - Click when expanded (editing mode): places cursor normally
   */
  private createBacklinkClickHandler() {
    return EditorView.domEventHandlers({
      mousedown: (event, view) => {
        const target = event.target as HTMLElement;
        if (target.closest(".cm-mention-ref-pill")) {
          event.preventDefault();
          setTimeout(() => this.handleRefPillClick(view, event), 0);
          return true;
        }
        // Check if clicking on a collapsed pill (cm-backlink-pill)
        if (target.closest(".cm-backlink-pill")) {
          // Navigate to the backlink
          event.preventDefault();
          setTimeout(() => this.handlePillClick(view, event), 0);
          return true;
        }
        return false;
      },
    });
  }

  /**
   * Handle click on a collapsed backlink pill - navigate to the linked piece
   */
  private async handlePillClick(
    view: EditorView,
    event: MouseEvent,
  ): Promise<void> {
    // Get the position in the document from the click coordinates
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return;

    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    const lineText = line.text;

    // Find all backlinks on this line
    const backlinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = backlinkRegex.exec(lineText)) !== null) {
      const matchStart = line.from + match.index;
      const _matchEnd = matchStart + match[0].length;
      const innerText = match[1];

      // Check if has ID
      const idMatch = innerText.match(/^(.+?)\s+\(([^)]+)\)$/);
      if (!idMatch) continue; // Skip incomplete backlinks

      const name = idMatch[1];
      const id = idMatch[2];
      const nameStart = matchStart + 2; // After [[
      const nameEnd = nameStart + name.length;

      // Check if click position is within the name portion (the visible pill)
      if (pos >= nameStart && pos <= nameEnd) {
        const runtime = this.pattern.runtime();
        const space = this.pattern.space();

        const cell = await runtime.getCell(space, id);
        this.emit("backlink-click", {
          id,
          text: innerText,
          piece: cell,
        });
        return;
      }
    }
  }

  /**
   * The destination behind a reference key, shaped so its name can be read.
   *
   * `destination` is stored as a cell, and the client hydrates the link it
   * receives into a `CellHandle`. The `asSchema` is what makes reads of the
   * target's own fields materialize: under the map's schema the destination is
   * an opaque cell, and naming a field on it would come back undefined.
   */
  private _refDestination(key: string): CellHandle<Mentionable> | null {
    const destination = this._refMap()[key]?.destination;
    if (!isCellHandle(destination)) return null;
    return destination.asSchema<Mentionable>(MentionableSchema);
  }

  /**
   * Which piece a key currently names, as a string that changes when the
   * destination does. Empty when the map holds no destination for it.
   */
  private _refDestinationId(key: string): string {
    const destination = this._refMap()[key]?.destination;
    return isCellHandle(destination) ? destination.id() : "";
  }

  /**
   * Navigate to the destination of the reference pill under the pointer.
   */
  private handleRefPillClick(view: EditorView, event: MouseEvent): void {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return;

    for (const ref of this._documentRefs()) {
      if (pos < ref.labelFrom || pos > ref.labelTo) continue;

      const destination = this._refDestination(ref.key);
      if (!destination) return;

      this.emit("backlink-click", {
        id: ref.key,
        text: ref.label,
        piece: destination,
      });
      return;
    }
  }

  /**
   * Handle backlink activation (Cmd/Ctrl+Click on a backlink)
   */
  private handleBacklinkActivation(
    view: EditorView,
    _event?: MouseEvent,
  ): boolean {
    const state = view.state;
    const pos = state.selection.main.head;
    const doc = state.doc;

    // Find backlinks around cursor position
    const lineStart = doc.lineAt(pos).from;
    const lineEnd = doc.lineAt(pos).to;
    const lineText = doc.sliceString(lineStart, lineEnd);

    // Find all [[...]] patterns in the line
    const backlinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = backlinkRegex.exec(lineText)) !== null) {
      const matchStart = lineStart + match.index;
      const matchEnd = matchStart + match[0].length;

      // Check if cursor is within this backlink
      if (pos >= matchStart && pos <= matchEnd) {
        const backlinkText = match[1];
        // Extract ID from "Name (id)" format
        const idMatch = backlinkText.match(/\(([^)]+)\)$/);
        const backlinkId = idMatch ? idMatch[1] : undefined;
        const piece = backlinkId ? this.findPieceById(backlinkId) : null;
        if (piece) {
          this.emit("backlink-click", {
            id: backlinkId,
            text: backlinkText,
            piece,
          });
          return true;
        }

        // Only create new backlink if there's NO ID (text-only like [[Name]])
        if (!backlinkId && this.pattern) {
          this.createBacklinkFromPattern(backlinkText, true);
        }

        return true;
      }
    }

    return false;
  }

  /**
   * Create a backlink from pattern
   */
  private async createBacklinkFromPattern(
    backlinkText: string,
    navigate: boolean,
  ): Promise<void> {
    // The op runs against the pattern's own runtime, not the ambient
    // `this.runtime` (which RootView clears to undefined on logout).
    const rt = this.pattern.runtime();
    try {
      const program = this.pattern.get();
      if (!program) return;
      const pattern = JSON.parse(program);

      // Provide mentionable list so the pattern can wire backlinks immediately
      const inputs: Record<string, unknown> = {
        title: backlinkText,
        content: "",
        noteId: generateNoteId(),
      };

      // The note is created in the same space as the pattern it backlinks
      // from — creation, like every piece op, names its space.
      const piece = await rt.createPiece(pattern, this.pattern.space(), inputs);
      if (!piece) {
        throw new Error("Could not create piece.");
      }
      const pieceId = piece.id();

      // Insert the ID into the text if we have an editor
      if (this._editorView && pieceId) {
        this._insertBacklinkId(backlinkText, pieceId, navigate);
      }

      this.emit("backlink-create", {
        text: backlinkText,
        pieceId,
        piece: piece.cell(),
        navigate,
      });
    } catch (error) {
      // A disposal race (logout, runtime swap) cancels the create; that is
      // cancellation, not a failure to surface.
      if (rt.signal.aborted) return;
      console.error("Error creating backlink:", error);
    }
  }

  /**
   * Insert the ID into an incomplete backlink and position cursor appropriately.
   * Replaces [[text]] with [[text (id)]] and positions cursor after ]].
   */
  private _insertBacklinkId(
    backlinkText: string,
    id: string,
    navigate: boolean,
  ): void {
    if (!this._editorView) return;

    const view = this._editorView;
    const state = view.state;
    const doc = state.doc;
    const content = doc.toString();

    // Find the incomplete backlink: [[backlinkText]]
    const searchPattern = `[[${backlinkText}]]`;
    const index = content.indexOf(searchPattern);

    if (index === -1) return;

    // Replace with complete backlink including ID
    const replacement = `[[${backlinkText} (${id})]]`;
    const from = index;
    const to = index + searchPattern.length;

    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: navigate
        ? undefined // Keep current selection if navigating away
        : { anchor: from + replacement.length }, // Position after ]] if staying
    });
  }

  /**
   * If the cursor is after an unclosed [[... token on the same line,
   * return the current query text. Otherwise return null.
   */
  private _currentBacklinkQuery(view: EditorView): string | null {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const textBefore = view.state.doc.sliceString(line.from, pos);
    const m = textBefore.match(/\[\[([^\]]*)$/);
    if (!m) return null;
    return m[1] ?? "";
  }

  /**
   * Find a piece by ID in the mentionable list.
   * Uses pre-resolved stable piece IDs from _resolvedPieceIds cache.
   */
  private findPieceById(id: string): CellHandle<Mentionable> | null {
    const handle = this.mentionable;
    if (!handle) return null;

    const mentionableData = (handle.get() ?? []) as MentionableArray;

    if (mentionableData.length === 0) return null;

    for (let i = 0; i < mentionableData.length; i++) {
      const pieceValue = mentionableData[i];
      if (!pieceValue) continue;
      const pieceId = this._getPieceId(i);
      if (pieceId === id) {
        // The resolved cell IS the piece. For an index row the sub-cell is
        // the row rather than the topic behind it, and every caller here
        // wants the piece — to navigate to it, subscribe to its title, or
        // write its name back — so an unresolved row answers "not found"
        // rather than the row. Only an entry that IS the piece falls
        // through to the sub-cell, with exactly _getPieceId's instability
        // caveat.
        return this._resolvedPieceCells.get(i) ??
          (this._isIndexRow(i)
            ? null
            : (handle.key(i) as CellHandle<Mentionable>));
      }
    }

    return null;
  }

  /**
   * Whether the entry at `index` is an index row standing for a piece — it
   * carries a `piece` property. The property's VALUE is no use for
   * reaching the piece: an `asCell` position crosses the client boundary
   * as an empty object, so a row's piece is reachable only by ADDRESS
   * (`key(index).key("piece")`), and only asynchronously. Until that
   * resolution lands a row has no usable identity, so the completion
   * surfaces withhold it rather than mint an id naming the row.
   */
  private _isIndexRow(index: number): boolean {
    const item = ((this.mentionable?.get() ?? []) as MentionableArray)[index];
    return item != null && Object.hasOwn(item, "piece");
  }

  /**
   * Get the stable piece cell ID for a mentionable item at the given index,
   * in the BARE embed form wiki-link text persists (see mentionIdFromCellId
   * — CellHandle.id() is the full schemed URI; renderers add `/of:` back).
   * Returns the pre-resolved ID if available. An entry that IS the piece
   * falls back to the sub-cell ID (which may be unstable across
   * recomputations); an unresolved index row yields the empty id instead —
   * the sub-cell names the row, and no id beats a wrong one.
   */
  private _getPieceId(index: number): string {
    const id = this._resolvedPieceIds.get(index) ??
      (this._isIndexRow(index)
        ? ""
        : (this.mentionable?.key(index)?.id() ?? ""));
    return id ? mentionIdFromCellId(id) : id;
  }

  /**
   * Resolve stable piece cell IDs for all items in the mentionable list.
   * Each mentionable sub-cell (mentionable.key(i)) may be an indirect
   * reference whose ID changes when the list recomputes. resolveAsCell()
   * follows the indirection to get the piece's own stable cell ID.
   *
   * An entry carrying `piece` resolves through it instead: such an entry is
   * a derived index row standing for the piece, and resolving the entry
   * itself would make every mention name a row of somebody's bookkeeping.
   */
  private async _resolvePieceIds(): Promise<void> {
    const handle = this.mentionable;
    if (!handle) {
      this._mentionResolutionPending = false;
      this._deferredMentionedContent = null;
      return;
    }

    this._mentionResolutionPending = true;

    const mentionableData = (handle.get() ?? []) as MentionableArray;

    // Keep a reference to the current mentionable to detect a rebind, and a
    // generation to detect a newer pass over the SAME handle: contents can
    // change under an identical handle, and an older pass finishing late
    // must not overwrite the newer pass's ordering.
    const currentMentionable = this.mentionable;
    const generation = ++this._resolveGeneration;
    const newResolved = new Map<number, string>();
    const newCells = new Map<number, CellHandle<Mentionable>>();

    // Resolve all piece IDs in parallel
    const promises = mentionableData.map(async (item, i) => {
      if (!item) return;
      try {
        const viaPiece = this._isIndexRow(i);
        const source = viaPiece ? handle.key(i).key("piece") : handle.key(i);
        const resolved = await source.resolveAsCell();
        // Resolution answers with the canonical cell under its own schema,
        // so a piece reached through a row is rebound to the mentionable
        // schema — the `_refDestination` shape — for the field reads its
        // consumers make (the title subscription, the name write-back).
        const pieceCell = viaPiece
          ? resolved.asSchema<Mentionable>(MentionableSchema)
          : (resolved as CellHandle<Mentionable>);
        newCells.set(i, pieceCell);
        const resolvedId = pieceCell.id();
        if (resolvedId) {
          newResolved.set(i, resolvedId);
        }
      } catch {
        // If resolution fails, a direct entry falls back to the sub-cell
        // ID; an index row stays withheld (its sub-cell names the row).
      }
    });

    await Promise.all(promises);

    // Only apply if mentionable hasn't been rebound and no newer pass has
    // started while we were resolving
    if (
      this.mentionable === currentMentionable &&
      generation === this._resolveGeneration
    ) {
      this._resolvedPieceIds = newResolved;
      this._resolvedPieceCells = newCells;
      // The pills find their short names through these records.
      this._publishRefShortNames();
      this._mentionResolutionPending = false;
      const deferredContent = this._deferredMentionedContent;
      this._deferredMentionedContent = null;
      if (deferredContent === null) {
        this._updateMentionedFromContent();
      } else {
        this._updateMentionedFromContent(deferredContent);
      }
      this._refreshCompletion();
    }
  }

  /**
   * Forgets every universe row's resolved piece, until a resolution pass
   * records them again.
   *
   * The pills' short names are found through those records, so forgetting
   * them is announced too: a name the editor can no longer find by identity is
   * not one a pill keeps.
   */
  private _forgetResolvedPieces(): void {
    this._resolvedPieceIds.clear();
    this._resolvedPieceCells.clear();
    this._publishRefShortNames();
  }

  private getValue(): string {
    return this._cellController.getValue();
  }

  private setValue(newValue: string): void {
    this._cellController.setValue(newValue);
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.autofocus && this._editorView) {
      this._queueAutofocus();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupPresence();
    this._cleanup();
  }

  private _updateEditorFromCellValue(): void {
    if (!this._editorView) return;
    // While an operation field is active, its integrated stream is the editor
    // authority. The ordinary Cell subscription still updates the bound value,
    // but feeding that materialized echo back into CodeMirror would discard its
    // unconfirmed local OT state.
    if (this._collaboration?.active) return;

    const newValue = this.getValue();
    // Guard against undefined - can happen when cell isn't bound yet
    if (newValue === undefined || newValue === null) return;

    const currentValue = this._editorView.state.doc.toString();

    // Skip if content already matches - handles Cell echoes.
    // This is the key check that prevents cursor jumping: if the editor
    // already has the content the Cell is trying to set, do nothing.
    if (newValue === currentValue) {
      return;
    }

    // Apply external update to editor, preserving cursor position.
    // Clamp cursor to new document length in case content is shorter.
    const currentSelection = this._editorView.state.selection.main;
    const newLength = newValue.length;
    const anchorPos = Math.min(currentSelection.anchor, newLength);
    const headPos = Math.min(currentSelection.head, newLength);

    this._editorView.dispatch({
      changes: {
        from: 0,
        to: this._editorView.state.doc.length,
        insert: newValue,
      },
      selection: { anchor: anchorPos, head: headPos },
      annotations: CFCodeEditor._cellSyncAnnotation.of(true),
    });

    // Content that arrived from outside replaces what "already there" means,
    // so the reference baseline is retaken against it.
    this._initializeRefTracking();
    this._setupRefDestinationSubscriptions();

    // Ensure mentioned pieces reflect external value changes
    this._updateMentionedFromContent();
  }

  private _handleEditorUpdate(update: ViewUpdate): void {
    const isCellSync = update.transactions.some(
      (transaction) => transaction.annotation(CFCodeEditor._cellSyncAnnotation),
    );
    const isRemote = update.transactions.some((transaction) =>
      transaction.annotation(Transaction.remote)
    );
    if (update.selectionSet && !isCellSync && !isRemote) {
      this._publishPresence();
    }
    if (!update.docChanged || isCellSync) return;

    const value = update.state.doc.toString();
    if (!this.readonly && !isRemote) {
      if (this._collaboration?.active) {
        this._collaboration.localDocChanged();
        this._publishPresence();
        this.emit("cf-change", {
          value,
          oldValue: update.startState.doc.toString(),
          language: this.language,
        });
      } else {
        this.setValue(value);
      }
    }
    this._updateMentionedFromContent(value);
    this._setupPieceNameSubscriptions();
    if (!this.readonly && !isRemote) {
      this._detectAndSyncNameChanges();
      this._syncMentionRefs();
    }
  }

  private _cellSyncUnsub: (() => void) | null = null;

  private _setupCellSyncHandler(): void {
    // Create a custom Cell sync handler that integrates with the CellController
    // but provides the special CodeMirror synchronization logic
    const originalTriggerUpdate = this._cellController["options"].triggerUpdate;

    // Override the CellController's update mechanism to include CodeMirror sync
    this._cellController["options"].triggerUpdate = false; // Disable default updates

    // Set up our own Cell subscription that calls both update methods
    if (this._cellController.hasCell()) {
      const cell = this._cellController.getCell();
      if (cell) {
        this._cellSyncUnsub = cell.subscribe(() => {
          // First update the editor content
          this._updateEditorFromCellValue();
          // Then trigger component update if originally enabled
          if (originalTriggerUpdate) {
            this.requestUpdate();
          }
        });
      }
    }
  }

  private _cleanupCellSyncHandler(): void {
    if (this._cellSyncUnsub) {
      this._cellSyncUnsub();
      this._cellSyncUnsub = null;
    }
  }

  private _cleanupCollaboration(): void {
    this._collaborationGeneration++;
    this._collaborationSyncUnsub?.();
    this._collaborationSyncUnsub = undefined;
    this._cleanupPresence();
    const collaboration = this._collaboration;
    this._collaboration = undefined;
    void collaboration?.stop().catch((cause: unknown) => {
      // The element is detaching, so there is no editor surface on which to
      // reconcile a failed final send; the event is what remains of it.
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.emit("cf-error", { error, message: error.message });
    });
  }

  private _observeCollaboration(
    controller: CodeMirrorCollaborationController,
  ): void {
    this._collaborationSyncUnsub?.();
    this._collaborationSyncUnsub = controller.observeSynchronization(
      (snapshot) => this._handleCollaborationSynchronization(snapshot),
    );
  }

  private async _setupCollaboration(): Promise<void> {
    const view = this._editorView;
    if (!view) return;

    const generation = ++this._collaborationGeneration;
    this._collaborationSyncUnsub?.();
    this._collaborationSyncUnsub = undefined;
    this._cleanupPresence();
    const previous = this._collaboration;
    this._collaborationFailed = false;

    if (previous !== undefined) {
      // Freeze editing while the previous controller confirms every local
      // update. Toggling collaboration or rebinding the cell must never turn
      // an unconfirmed CodeMirror change into an ordinary whole-value write.
      view.dispatch({
        effects: this._readonly.reconfigure(EditorState.readOnly.of(true)),
      });
      try {
        await previous.stop();
      } catch (cause) {
        if (generation !== this._collaborationGeneration) return;
        previous.dispose();
        if (this._collaboration === previous) {
          this._collaboration = undefined;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this._collaborationFailed = true;
        this.emit("cf-error", { error, message: error.message });
        return;
      }
      if (generation !== this._collaborationGeneration) return;
      if (this._collaboration === previous) {
        this._collaboration = undefined;
      }
    }

    if (!this.collaborative) {
      view.dispatch({
        effects: [
          this._collaborationComp.reconfigure([]),
          this._readonly.reconfigure(EditorState.readOnly.of(this.readonly)),
        ],
      });
      this._updateEditorFromCellValue();
      return;
    }

    if (!isCellHandle(this.value)) {
      const error = new Error(
        "Collaborative code editing requires a CellHandle value",
      );
      view.dispatch({
        effects: this._readonly.reconfigure(EditorState.readOnly.of(true)),
      });
      this.emit("cf-error", { error, message: error.message });
      return;
    }
    const sourceCell = this.value as CellHandle<string>;

    // Do not accept edits between the initial Memory query and installation of
    // CodeMirror's versioned collaboration state.
    view.dispatch({
      effects: this._readonly.reconfigure(EditorState.readOnly.of(true)),
    });
    let cell: CellHandle<string>;
    try {
      cell = await sourceCell.resolveAsCell();
    } catch (cause) {
      if (generation !== this._collaborationGeneration) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this._collaborationFailed = true;
      this.emit("cf-error", { error, message: error.message });
      return;
    }
    if (generation !== this._collaborationGeneration) return;
    const controller = new CodeMirrorCollaborationController({
      runtime: cell.runtime(),
      cell,
      view,
      compartment: this._collaborationComp,
      onError: (error) => {
        if (
          generation !== this._collaborationGeneration ||
          this._collaboration !== controller
        ) return;
        this._collaborationFailed = true;
        this._cleanupPresence();
        view.dispatch({
          effects: this._readonly.reconfigure(EditorState.readOnly.of(true)),
        });
        if (error instanceof CodeMirrorReconciliationError) {
          this.emit("cf-collaboration-reconcile", {
            localValue: error.localValue,
            canonicalValue: error.canonicalValue,
            localCursor: error.localCursor,
            canonicalCursor: error.canonicalCursor,
          });
        }
        this.emit("cf-error", { error, message: error.message });
      },
    });
    this._collaboration = controller;

    try {
      await controller.start();
      if (
        generation !== this._collaborationGeneration ||
        this._collaboration !== controller
      ) {
        controller.dispose();
        return;
      }
      this._observeCollaboration(controller);
      view.dispatch({
        effects: this._readonly.reconfigure(
          EditorState.readOnly.of(
            this.readonly || this._collaborationFailed,
          ),
        ),
      });
    } catch (cause) {
      if (
        generation !== this._collaborationGeneration ||
        this._collaboration !== controller
      ) return;
      controller.dispose();
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this._collaborationFailed = true;
      this._cleanupPresence();
      view.dispatch({
        effects: this._readonly.reconfigure(EditorState.readOnly.of(true)),
      });
      this.emit("cf-error", { error, message: error.message });
    }
  }

  private _handleCollaborationSynchronization(
    snapshot: CodeMirrorSynchronizationSnapshot | null,
  ): void {
    if (snapshot === null) {
      this._cleanupPresence();
      return;
    }
    if (
      this._presenceEpoch !== undefined &&
      this._presenceEpoch !== snapshot.confirmedCursor.epoch
    ) {
      this._cleanupPresence();
    }
    this._setupPresence(snapshot);
    // The extension is installed as soon as a join starts, so its cursor
    // follows every advance from then on; a record that lands after the
    // join is mapped against the document the extension already knows.
    if ((!this._presence && !this._presenceJoining) || !this._editorView) {
      return;
    }
    this._editorView.dispatch({
      effects: codeMirrorPresenceCursorEffect.of({
        cursor: snapshot.confirmedCursor,
        pendingChanges: snapshot.pendingChanges,
      }),
    });
    this._publishPresence();
  }

  /**
   * Joins the presence room of the collaborative field through the cell's
   * runtime once collaboration is ready and a participant name is set. A
   * join already made for the same epoch and room is kept and republished
   * to; a failure is reported once per configuration, and a `configuration`
   * failure is not retried until the room or name changes.
   */
  private _setupPresence(
    synchronization = this._collaboration?.synchronizationSnapshot,
    retryFailedConnection = false,
  ): void {
    const view = this._editorView;
    const controller = this._collaboration;
    const room = this.presenceRoom;
    const configurationKey = JSON.stringify([room, this.participantName]);
    if (
      this._presenceFailure !== undefined &&
      this._presenceFailure.configurationKey !== configurationKey
    ) {
      this._presenceFailure = undefined;
    }
    if (
      !view || !this.collaborative || !controller?.active ||
      synchronization === null || synchronization === undefined ||
      !this.participantName
    ) {
      this._cleanupPresence();
      return;
    }
    if (
      this._presenceFailure?.configurationKey === configurationKey &&
      (this._presenceFailure.category === "configuration" ||
        !retryFailedConnection)
    ) {
      return;
    }
    if (
      (this._presence !== undefined || this._presenceJoining) &&
      this._presenceEpoch === synchronization.confirmedCursor.epoch &&
      this._presenceRoom === room
    ) {
      this._publishPresence();
      return;
    }

    this._presenceFailure = undefined;
    this._cleanupPresence();
    view.dispatch({
      effects: this._presenceComp.reconfigure(
        codeMirrorPresence(synchronization.confirmedCursor),
      ),
    });
    this._presenceEpoch = synchronization.confirmedCursor.epoch;
    this._presenceRoom = room;
    const generation = this._presenceGeneration;
    const cell = controller.cell;
    this._presenceJoining = true;
    void cell.runtime().joinPresenceRoom(
      cell,
      room === "" ? {} : { room },
    ).then((handle) => {
      if (generation !== this._presenceGeneration) {
        void handle.leave();
        return;
      }
      this._presenceJoining = false;
      this._presence = handle;
      this._presenceParticipantId = handle.participantId;
      this._presenceUnsubscribe = handle.subscribe((event) =>
        this._handlePresenceEvent(event)
      );
      this._applyPresenceSnapshot(handle.participants);
      this._publishPresence();
    }, (error) => {
      if (generation !== this._presenceGeneration) return;
      this._presenceJoining = false;
      this._failPresence(presenceFailureCategory(error));
    });
  }

  private _handlePresenceFocus(): void {
    // A focus is a user's action, and the one signal on which a failed
    // connection is tried again. A room already joined is republished to
    // with the new focus state; one being joined publishes on arrival.
    this._setupPresence(undefined, true);
  }

  private _cleanupPresence(): void {
    // A join still in flight belongs to the generation it started under and
    // leaves the room it lands in.
    this._presenceGeneration++;
    this._presenceJoining = false;
    const presence = this._presence;
    this._presence = undefined;
    this._presenceUnsubscribe?.();
    this._presenceUnsubscribe = undefined;
    void presence?.leave();
    this._presenceParticipantId = undefined;
    this._presenceHasSelection = false;
    this._presenceEpoch = undefined;
    this._presenceRoom = undefined;
    this._editorView?.dispatch({
      effects: [
        codeMirrorPresenceClearEffect.of(null),
        this._presenceComp.reconfigure([]),
      ],
    });
  }

  private _failPresence(category: PresenceFailureCategory): void {
    const configurationKey = JSON.stringify([
      this.presenceRoom,
      this.participantName,
    ]);
    if (
      this._presenceFailure?.category === category &&
      this._presenceFailure.configurationKey === configurationKey
    ) {
      return;
    }
    this._presenceFailure = { category, configurationKey };
    this._cleanupPresence();
    this.emit("cf-presence-error", { category });
  }

  private _handlePresenceEvent(event: PresenceEvent): void {
    const view = this._editorView;
    const synchronization = this._collaboration?.synchronizationSnapshot;
    if (event.kind === "failure") {
      this._failPresence(presenceFailureCategory(event.error));
      return;
    }
    if (!view || !this._presence || !synchronization) return;
    if (event.kind === "snapshot") {
      this._presenceParticipantId = event.participantId;
      this._applyPresenceSnapshot(event.participants);
      return;
    }
    if (event.kind === "upsert") {
      if (event.participant.participantId === this._presenceParticipantId) {
        return;
      }
      const participant = participantFromRecord(event.participant);
      view.dispatch({
        effects: participant === null
          ? codeMirrorPresenceRemoveEffect.of(event.participant.participantId)
          : codeMirrorPresenceUpsertEffect.of({
            participant,
            pendingChanges: synchronization.pendingChanges,
          }),
      });
      return;
    }
    if (event.participantId === this._presenceParticipantId) return;
    view.dispatch({
      effects: codeMirrorPresenceRemoveEffect.of(event.participantId),
    });
  }

  /** Replaces every remote caret with those the room's records carry. */
  private _applyPresenceSnapshot(records: readonly PresenceRecord[]): void {
    const view = this._editorView;
    const synchronization = this._collaboration?.synchronizationSnapshot;
    if (!view || !synchronization) return;
    view.dispatch({
      effects: [
        codeMirrorPresenceClearEffect.of(null),
        ...records
          .filter((record) =>
            record.participantId !== this._presenceParticipantId
          )
          .map(participantFromRecord)
          .filter((participant) => participant !== null)
          .map((participant) =>
            codeMirrorPresenceUpsertEffect.of({
              participant,
              pendingChanges: synchronization.pendingChanges,
            })
          ),
      ],
    });
  }

  private _publishPresence(): void {
    const presence = this._presence;
    const view = this._editorView;
    const synchronization = this._collaboration?.synchronizationSnapshot;
    if (!presence || !view || synchronization === null || !synchronization) {
      return;
    }
    const focused = view.hasFocus;
    if (focused) this._presenceHasSelection = true;
    const provisional = synchronization.pendingChanges.length !== 0;
    presence.setName(this.participantName);
    presence.setFocused(focused);
    presence.setFacet(
      CARET_FACET,
      caretFacetOf({
        focused,
        cursor: synchronization.confirmedCursor,
        selection: this._presenceHasSelection
          ? presenceSelectionToJSON(mapSelectionToConfirmed(
            view.state.selection,
            synchronization.pendingChanges,
          ))
          : null,
        basis: provisional ? "provisional" : "confirmed",
      }),
    );
  }

  /**
   * Subscribe to mentionable changes to re-resolve mentioned pieces when
   * the source list updates.
   */
  private _setupMentionableSyncHandler(): void {
    if (this._mentionableUnsub) {
      this._mentionableUnsub();
      this._mentionableUnsub = null;
    }

    if (!this.mentionable) return;
    // this.mentionable is already wrapped with asSchema(MentionableArraySchema)
    // in willUpdate, so the runtime resolves @link indirection before
    // delivering values to subscribers.
    const unsubscribe = this.mentionable
      .subscribe((_value) => {
        // Clear stale resolved IDs and re-resolve asynchronously. The
        // $mentioned reconciliation waits for the resolution pass (which
        // runs it on publish): against cleared maps an index-row backlink
        // has no id, and reconciling in that window would transiently drop
        // its edge only to re-add it moments later.
        this._forgetResolvedPieces();
        this._resolvePieceIds();
      });
    this._mentionableUnsub = unsubscribe;
  }

  /**
   * Subscribe to mentioned cell changes to handle external updates.
   * Unsubscribes from previous cell when binding changes.
   */
  private _setupMentionedSyncHandler(): void {
    if (this._mentionedUnsub) {
      this._mentionedUnsub();
      this._mentionedUnsub = null;
    }

    if (!this.mentioned) return;
    // this.mentioned is already wrapped with asSchema(MentionableArraySchema)
    // in willUpdate.
    const unsubscribe = this.mentioned
      .subscribe((_value) => {
        // Re-sync piece name subscriptions when mentioned list changes externally
        this._setupPieceNameSubscriptions();
      });
    this._mentionedUnsub = unsubscribe;
  }

  /**
   * Subscribe to the reference map so the editor learns which keys resolve.
   * Until a key is in the map its token is ordinary text, so this subscription
   * is what turns a freshly loaded document's mentions into pills.
   */
  private _setupReferencesSyncHandler(): void {
    if (this._referencesUnsub) {
      this._referencesUnsub();
      this._referencesUnsub = null;
    }

    if (!this.references) return;
    // this.references is already wrapped with asSchema(MentionRefMapSchema)
    // in willUpdate.
    this._referencesUnsub = this.references.subscribe(() => {
      this._publishKnownRefKeys();
      // A reference the map has just made visible was not there to be tracked
      // when the document loaded. Without this, its first label edit reads as
      // a reference with no history and is passed over.
      this._seedRefLabelBaseline();
      this._setupRefDestinationSubscriptions();
      this._updateMentionedFromContent();
    });
  }

  /** Record the current label of any reference not already being tracked. */
  private _seedRefLabelBaseline(): void {
    for (const ref of this._documentRefs()) {
      if (!this._previousRefLabels.has(ref.key)) {
        this._previousRefLabels.set(ref.key, ref.label);
      }
    }
  }

  /** Tell the editor state which keys the map holds. */
  private _publishKnownRefKeys(): void {
    if (!this._editorView) return;
    this._editorView.dispatch({
      effects: setKnownRefKeys.of(Object.keys(this._refMap())),
    });
  }

  private _cleanupRefDestinationSubscriptions(): void {
    for (const { unsub } of this._refDestinationSubscriptions.values()) unsub();
    this._refDestinationSubscriptions.clear();
    // Clearing the names announces nothing, because nothing mirrors them: the
    // one reader, `_detectRefLabelChanges`, reads this map. Until the new
    // destinations deliver, it finds no name and reads an edited label as the
    // user's own wording — the safe direction, since a rename arriving later
    // then leaves the person's text alone instead of overwriting it.
    this._refNames.clear();
    // The short names are read through the map, so they are published here
    // rather than left for the next subscription pass: a map taken away opens
    // no such pass, and a pill would keep the number its old destination was
    // found under.
    this._publishRefShortNames();
  }

  private _cleanup(): void {
    this._cancelAutofocus();
    this._cleanupCellSyncHandler();
    this._cleanupCollaboration();
    this._cleanupPieceNameSubscriptions();
    this._cleanupRefDestinationSubscriptions();
    this._resolveGeneration++;
    this._mentionResolutionPending = false;
    this._deferredMentionedContent = null;
    this._completionAwaitingResolution = false;
    this._forgetResolvedPieces();
    if (this._mentionableUnsub) {
      this._mentionableUnsub();
      this._mentionableUnsub = null;
    }
    if (this._mentionedUnsub) {
      this._mentionedUnsub();
      this._mentionedUnsub = null;
    }
    if (this._referencesUnsub) {
      this._referencesUnsub();
      this._referencesUnsub = null;
    }
    this._cleanupFns.forEach((fn) => fn());
    this._cleanupFns = [];
    if (this._editorView) {
      this._editorView.destroy();
      this._editorView = undefined;
    }
  }

  override willUpdate(changedProperties: Map<string, any>) {
    if (changedProperties.has("mentionable")) {
      if (this.mentionable) {
        this.mentionable = this.mentionable.asSchema(MentionableArraySchema);
      }
      this._forgetResolvedPieces();
      this._resolvePieceIds();
      this._setupMentionableSyncHandler();
      this._updateMentionedFromContent();
    }
    if (changedProperties.has("mentioned")) {
      if (this.mentioned) {
        this.mentioned = this.mentioned.asSchema(MentionableArraySchema);
      }
      // A new cell has none of the old one's contents, so the signature that
      // described what was last written to the old one says nothing about it.
      this._lastMentionedSignature = null;
      this._setupMentionedSyncHandler();
      this._updateMentionedFromContent();
    }
    if (changedProperties.has("references")) {
      if (this.references) {
        this.references = this.references.asSchema(MentionRefMapSchema);
      }
      this._cleanupRefDestinationSubscriptions();
      this._previousRefLabels.clear();
      this._refKeysAtLoad = null;
      this._lastMentionedSignature = null;
      this._setupReferencesSyncHandler();
      this._publishKnownRefKeys();
      this._initializeRefTracking();
      this._updateMentionedFromContent();
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      // Cancel pending debounced updates from old Cell to prevent race condition
      this._cellController.cancel();
      // A different document has a different set of mentions in it.
      this._lastMentionedSignature = null;
      // Clean up old Cell subscription and set up new one
      this._cleanupCellSyncHandler();
      this._cellController.bind(this.value, stringSchema);
      this._setupCellSyncHandler();
      this._updateEditorFromCellValue();
    }

    if (
      this.hasUpdated &&
      (changedProperties.has("value") ||
        changedProperties.has("collaborative"))
    ) {
      void this._setupCollaboration();
    }

    if (
      changedProperties.has("presenceRoom") ||
      changedProperties.has("participantName")
    ) {
      this._setupPresence();
    }

    // Update language
    if (changedProperties.has("language") && this._editorView) {
      const lang = getLangExtFromMimeType(this.language);
      this._editorView.dispatch({
        effects: this._lang.reconfigure(lang),
      });
    }

    // Update readonly state
    if (changedProperties.has("readonly") && this._editorView) {
      this._editorView.dispatch({
        effects: this._readonly.reconfigure(
          EditorState.readOnly.of(
            this.readonly || this._collaborationFailed,
          ),
        ),
      });
    }

    // Update word wrap
    if (changedProperties.has("wordWrap") && this._editorView) {
      this._editorView.dispatch({
        effects: this._wrap.reconfigure(
          this.wordWrap ? EditorView.lineWrapping : [],
        ),
      });
    }

    // Update line numbers visibility (hide gutters when false)
    if (changedProperties.has("lineNumbers") && this._editorView) {
      const hideGutters = !this.lineNumbers;
      const ext = hideGutters
        ? EditorView.theme({
          ".cm-gutters": { display: "none" },
          ".cm-content": { paddingLeft: "0px" },
        })
        : [] as unknown as Extension;
      this._editorView.dispatch({
        effects: this._gutters.reconfigure(ext),
      });
    }

    // Update tab size
    if (changedProperties.has("tabSize") && this._editorView) {
      const size = this.tabSize ?? 2;
      this._editorView.dispatch({
        effects: [
          this._tabSizeComp.reconfigure(EditorState.tabSize.of(size)),
          this._indentUnitComp.reconfigure(indentUnit.of(" ".repeat(size))),
        ],
      });
    }

    // Update tab indent keymap
    if (changedProperties.has("tabIndent") && this._editorView) {
      const ext = this.tabIndent ? keymap.of([indentWithTab]) : [];
      this._editorView.dispatch({
        effects: this._tabIndentComp.reconfigure(ext),
      });
    }

    // Update max line width theme
    if (changedProperties.has("maxLineWidth") && this._editorView) {
      const n = this.maxLineWidth;
      const maxWidth = typeof n === "number"
        ? (n > 0 ? `${n}ch` : undefined)
        : n;
      const ext = maxWidth
        ? EditorView.theme({
          ".cm-content": { maxWidth },
        })
        : [] as unknown as Extension;
      this._editorView.dispatch({
        effects: this._maxLineWidthComp.reconfigure(ext),
      });
    }

    // Update timing controller if timing options changed
    if (
      changedProperties.has("timingStrategy") ||
      changedProperties.has("timingDelay")
    ) {
      this._cellController.updateTimingOptions({
        strategy: this.timingStrategy,
        delay: this.timingDelay,
      });
    }

    // Update theme plugin
    if (changedProperties.has("theme") && this._editorView) {
      this._editorView.dispatch({
        effects: this._themeComp.reconfigure(
          this.theme === "dark" ? oneDark : [],
        ),
      });
    }

    // Update mode (setup extensions + prose styling + markdown rendering)
    if (changedProperties.has("mode") && this._editorView) {
      this._editorView.dispatch({
        effects: [
          this._setupComp.reconfigure(this._getSetupExtensions()),
          this._modeComp.reconfigure(this._getModeExtension()),
          this._proseMarkdownComp.reconfigure(
            this.mode === "prose" ? createProseMarkdownPlugin() : [],
          ),
        ],
      });
    }

    if (changedProperties.has("autofocus")) {
      if (this.autofocus) {
        this._queueAutofocus();
      } else {
        this._cancelAutofocus();
      }
    }
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    this._initializeEditor();

    // Bind the initial value to the cell controller
    this._cellController.bind(this.value, stringSchema);

    // Update timing options to match current properties
    this._cellController.updateTimingOptions({
      strategy: this.timingStrategy,
      delay: this.timingDelay,
    });

    // Set up custom cell sync handler for CodeMirror
    this._setupCellSyncHandler();

    void this._setupCollaboration();

    // Set up mentionable sync handler and initialize mentioned list
    this._setupMentionableSyncHandler();
    this._setupMentionedSyncHandler();
    this._setupReferencesSyncHandler();
    this._publishKnownRefKeys();
    this._updateMentionedFromContent();

    // Initialize backlink name tracking for sync detection
    this._initializeBacklinkNameTracking();
    this._initializeRefTracking();

    // Set up subscriptions for bidirectional NAME sync
    this._setupPieceNameSubscriptions();

    this._queueAutofocus();
  }

  private _queueAutofocus(): void {
    if (!this.autofocus) return;
    this._autofocusPending = true;
    this._observeAutofocusVisibility();
    this._scheduleAutofocusAttempt();
  }

  private _scheduleAutofocusAttempt(): void {
    if (!this._autofocusPending || this._autofocusFrame !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      this._attemptAutofocus();
      return;
    }
    this._autofocusFrame = requestAnimationFrame(() => {
      this._autofocusFrame = null;
      this._attemptAutofocus();
    });
  }

  private _attemptAutofocus(): void {
    if (!this._autofocusPending || !this.autofocus) {
      this._cancelAutofocus();
      return;
    }
    if (!this._editorView) return;
    if (typeof document !== "undefined" && !this.isConnected) return;

    if (!this._isVisibleForAutofocus()) {
      this._observeAutofocusVisibility();
      return;
    }

    this._editorView.focus();
    this._autofocusPending = false;
    this._teardownAutofocusObservers();
  }

  private _isVisibleForAutofocus(): boolean {
    if (typeof document === "undefined") return true;
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private _observeAutofocusVisibility(): void {
    if (typeof document === "undefined") return;

    if (
      !this._autofocusIntersectionObserver &&
      typeof IntersectionObserver !== "undefined"
    ) {
      this._autofocusIntersectionObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            this._scheduleAutofocusAttempt();
          }
        },
      );
      this._autofocusIntersectionObserver.observe(this);
    }

    if (
      !this._autofocusResizeObserver && typeof ResizeObserver !== "undefined"
    ) {
      this._autofocusResizeObserver = new ResizeObserver(() => {
        if (this._isVisibleForAutofocus()) {
          this._scheduleAutofocusAttempt();
        }
      });
      this._autofocusResizeObserver.observe(this);
    }
  }

  private _cancelAutofocus(): void {
    this._autofocusPending = false;
    if (
      this._autofocusFrame !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(this._autofocusFrame);
    }
    this._autofocusFrame = null;
    this._teardownAutofocusObservers();
  }

  private _teardownAutofocusObservers(): void {
    this._autofocusIntersectionObserver?.disconnect();
    this._autofocusIntersectionObserver = null;
    this._autofocusResizeObserver?.disconnect();
    this._autofocusResizeObserver = null;
  }

  /**
   * Initialize the backlink name tracking map with current document state.
   * This establishes a baseline so we can detect subsequent name changes.
   */
  private _initializeBacklinkNameTracking(): void {
    if (!this._editorView) return;
    const backlinks = this._editorView.state.field(backlinkField);
    this._previousBacklinkNames.clear();
    for (const bl of backlinks) {
      if (bl.id) {
        this._previousBacklinkNames.set(bl.id, bl.name);
      }
    }
  }

  private _getSetupExtensions(): Extension {
    // Shared extensions needed in both modes
    const shared: Extension[] = [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...completionKeymap,
      ]),
    ];

    if (this.mode === "prose") {
      // Prose mode: minimal setup — no line numbers, no bracket matching,
      // no fold gutters, no selection highlights, no rectangular select,
      // no defaultHighlightStyle (our decoration plugin handles all rendering)
      return shared;
    }

    // Code mode: full setup matching what basicSetup provided
    return [
      ...shared,
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...foldKeymap,
        ...lintKeymap,
      ]),
    ];
  }

  private _getModeExtension(): Extension {
    if (this.mode !== "prose") return [];

    const hasCustomWidth = this.maxLineWidth !== undefined;
    return [
      EditorView.theme({
        ".cm-content": {
          fontFamily:
            "var(--cf-code-editor-font-family-prose, var(--cf-theme-font-family, var(--cf-font-family-sans)))",
          lineHeight: "1.6",
          padding: "8px 0",
          ...(!hasCustomWidth && {
            maxWidth:
              "var(--cf-code-editor-prose-max-width, var(--cf-layout-width-prose, 700px))",
          }),
          margin: "0 auto",
        },
        ".cm-line": {
          padding: "1px 0",
        },
      }),
    ];
  }

  private _initializeEditor(): void {
    const editorElement = this.shadowRoot?.querySelector(
      ".code-editor",
    ) as HTMLElement;
    if (!editorElement) return;

    // Create editor extensions
    const extensions: Extension[] = [
      this._setupComp.of(this._getSetupExtensions()),
      // Backlink protection: StateField + atomic ranges + edit filter
      backlinkField,
      atomicBacklinkRanges,
      backlinkEditFilter,
      // The same four blocks for the reference form. They are inert until the
      // map announces a key, so an editor with no `references` cell carries
      // them at the cost of an empty parse.
      mentionRefField,
      atomicMentionRefRanges,
      mentionRefEditFilter,
      // What the universe calls each mention's destination, which the pills
      // render beside their labels. Holds no name for a mention whose
      // destination no row of the universe stands for.
      refShortNameField,
      // Tab indentation keymap (toggleable)
      this._tabIndentComp.of(this.tabIndent ? keymap.of([indentWithTab]) : []),
      this._lang.of(getLangExtFromMimeType(this.language)),
      this._readonly.of(EditorState.readOnly.of(this.readonly)),
      // Word wrapping
      this._wrap.of(this.wordWrap ? EditorView.lineWrapping : []),
      // Hide gutters when line numbers are disabled
      this._gutters.of(
        !this.lineNumbers
          ? EditorView.theme({
            ".cm-gutters": { display: "none" },
            ".cm-content": { paddingLeft: "0px" },
          })
          : [] as unknown as Extension,
      ),
      // Tab size
      this._tabSizeComp.of(EditorState.tabSize.of(this.tabSize ?? 2)),
      this._indentUnitComp.of(
        indentUnit.of(" ".repeat(this.tabSize ?? 2)),
      ),
      // Optional max line width (number → ch, string → as-is)
      this._maxLineWidthComp.of(
        (() => {
          const n = this.maxLineWidth;
          const maxWidth = typeof n === "number"
            ? (n > 0 ? `${n}ch` : undefined)
            : n;
          return maxWidth
            ? EditorView.theme({ ".cm-content": { maxWidth } })
            : [] as unknown as Extension;
        })(),
      ),
      // Theme (dark -> oneDark)
      this._themeComp.of(this.theme === "dark" ? oneDark : []),
      // Prose/code mode extensions
      this._modeComp.of(this._getModeExtension()),
      this._proseMarkdownComp.of(
        this.mode === "prose" ? createProseMarkdownPlugin() : [],
      ),
      this._collaborationComp.of([]),
      this._presenceComp.of([]),
      EditorView.updateListener.of((update) =>
        this._handleEditorUpdate(update)
      ),
      // Handle focus/blur events
      EditorView.domEventHandlers({
        focus: () => {
          this._cellController.onFocus();
          this.emit("cf-focus");
          this._handlePresenceFocus();
          return false;
        },
        blur: () => {
          this._cellController.onBlur();
          this.emit("cf-blur");
          this._publishPresence();
          return false;
        },
        paste: (event, view) => {
          if (this.readonly || this.disabled) return false;
          const files = Array.from(event.clipboardData?.files ?? [])
            .filter((file) => file.type.startsWith("image/"));
          if (files.length > 0) {
            event.preventDefault();
            this._handleImagePaste(files, view);
            return true;
          }
          return this._handleUrlPaste(event, view);
        },
      }),
      // Add backlink click handler for Cmd/Ctrl+Click
      this.createBacklinkClickHandler(),
      // Add backlink decoration plugin to visually style [[backlinks]]
      createBacklinkDecorationPlugin(),
      // ...and the same for [Label][key] references
      createMentionRefDecorationPlugin(),
      // Add autocompletion with backlink support. The short-name source sits
      // beside it rather than inside it: the two triggers offer the same rows
      // and mint the same mention, and only what opens a query differs.
      autocompletion({
        override: [
          this.createBacklinkCompletionSource(),
          this.createShortNameCompletionSource(),
        ],
        activateOnTyping: true,
        defaultKeymap: true,
        // Don't auto-select first option - let user explicitly choose or press Enter
        selectOnOpen: false,
      }),
      // Force completion to stay open when inside [[ context
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const query = this._currentBacklinkQuery(update.view);
        if (query !== null) {
          const status = completionStatus(update.state);
          if (status === null) {
            setTimeout(() => startCompletion(update.view), 0);
          }
        }
      }),
      // Enter: complete backlink OR exit editing mode (no newline inside backlinks)
      // Use Prec.highest to ensure this runs before autocompletion handlers
      Prec.highest(keymap.of([{
        key: "Escape",
        run: () => {
          this._completionAwaitingResolution = false;
          return false;
        },
      }, {
        key: "Enter",
        run: (view) => {
          const pos = view.state.selection.main.head;
          const backlinks = view.state.field(backlinkField);

          // Enter inside a reference exits it, the same as inside a backlink
          for (const ref of mentionRefs(view.state)) {
            if (pos >= ref.from && pos < ref.to) {
              view.dispatch({ selection: { anchor: ref.to } });
              return true;
            }
          }

          // Check if cursor is inside a complete backlink (from [[ up to but not after ]])
          // Enter inside backlink exits editing; Enter after ]] allows normal newline
          for (const bl of backlinks) {
            if (bl.id && pos >= bl.from && pos < bl.to) {
              // Cursor is inside the backlink - exit editing mode
              // Move cursor to after ]] without inserting newline
              view.dispatch({
                selection: { anchor: bl.to },
              });
              return true; // Consume Enter, no newline
            }
          }

          // If typing a new backlink like [[mention, complete it
          const query = this._currentBacklinkQuery(view);
          if (query != null) {
            const text = query.trim();
            if (text.length > 0) {
              this._completeBacklinkQuery(view, text);
              return true;
            }
          }

          // A `#42` query gets no branch here, deliberately. The completion
          // below `[[` CREATES a piece for a query that matched nothing, and
          // a stray `#7` typed into prose must never create anything. A
          // short-name citation is picked from the completion list or it
          // stays text, so Enter over one falls through to the newline.
          return false;
        },
      }])),
      // Intercept Cmd/Ctrl+S when editor is focused
      keymap.of([{
        key: "Mod-s",
        run: () => true, // prevent default browser save
      }]),
    ];

    // Add placeholder extension if specified
    if (this.placeholder) {
      extensions.push(placeholder(this.placeholder));
    }

    // Create editor state
    const doc = this.getValue() ?? "";
    const state = EditorState.create({
      doc,
      extensions,
      selection: { anchor: this.cursorPosition === "end" ? doc.length : 0 },
    });

    // Create editor view
    this._editorView = new EditorView({
      state,
      parent: editorElement,
    });
  }

  override render() {
    return html`
      <div class="code-editor"></div>
    `;
  }

  /**
   * Focus the editor programmatically
   */
  override focus(): void {
    this._editorView?.focus();
  }

  /**
   * Get the current editor state
   */
  get editorState(): EditorState | undefined {
    return this._editorView?.state;
  }

  /**
   * Get the editor view instance
   */
  get editorView(): EditorView | undefined {
    return this._editorView;
  }

  /**
   * Turn a pasted URL that names a piece into a mention.
   *
   * Pasting a piece's URL is how someone says "this one" when they have the
   * link rather than the name, and leaving it as a URL makes it invisible to
   * everything that reads mentions. Only in reference mode: the wiki-link form
   * carries an id the paste would have to be rewritten into, and the reference
   * form is the one whose destination can be any cell.
   *
   * The label starts as the pasted text and is replaced by the destination's
   * name when the subscription delivers it — `modifiedTitle` is false, so the
   * rewrite that already exists for a rename does this too.
   */
  private _handleUrlPaste(event: ClipboardEvent, view: EditorView): boolean {
    if (!this._refMode || !this.pattern) return false;

    const text = event.clipboardData?.getData("text/plain")?.trim();
    if (!text || /\s/.test(text)) return false;

    const target = parseFabricUrl(text, { hosts: this._fabricHosts() });
    // Everything this cannot turn into a mention has to fall through to the
    // ordinary paste, and the decision has to be complete BEFORE the default
    // is prevented — a `preventDefault` followed by a later bail swallows what
    // the user pasted. A space named rather than addressed cannot be resolved
    // on this side, and a slug addresses a redirect document that would need a
    // read before it could name a piece.
    if (
      !target || !target.id || target.member === "argument" ||
      (target.scope !== undefined && target.scope !== "space") ||
      (target.space && !isDID(target.space))
    ) {
      return false;
    }

    event.preventDefault();
    this._insertPastedMention(view, text, target.id, target.space);
    return true;
  }

  /** Hosts whose page URLs name pieces: this document's own, plus any given. */
  private _fabricHosts(): string[] {
    const own = globalThis.location?.host;
    return own ? [own, ...this.fabricHosts] : [...this.fabricHosts];
  }

  private async _insertPastedMention(
    view: EditorView,
    text: string,
    id: string,
    space?: string,
  ): Promise<void> {
    const key = mintRefKey(this._takenRefKeys());
    const { from, to } = view.state.selection.main;
    this._insertRefToken(view, from, to, text, key);

    const rt = this.pattern.runtime();
    try {
      const destination = await rt.getCell(
        (space ?? this.pattern.space()) as DID,
        id,
      );
      if (!destination) throw new Error("Could not read the pasted cell.");

      // The token may have been edited or removed while the read was in
      // flight, exactly as for a mention whose piece is being created.
      if (!this._findRefToken(key)) return;

      this.references?.key(key).set(
        {
          destination: destination as unknown as CellHandle<unknown>,
          modifiedTitle: false,
        } as unknown as MentionRef,
      );
      this._refKeysAtLoad?.add(key);
    } catch (error) {
      if (rt.signal.aborted) return;
      console.error("Error resolving a pasted mention:", error);
      this._removeRefToken(key);
    }
  }

  /**
   * Deliberately releases the active Memory operation field. Disconnecting the
   * element or toggling `collaborative` does not release shared durable state.
   */
  async releaseCollaboration(): Promise<void> {
    const collaboration = this._collaboration;
    if (!collaboration?.active) return;
    this._collaborationSyncUnsub?.();
    this._collaborationSyncUnsub = undefined;
    this._cleanupPresence();
    const view = this._editorView;
    view?.dispatch({
      effects: this._readonly.reconfigure(EditorState.readOnly.of(true)),
    });
    const transition = collaboration.release();
    this._collaborationTransition = transition;
    try {
      await transition;
    } catch (error) {
      if (this._collaboration === collaboration) {
        if (collaboration.active) {
          this._observeCollaboration(collaboration);
        }
        view?.dispatch({
          effects: this._readonly.reconfigure(
            EditorState.readOnly.of(
              this.readonly || this._collaborationFailed,
            ),
          ),
        });
      }
      throw error;
    } finally {
      if (this._collaborationTransition === transition) {
        this._collaborationTransition = undefined;
      }
    }
    if (this._collaboration === collaboration) {
      this._collaboration = undefined;
      this.collaborative = false;
      this.requestUpdate();
    }
  }

  private async _handleImagePaste(
    files: File[],
    view: EditorView,
  ): Promise<void> {
    const runtime = isCellHandle(this.value)
      ? this.value.runtime()
      : this.runtime;
    // The pasted image's blob belongs to the edited cell's space; fall
    // back to the view's space from context.
    const space = isCellHandle(this.value)
      ? this.value.space()
      : this.contextSpace;

    if (!runtime || !space) {
      const message = !runtime
        ? "Runtime is not available for pasted image storage"
        : "Space is not available for pasted image storage";
      this.emit("cf-error", { error: new Error(message), message });
      return;
    }

    try {
      const storedFiles: StoredFile[] = [];
      for (const file of files) {
        storedFiles.push(await uploadFile({ file, runtime, space }));
      }

      const markdown = storedFiles
        .map((file) =>
          `![${escapeMarkdownImageAltText(file.name)}](${file.url})`
        )
        .join("\n");
      const selection = view.state.selection.main;
      view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: markdown,
        },
        selection: { anchor: selection.from + markdown.length },
      });

      this.emit("cf-file-paste", { files: storedFiles });
    } catch (error) {
      this.emit("cf-error", {
        error: error as Error,
        message: "Failed to store pasted image",
      });
    }
  }

  /**
   * Extract mentioned pieces from current content and write to `$mentioned`.
   *
   * Link syntax: [[Name (id)]]. We parse ids and resolve them against
   * `$mentionable` to produce live Piece instances.
   */
  private _updateMentionedFromContent(content?: string): void {
    if (!this.mentioned) return;
    content ??= this._editorView?.state.doc.toString() ?? this.getValue() ?? "";
    if (this._mentionResolutionPending) {
      this._deferredMentionedContent = content;
      return;
    }

    if (this._refMode) {
      this._updateMentionedWithRefs(content);
      return;
    }

    // Extract IDs from content
    const newIds = this._extractMentionedIds(content);

    // Get current mentioned IDs by looking them up in mentionable
    const curIds = this._getCurrentMentionedIds();

    // Compare ID sets to avoid unnecessary writes
    if (newIds.size === curIds.size) {
      let same = true;
      for (const id of newIds) {
        if (!curIds.has(id)) {
          same = false;
          break;
        }
      }
      if (same) {
        return; // No change
      }
    }

    // Resolve IDs to Mentionable values and update the cell
    const newMentioned = this._extractMentionedPieces(content);
    this.mentioned.set(newMentioned);
    this._setupPieceNameSubscriptions();
  }

  /**
   * Write `$mentioned` from both mention forms at once.
   *
   * A document mid-migration holds wiki-links and references together, and a
   * destination reached either way is mentioned either way. The signature
   * guard stands in for the wiki-link path's id comparison, which cannot see a
   * reference: it stays unset while any key is still unresolved, so the write
   * is retried once the map catches up.
   */
  private _updateMentionedWithRefs(content: string): void {
    const refs = this._documentRefs();
    const wikiIds = this._extractMentionedIds(content);
    // The signature carries each key's DESTINATION, not just the key. A host
    // that repoints a key at another piece changes nothing about the document,
    // so a key-only signature would match and leave `$mentioned` — and every
    // consumer indexing off it — attached to the piece that is no longer named.
    const signature = `${[...wikiIds].join(",")}|${
      refs.map((ref) => `${ref.key}=${this._refDestinationId(ref.key)}`).join(
        ",",
      )
    }`;
    if (signature === this._lastMentionedSignature) return;

    const destinations = this._refMentionedPieces(refs);
    const resolvedEverything = destinations.length ===
      new Set(refs.map((ref) => ref.key)).size;
    this._lastMentionedSignature = resolvedEverything ? signature : null;

    // One entry per destination, however many mentions name it. The backlinks
    // index pushes a backlink per entry, so a piece mentioned twice — or once
    // in each form — would otherwise be linked back twice.
    this.mentioned?.set(
      dedupeByDestination(
        [...this._extractMentionedPieces(content), ...destinations],
        (piece) => isCellHandle(piece) ? piece.id() : undefined,
      ),
    );
    this._setupPieceNameSubscriptions();
    this._setupRefDestinationSubscriptions();
  }

  /**
   * Extract unique piece IDs from content backlinks.
   */
  private _extractMentionedIds(content: string): Set<string> {
    const ids = new Set<string>();
    const regex = /\[\[[^\]]*?\(([^)]+)\)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const id = match[1];
      if (id) ids.add(id);
    }
    return ids;
  }

  /**
   * Get IDs of currently mentioned pieces by looking them up in mentionable.
   */
  private _getCurrentMentionedIds(): Set<string> {
    const curIds = new Set<string>();
    const mentionedHandle = this.mentioned;
    if (!mentionedHandle) return curIds;

    const currentSource = (mentionedHandle.get() ?? []) as MentionableArray;

    const mentionableHandle = this.mentionable;
    if (!mentionableHandle) return curIds;

    const mentionableData = (mentionableHandle.get() ?? []) as MentionableArray;

    // For each current mentioned value, find its ID by matching in mentionable
    for (const mentionedValue of currentSource) {
      if (!mentionedValue) continue;
      for (let i = 0; i < mentionableData.length; i++) {
        if (mentionableData[i] === mentionedValue) {
          const pieceId = this._getPieceId(i);
          if (pieceId) curIds.add(pieceId);
          break;
        }
      }
    }

    return curIds;
  }

  /**
   * Set up subscriptions to piece TITLE cells for bidirectional sync.
   * We subscribe to title (not NAME) because:
   * - We UPDATE title when user edits backlink in doc
   * - NAME is computed from title, so subscribing to NAME would cause feedback loops
   * - By subscribing to title with same changeGroup, our own edits are filtered out
   */
  private _setupPieceNameSubscriptions(): void {
    if (!this._editorView) return;

    const backlinks = this._editorView.state.field(backlinkField);
    const activeIds = new Set<string>();

    for (const bl of backlinks) {
      if (!bl.id) continue;
      activeIds.add(bl.id);

      // Skip if already subscribed
      if (this._pieceNameSubscriptions.has(bl.id)) continue;

      const pieceCell = this.findPieceById(bl.id);
      if (!pieceCell) continue;

      // Subscribe to TITLE cell (not NAME) - this is what we update
      const titleCell = pieceCell.key("title");
      const pieceId = bl.id;

      // Subscribe with changeGroup so our own edits are filtered out
      const unsub = titleCell.subscribe(() => {
        void this._handleExternalTitleChange(pieceId, pieceCell);
      });

      this._pieceNameSubscriptions.set(pieceId, unsub);
    }

    // Clean up subscriptions for pieces no longer in document
    for (const [id, unsub] of this._pieceNameSubscriptions) {
      if (!activeIds.has(id)) {
        unsub();
        this._pieceNameSubscriptions.delete(id);
      }
    }
  }

  /**
   * Handle external title change from a piece - update the pill text in the document.
   * This is called when a piece's title field changes externally (not from our own edit).
   */
  private async _handleExternalTitleChange(
    pieceId: string,
    pieceCell: CellHandle<Mentionable>,
  ): Promise<void> {
    if (!this._editorView) return;

    const transition = this._collaborationTransition;
    if (transition !== undefined) {
      await transition.catch(() => undefined);
      return await this._handleExternalTitleChange(pieceId, pieceCell);
    }
    const collaboration = this._collaboration;
    if (collaboration !== undefined) {
      if (!collaboration.active) return;
      // A semantic rewrite has to be the first unconfirmed local update for
      // CodeMirror to acknowledge another client's copy. Confirm ordinary
      // local edits first, then recompute the rewrite against the latest doc.
      if (!await collaboration.prepareExternalChange()) return;
      if (
        this._collaboration !== collaboration || !collaboration.active ||
        !this._editorView
      ) return;
    }

    // Get the piece's title (without emoji prefix)
    const title = pieceCell.key("title").get() as string;
    if (!title) return;

    // Find backlink in document
    const backlinks = this._editorView.state.field(backlinkField);
    const bl = backlinks.find((b) => b.id === pieceId);
    if (!bl) return;

    // Strip emoji from document name for comparison
    const docNameStripped = bl.name.replace(/^(?:📝|📓|📁|🗒️|🗒)\s*/, "");

    // Skip if stripped names match (no actual title change)
    if (docNameStripped === title) return;

    // Get the full NAME (with emoji) to insert into document
    const currentName = pieceCell.key(NAME).get() as string;
    if (!currentName) return;

    // Update tracking map BEFORE dispatch so _detectAndSyncNameChanges doesn't
    // try to sync this change back to the piece (it runs synchronously during dispatch)
    this._previousBacklinkNames.set(pieceId, currentName);

    const oldDocValue = this._editorView.state.doc.toString();

    // Update the editor without routing through the generic update listener.
    // The collaboration path submits this ChangeSet directly below; the
    // ordinary path writes through CellController as before.
    this._editorView.dispatch({
      changes: { from: bl.nameFrom, to: bl.nameTo, insert: currentName },
      annotations: CFCodeEditor._cellSyncAnnotation.of(true),
      effects: codeMirrorRewriteDedupeEffect.of(
        JSON.stringify(["backlink-title", pieceId, bl.name, currentName]),
      ),
    });

    // Record the rewrite as a local edit through the CellController so it merges
    // with any pending debounced edit and the controller's pending-edit view
    // stays consistent with the document. Then flush: this is a remote change,
    // not user input, so it must persist without waiting on the input-timing
    // strategy — the blur strategy would otherwise hold it until the next
    // focus/blur cycle, and a rewrite that arrives while the editor is
    // unfocused would never be written.
    const newDocValue = this._editorView.state.doc.toString();
    if (collaboration !== undefined) {
      await collaboration.localDocChanged();
      this.emit("cf-change", {
        value: newDocValue,
        oldValue: oldDocValue,
        language: this.language,
      });
      this._updateMentionedFromContent();
      return;
    }
    this.setValue(newDocValue);
    this._cellController.flush();
  }

  /**
   * Clean up all piece NAME subscriptions.
   */
  private _cleanupPieceNameSubscriptions(): void {
    for (const unsub of this._pieceNameSubscriptions.values()) {
      unsub();
    }
    this._pieceNameSubscriptions.clear();
  }

  /**
   * Take the document's references as the baseline for label changes and for
   * collection. Called when the map binding changes and whenever content
   * arrives from outside, both of which replace what "already there" means.
   */
  private _initializeRefTracking(): void {
    if (!this.references || !this._editorView) return;

    this._refKeysAtLoad = scanRefKeys(this._editorView.state.doc.toString());
    this._previousRefLabels = new Map(
      this._documentRefs().map((ref) => [ref.key, ref.label]),
    );
  }

  /** Reconcile the reference map with the document after an edit. */
  private _syncMentionRefs(): void {
    if (!this.references || !this._editorView) return;

    this._detectRefLabelChanges();
    this._collectUnreferencedRefEntries();
    this._setupRefDestinationSubscriptions();
  }

  /**
   * Record a label the user edited.
   *
   * A label that no longer reads as the destination's name is the user's
   * wording, and `modifiedTitle` is what says so: while it is set, a change to
   * the destination's title leaves the label alone. Editing the label back
   * into agreement clears it again, so the flag tracks divergence rather than
   * accumulating a history of edits.
   */
  private _detectRefLabelChanges(): void {
    const map = this.references;
    if (!map) return;

    const entries = this._refMap();
    const current = new Map<string, string>();

    for (const ref of this._documentRefs()) {
      current.set(ref.key, ref.label);

      const previous = this._previousRefLabels.get(ref.key);
      if (previous === undefined || previous === ref.label) continue;

      const entry = entries[ref.key];
      if (!entry) continue;

      const name = this._refNames.get(ref.key);
      // Against the name AS A LABEL, not the raw name: a destination named
      // with a `]` is written into the token in the shape the parser reads,
      // and comparing against the raw form would find every such mention
      // permanently diverged and stop its renames from ever arriving.
      const modifiedTitle = name === undefined
        ? true
        : ref.label !== labelForToken(name);

      // Only the WRITE is conditional. Every label edit is an edit, including
      // one custom wording replacing another, and a listener told the event
      // fires on a label change would otherwise stop hearing about a mention
      // after the first time the user renamed it.
      if (!!entry.modifiedTitle !== modifiedTitle) {
        map.key(ref.key).key("modifiedTitle").set(modifiedTitle);
      }

      this.emit("mention-ref-label-changed", {
        key: ref.key,
        label: ref.label,
        modifiedTitle,
        destination: this._refDestination(ref.key),
      });
    }

    this._previousRefLabels = current;
  }

  /**
   * Drop map entries whose token has left the document.
   *
   * Only keys this editor saw at load or minted itself are eligible. A key
   * another client added while this one was open is one this editor has no
   * reason to believe was ever in its document, and the conservative reading
   * keeps it.
   */
  private _collectUnreferencedRefEntries(): void {
    const map = this.references;
    if (!map || this._refKeysAtLoad === null || !this._editorView) return;

    const doc = this._editorView.state.doc.toString();
    // A document that has not loaded names nothing, which is not the same as
    // a document that names nothing.
    if (doc.length === 0) return;

    const present = scanRefKeys(doc);
    const entries = this._refMap();
    const removable = [...this._refKeysAtLoad].filter((key) =>
      !present.has(key) && key in entries
    );
    if (removable.length === 0) return;

    // Removal inverts the map-first ordering that inserting a mention uses.
    // The deletion that made these entries collectable is sitting in the
    // content cell's debounce, or waiting on blur; dropping the entries now
    // and then losing that write to a disconnect would leave the durable
    // document holding a token whose destination this just deleted. Flushing
    // first means the worst interruption leaves an unreferenced entry, which
    // the next collection removes.
    this._cellController.flush();

    for (const key of removable) {
      // Per key, rather than writing the whole map back. A blind write of a
      // snapshot would take an entry another client added between the read
      // and the write down with it.
      map.key(key).set(undefined as unknown as MentionRef);
      this._refKeysAtLoad.delete(key);
    }
  }

  /**
   * Subscribe to each referenced destination, so a rename elsewhere reaches
   * the label here.
   *
   * The subscription is on the destination rather than on its `title`, and
   * that is what makes the name readable at all: a destination arrives here as
   * a bare link with nothing cached, so `key(NAME).get()` on it has no value
   * to return until a subscription under a schema naming NAME has delivered
   * one. The wiki-link form's reason for watching `title` instead — that it
   * writes NAME's source and would otherwise hear its own echo — does not
   * apply here, because this form never writes the destination.
   */
  private _setupRefDestinationSubscriptions(): void {
    if (!this.references || !this._editorView) return;

    const activeKeys = new Set<string>();

    for (const ref of this._documentRefs()) {
      activeKeys.add(ref.key);

      const id = this._refDestinationId(ref.key);
      const existing = this._refDestinationSubscriptions.get(ref.key);
      // A key whose destination has been repointed keeps its subscription to
      // the piece it used to name: renames of the old piece would rewrite this
      // label, and renames of the new one would never arrive.
      if (existing) {
        if (existing.id === id) continue;
        existing.unsub();
        this._refDestinationSubscriptions.delete(ref.key);
        this._refNames.delete(ref.key);
      }

      const destination = this._refDestination(ref.key);
      if (!destination) continue;

      const key = ref.key;
      this._refDestinationSubscriptions.set(key, {
        id,
        unsub: destination.subscribe((value) => {
          const name = (value as Mentionable | undefined)?.[NAME];
          if (typeof name !== "string" || name.length === 0) return;
          this._refNames.set(key, name);
          // Deferred, because this reaches a dispatch synchronously — an
          // `async` body runs to its first `await`, and there is none before
          // the rewrite when no collaboration is active — and this callback
          // can be running inside an update: a subscription delivers the
          // moment it is opened, and this pass can run from the update
          // listener.
          queueMicrotask(() =>
            void this._handleExternalRefTitleChange(key, name)
          );
        }),
      });
    }

    for (const [key, subscription] of this._refDestinationSubscriptions) {
      if (!activeKeys.has(key)) {
        subscription.unsub();
        this._refDestinationSubscriptions.delete(key);
        this._refNames.delete(key);
      }
    }

    // The keys the document holds, and the destination each names, decide
    // the short names as much as the universe does.
    this._publishRefShortNames();
  }

  /**
   * Returns the short name each of the document's mentions shows, by reference
   * key: the name carried by the universe row standing for the mention's
   * destination.
   *
   * The row is found by identity, comparing the cell the reference map names
   * with the one the resolution pass recorded for each row through
   * `cellRefToIdentityKey()`, whose doc comment carries what a cell's identity
   * is and why it is not `CellHandle.equals()`. What matters to a pill is that
   * a handle redelivered mid-settle names the same cell as the one it
   * replaced, so a pill keeps its name across a redelivery rather than
   * blinking out. The name is the row's, never one the destination
   * publishes. A destination publishes the name its creating
   * collection gave it, which means something only where that collection is
   * read through (`docs/specs/collection-naming.md`, "The name a member
   * publishes"). The row's is what this universe calls the member, and the
   * one a `#` query here matches, so a name returned is one that query offers
   * back for the same destination. A mention whose destination no resolved
   * row stands for gets none, whatever its destination publishes. Where
   * several rows stand for one destination, the first in the universe's order
   * that carries a name is the one returned.
   */
  private _universeShortNames(): Record<string, string> {
    // Without a map no token in the document is a mention, so there is
    // nothing to name.
    if (!this.references) return {};

    const rows = (this.mentionable?.get() ?? []) as MentionableArray;
    const namesByPiece = new Map<string, string>();
    for (let index = 0; index < rows.length; index++) {
      const pieceCell = this._resolvedPieceCells.get(index);
      const name = shortNameOf(rows[index]);
      // A row the pass could not resolve to a cell stands for nothing, and
      // its own sub-cell is not the member.
      if (pieceCell === undefined || pieceCell.id() === "" || name === "") {
        continue;
      }
      const identity = cellRefToIdentityKey(pieceCell.ref());
      if (namesByPiece.has(identity)) continue;
      namesByPiece.set(identity, name);
    }

    const names: Record<string, string> = {};
    const refMap = this._refMap();
    for (const ref of this._documentRefs()) {
      const destination = refMap[ref.key]?.destination;
      if (!isCellHandle(destination)) continue;
      const name = namesByPiece.get(cellRefToIdentityKey(destination.ref()));
      if (name !== undefined) names[ref.key] = name;
    }
    return names;
  }

  /**
   * Brings the editor state into step with the short name each mention shows.
   *
   * Nothing holds the names between publications. Each one reads them afresh
   * through `_universeShortNames()`, and what decides whether to dispatch is a
   * comparison against the FIELD. A caller therefore has nothing to keep in
   * step by hand: whatever it changed — the document's mentions, the map, or
   * the universe's resolved rows — a publication after it leaves the view
   * showing what those say now, and a name nothing backs any more is dropped
   * rather than kept.
   */
  private _publishRefShortNames(): void {
    if (this._refShortNamesPublishPending) return;
    this._refShortNamesPublishPending = true;
    // Off the current task, because a caller may be inside a CodeMirror
    // update: the subscription pass runs from the update listener. A dispatch
    // nested in an update can throw, taking the reference reconciliation
    // around it with it. A microtask rather than a timer — the update is
    // synchronous, so it has finished by the time this runs, and nothing here
    // waits on the clock. Queueing one publication for many calls is the other
    // half: a pass that changes ten keys dispatches once.
    queueMicrotask(() => {
      this._refShortNamesPublishPending = false;
      const view = this._editorView;
      if (!view) return;

      const published = this._universeShortNames();
      if (sameShortNames(refShortNames(view.state), published)) return;
      view.dispatch({ effects: setRefShortNames.of(published) });
    });
  }

  /**
   * Rewrite a label after its destination was renamed elsewhere — unless the
   * user has claimed that label, which is the whole point of `modifiedTitle`.
   */
  private async _handleExternalRefTitleChange(
    key: string,
    name: string,
  ): Promise<void> {
    if (!this._editorView) return;

    const transition = this._collaborationTransition;
    if (transition !== undefined) {
      await transition.catch(() => undefined);
      return await this._handleExternalRefTitleChange(key, name);
    }
    const collaboration = this._collaboration;
    if (collaboration !== undefined) {
      if (!collaboration.active) return;
      if (!await collaboration.prepareExternalChange()) return;
      if (
        this._collaboration !== collaboration || !collaboration.active ||
        !this._editorView
      ) return;
    }
    if (this._refMap()[key]?.modifiedTitle) return;

    const ref = this._documentRefs().find((candidate) => candidate.key === key);
    if (!ref || ref.label === labelForToken(name)) return;

    // Update tracking BEFORE the dispatch, so the label-change detector does
    // not read this rewrite as the user's own edit and flip the flag.
    const safe = labelForToken(name);
    this._previousRefLabels.set(key, safe);

    const oldDocValue = this._editorView.state.doc.toString();
    this._editorView.dispatch({
      changes: { from: ref.labelFrom, to: ref.labelTo, insert: safe },
      annotations: CFCodeEditor._cellSyncAnnotation.of(true),
      effects: codeMirrorRewriteDedupeEffect.of(
        JSON.stringify(["reference-title", key, ref.label, safe]),
      ),
    });

    // Record the rewrite through the CellController so it merges with any
    // pending debounced edit, then flush: this is a remote change rather than
    // user input, and the blur strategy would otherwise hold it until the next
    // focus/blur cycle.
    const newDocValue = this._editorView.state.doc.toString();
    if (collaboration !== undefined) {
      await collaboration.localDocChanged();
      this.emit("cf-change", {
        value: newDocValue,
        oldValue: oldDocValue,
        language: this.language,
      });
      this._updateMentionedFromContent();
      return;
    }
    this.setValue(newDocValue);
    this._cellController.flush();
  }

  /** The destinations of the document's references, as live cells. */
  private _refMentionedPieces(refs: MentionRefInfo[]): Mentionable[] {
    const seen = new Set<string>();
    const result: Mentionable[] = [];

    for (const ref of refs) {
      if (seen.has(ref.key)) continue;
      const destination = this._refDestination(ref.key);
      if (!destination) continue;
      seen.add(ref.key);
      result.push(destination as unknown as Mentionable);
    }

    return result;
  }

  /**
   * Parse content to a list of unique Pieces referenced by [[...]] links.
   */
  private _extractMentionedPieces(content: string): Mentionable[] {
    if (!content || !this.mentionable) return [];

    const ids: string[] = [];
    const regex = /\[\[[^\]]*?\(([^)]+)\)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const id = match[1];
      if (id) ids.push(id);
    }

    // Resolve unique ids to pieces using mentionable list.
    // Push CellHandles (not plain values) so the pattern system receives
    // live cell references that backlinks-index can traverse.
    const seen = new Set<string>();
    const result: Mentionable[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const piece = this.findPieceById(id);
      if (piece) {
        // Push the CellHandle itself — it serializes as a link (via toJSON)
        // so the runtime resolves it to the actual piece cell, preserving
        // reactive connections for backlinks computation.
        result.push(piece as unknown as Mentionable);
        seen.add(id);
      }
    }
    return result;
  }

  /**
   * Detect name changes in backlinks and sync them to linked piece's NAME property.
   * Called when document changes.
   */
  private _detectAndSyncNameChanges(): void {
    if (!this._editorView) return;

    const backlinks = this._editorView.state.field(backlinkField);
    const currentNames = new Map<string, string>();

    for (const bl of backlinks) {
      if (!bl.id) continue;
      currentNames.set(bl.id, bl.name);

      const previousName = this._previousBacklinkNames.get(bl.id);
      if (previousName !== undefined && previousName !== bl.name) {
        // Name changed! Update the piece's NAME property
        this._updatePieceName(bl.id, bl.name, previousName);
      }
    }

    this._previousBacklinkNames = currentNames;
  }

  /**
   * Update a piece's name when the backlink text changes.
   * Tries to update 'title' field first (for patterns where NAME is computed),
   * then falls back to NAME directly.
   */
  private _updatePieceName(
    pieceId: string,
    newName: string,
    oldName: string,
  ): void {
    const pieceCell = this.findPieceById(pieceId);
    if (!pieceCell) {
      console.warn(
        `[cf-code-editor] Cannot update name: piece ${pieceId} not found`,
      );
      return;
    }

    // Strip common emoji prefixes to get the raw title
    // Use alternation instead of character class - emoji are multi-codepoint
    const titleValue = newName.replace(/^(?:📝|📓|📁|🗒️|🗒)\s*/, "");

    // Update 'title' field - for note patterns, NAME is computed from title
    // (NAME = `📝 ${title}`) so setting title will update NAME automatically
    pieceCell.key("title").set(titleValue);

    this.emit("backlink-name-changed", {
      pieceId,
      oldName,
      newName,
      piece: pieceCell,
    });
  }
}
