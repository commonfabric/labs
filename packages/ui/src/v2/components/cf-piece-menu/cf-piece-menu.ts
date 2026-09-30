import {
  getPieceBoundary,
  subscribePieceBoundary,
} from "@commonfabric/html/client";
import type { DID } from "@commonfabric/identity";
import { assertNotDID, isDID } from "@commonfabric/identity/did";
import {
  appViewToUrlPath,
  navigate,
  type NavigationCommand,
  openInNewTab,
  preserveAppViewMode,
  urlToAppView,
} from "@commonfabric/navigation";
import { parseFabricRef } from "@commonfabric/runner/shared";
import {
  $conn,
  CellHandle,
  isCellHandle,
  RequestType,
} from "@commonfabric/runtime-client";
import type {
  JSONValue,
  PieceSourceAction,
  PieceSourceRevisionSourceView,
  PieceSourceRevisionView,
  PieceSourceView,
  RuntimeClient,
  SpaceAclCapability,
  SpaceAclView,
} from "@commonfabric/runtime-client";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import { state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { BaseElement } from "../../core/base-element.ts";
import {
  describeFollowState,
  describeOrigin,
  describeSourceFailure,
  type FollowDescription,
  formatTimestamp,
  patternRefLabel,
} from "./origin-view.ts";

/** The marker on the rendered piece while its built-in menu is open. */
export const PIECE_MENU_OPEN_ATTRIBUTE = "data-cf-piece-menu-open";

/** Which panel is showing, if any. */
export type Panel = "source" | "origin" | "data" | "actions" | "access";

/** One entry in the menu, and the panel it opens. */
interface MenuEntry {
  label: string;

  /** Stable hook for tests, exposed as the entry's `test-id`. */
  testId: string;

  panel: Panel;
}

const ENTRIES: readonly MenuEntry[] = [
  { label: "View source", testId: "piece-menu-source", panel: "source" },
  {
    label: "Origin and history",
    testId: "piece-menu-origin",
    panel: "origin",
  },
  { label: "Data", testId: "piece-menu-data", panel: "data" },
  { label: "Actions", testId: "piece-menu-actions", panel: "actions" },
];

const PANEL_TITLES: Record<Panel, string> = {
  source: "Source",
  origin: "Origin and history",
  data: "Data",
  actions: "Actions",
  access: "Space access rights",
};

const SPACE_ACCESS_ENTRY: MenuEntry = {
  label: "Space access rights...",
  testId: "piece-menu-space-access",
  panel: "access",
};

const DETACH_ENTRY = {
  label: "Stop following source",
  testId: "piece-menu-detach-source",
  action: "detach",
} as const;

const CLONE_FRESH_ENTRY = {
  label: "Clone fresh piece into new space",
  testId: "piece-menu-clone-fresh",
  action: "clone-fresh",
} as const;

const CLONE_WITH_DATA_ENTRY = {
  label: "Clone piece and copy data into new space",
  testId: "piece-menu-clone-copy-data",
  action: "clone-copy-data",
} as const;

type CloneMode = "fresh" | "copy-data";

type PieceMenuEntry =
  | MenuEntry
  | typeof CLONE_FRESH_ENTRY
  | typeof CLONE_WITH_DATA_ENTRY
  | typeof DETACH_ENTRY;

/** The entries a piece menu shows, including its lifecycle actions. */
export function pieceMenuEntries(
  hasOrigin = false,
): readonly PieceMenuEntry[] {
  return hasOrigin
    ? [...ENTRIES, CLONE_FRESH_ENTRY, CLONE_WITH_DATA_ENTRY, DETACH_ENTRY]
    : [...ENTRIES, CLONE_FRESH_ENTRY, CLONE_WITH_DATA_ENTRY];
}

/**
 * Whether a schema fragment declares a directly dispatchable stream. Only the
 * OUTERMOST `asCell` entry names the immediate kind: `["cell", "stream"]` is
 * a cell that contains a stream, and sending to that outer cell would be a
 * plain value write, not a dispatch.
 */
function schemaDeclaresStream(schema: unknown): boolean {
  const asCell = (schema as { asCell?: unknown } | null | undefined)?.asCell;
  if (!Array.isArray(asCell) || asCell.length === 0) return false;
  const outermost = asCell[0];
  return (typeof outermost === "string"
    ? outermost
    : (outermost as { kind?: string } | null)?.kind) === "stream";
}

/**
 * A handler stream whose own ref schema carries the `asCell: ["stream"]`
 * marker. This is not the usual live shape — a handler read through the
 * piece's schema arrives as a `CellHandle` carrying the handler's *event*
 * schema, and the stream declaration stays on the piece schema's property —
 * so callers also consult the parent schema (see `collectActions`).
 */
export function isStreamHandle(value: unknown): value is CellHandle {
  return isCellHandle(value) && schemaDeclaresStream(value.ref().schema);
}

/** Well-known view keys the Data panel omits: they hold VDOM, not data. */
const VIEW_KEYS = new Set(["$UI", "$TILE_UI", "$CHIP_UI"]);

/**
 * A read piece value is not plain JSON: links arrive hydrated as nested
 * `CellHandle`s, whose own toJSON would print verbose sigil links. Walk the
 * value into a display shape first — handles become `{"@cell": id}` stubs,
 * streams a `[stream]` tag — and cap the depth so a deep graph stays legible.
 */
export function formatPieceValue(
  value: unknown,
  streamKeys?: ReadonlySet<string>,
): string {
  const display = toDisplay(value, 0, streamKeys);
  if (display === undefined) return "undefined";
  try {
    return JSON.stringify(display, null, 2) ?? String(display);
  } catch (error) {
    return `<unrenderable: ${
      error instanceof Error ? error.message : String(error)
    }>`;
  }
}

function toDisplay(
  value: unknown,
  depth: number,
  streamKeys?: ReadonlySet<string>,
): unknown {
  if (isStreamHandle(value)) return "[stream]";
  if (isCellHandle(value)) {
    const ref = value.ref();
    return ref.path.length > 0
      ? { "@cell": ref.id, path: ref.path.join("/") }
      : { "@cell": ref.id };
  }
  if (depth >= 8) return "…";
  if (Array.isArray(value)) {
    return value.map((item) => toDisplay(item, depth + 1));
  }
  // TODO(danfuzz): a `FabricSpecialObject` reaches this branch and is rebuilt
  // from enumerable properties it does not have, so a `FabricBytes` in an
  // argument or result renders as `{}`. The guard wants to be a shape test
  // (`isPlainObject`) with the special objects named by
  // `toCompactDebugString()` instead of descended. The value arrives intact --
  // the connection carries it as a `codec-realm` encoding, class and all -- so
  // this walk is the only place it is lost.
  if (isObjectOrArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (depth === 0 && VIEW_KEYS.has(key)) continue;
      out[key] = depth === 0 && streamKeys?.has(key)
        ? "[stream]"
        : toDisplay(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** One dispatchable handler stream found on the piece. */
export interface PieceAction {
  name: string;

  /** Which side of the piece carries it. */
  source: "result" | "argument";

  handle: CellHandle;

  /**
   * The event schema the handler declares, when one is known: the schema a
   * stream handle read through the piece's schema carries is the handler's
   * payload shape.
   */
  eventSchema?: unknown;
}

/** The top-level property names of an event schema, as a payload hint. */
export function payloadHint(action: PieceAction): string | undefined {
  const properties =
    (action.eventSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
  if (!properties) return undefined;
  const names = Object.keys(properties);
  return names.length > 0 ? `{ ${names.join(", ")} }` : undefined;
}

/**
 * CFPieceMenu — the menu a right-click opens on a space, and usually on a
 * piece in it. Its piece entries hold the panels for what it can show and do
 * about that piece: the authored source, the origin and history it records,
 * the live argument and result data, and the handler streams an event can be
 * dispatched to. Below a divider it names the space and shows its access
 * rights, which space owners can change.
 *
 * Opened on a space alone — over a surface no piece loaded into — the first
 * heading reads "Piece unavailable", every entry needing a piece is disabled,
 * and the space entries stay live.
 *
 * @element cf-piece-menu
 *
 * Mounted on `document.body` by {@link openPieceMenu}, never inside the piece
 * it describes: a piece's own `overflow: hidden` would clip it, and the tile
 * variant's `transform: scale(0.5)` would both contain and shrink a
 * `position: fixed` overlay rendered in that subtree.
 *
 * A host that wants a different menu for a piece cancels the
 * `cf-piece-context-menu` announcement and shows its own; see
 * `docs/features/host-embedding.md`.
 */
export class CFPieceMenu extends BaseElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: block;
      font-family: var(--cf-theme-font-family, system-ui, sans-serif);
      color: var(--cf-theme-color-text, #111827);
    }

    :host([hidden]) {
      display: none;
    }

    .backdrop {
      position: absolute;
      inset: 0;
      z-index: 1;
    }

    .backdrop.dimmed {
      background: rgba(0, 0, 0, 0.32);
    }

    /* A dialog raised over an open panel, and the backdrop that separates the
      two. Both sit above the panel's own layer so the panel stays visible
      and inert behind them. */
    .backdrop.stacked {
      z-index: 3;
    }

    .panel.stacked {
      z-index: 4;
      width: min(34rem, 92vw);
    }

    .menu {
      position: absolute;
      z-index: 2;
      min-width: 15rem;
      padding: 0.25rem;
      background: var(--cf-theme-color-surface, #ffffff);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 0 3px rgba(0, 0, 0, 0.16);
    }

    .menu-item {
      display: block;
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: none;
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.8125rem;
      color: inherit;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }

    .menu-item:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .menu-item:enabled:hover,
    .menu-item:focus-visible {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .menu-title {
      padding: 0.375rem 0.75rem;
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      max-width: 18rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .menu-divider {
      margin: 0.25rem 0.5rem;
      border-top: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
    }

    .panel {
      position: absolute;
      z-index: 2;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      width: min(56rem, 92vw);
      max-height: 86vh;
      background: var(--cf-theme-color-surface, #ffffff);
      border-radius: 12px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
      overflow: hidden;
    }

    .nested-piece-highlight {
      position: fixed;
      z-index: 0;
      pointer-events: none;
      background-color: rgba(99, 102, 241, 0.14);
      background-image: linear-gradient(
        135deg,
        rgba(255, 255, 255, 0) 26%,
        rgba(255, 255, 255, 0.64) 48%,
        rgba(103, 232, 249, 0.36) 54%,
        rgba(255, 255, 255, 0) 72%
      );
      background-position: 200% 0;
      background-repeat: no-repeat;
      background-size: 250% 100%;
      box-shadow: inset 0 0 2.5rem rgba(129, 140, 248, 0.38);
      animation: cf-nested-piece-menu-shine 1.7s ease-in-out;
    }

    @keyframes cf-nested-piece-menu-shine {
      from {
        background-position: 200% 0;
      }
      to {
        background-position: -200% 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .nested-piece-highlight {
        animation: none;
        background-position: 50% 0;
      }
    }

    @media (forced-colors: active) {
      .nested-piece-highlight {
        forced-color-adjust: none;
        background-color: transparent;
        background-image: linear-gradient(
          135deg,
          transparent 26%,
          Highlight 48%,
          transparent 72%
        );
        box-shadow: inset 0 0 0 0.25rem Highlight;
      }
    }

    .panel-head {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
    }

    .panel-head h2 {
      margin: 0;
      font-size: 0.9375rem;
    }

    .panel-head .subject {
      flex: 1;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-close {
      padding: 0.25rem 0.5rem;
      border: none;
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.875rem;
      color: inherit;
      cursor: pointer;
    }

    .panel-close:hover {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .panel-foot {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem;
      padding: 0.875rem 1.25rem;
      border-top: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
    }

    .panel-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 1rem 1.25rem;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .clone-status {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-height: 2rem;
    }

    .clone-status progress {
      width: 8rem;
    }

    .clone-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1rem;
    }

    .file-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      padding: 0.5rem 1.25rem 0;
    }

    .file-tab {
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      cursor: pointer;
    }

    .file-tab.active {
      color: inherit;
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    pre.source {
      margin: 0;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
      tab-size: 2;
    }

    dl.facts {
      display: grid;
      grid-template-columns: minmax(8rem, max-content) 1fr;
      gap: 0.375rem 1rem;
      margin: 0;
      font-size: 0.8125rem;
    }

    dl.facts dt {
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    dl.facts dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
    }

    dl.facts dd.prose {
      font-family: inherit;
    }

    .text-link {
      color: inherit;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 0.12em;
    }

    .note {
      margin: 1rem 0 0;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .error {
      margin: 0.75rem 0 0;
      font-size: 0.8125rem;
      color: var(--cf-theme-color-error, #b91c1c);
      overflow-wrap: anywhere;
    }

    .status {
      margin: 0.75rem 0 0;
      font-size: 0.8125rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .section-title {
      margin: 0 0 0.5rem;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .section-title + p,
    pre.source + .section-title {
      margin-top: 1rem;
    }

    .payload-label {
      display: block;
      margin-bottom: 0.75rem;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .payload {
      display: block;
      width: 100%;
      min-height: 4rem;
      margin-top: 0.25rem;
      padding: 0.5rem;
      box-sizing: border-box;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: none;
      color: inherit;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 12px;
      resize: vertical;
    }

    .actions-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .action-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.375rem 0.5rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
      border-radius: 6px;
    }

    .action-name {
      flex: 1;
      min-width: 6rem;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 0.8125rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .action-hint {
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 18rem;
    }

    .action-source {
      font-size: 0.6875rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .action-send,
    .refresh {
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.75rem;
      color: inherit;
      cursor: pointer;
    }

    .action-send:hover,
    .refresh:hover {
      background: var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.06));
    }

    .history {
      margin-top: 1.25rem;
    }

    .history h3 {
      margin: 0 0 0.625rem;
      font-size: 0.8125rem;
    }

    .revision {
      display: grid;
      gap: 0.375rem;
      padding: 0.75rem 0;
      border-top: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
      font-size: 0.75rem;
    }

    .revision-head,
    .revision-actions,
    .warning-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .revision-head {
      justify-content: space-between;
    }

    .revision-details {
      color: var(--cf-theme-color-text-muted, #6b7280);
      overflow-wrap: anywhere;
    }

    .revision button,
    .source-action,
    .warning button {
      padding: 0.3rem 0.625rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: var(--cf-theme-color-surface, #ffffff);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .revision button.text-link {
      padding: 0;
      border: 0;
      border-radius: 0;
      background: none;
      color: inherit;
      font: inherit;
    }

    .revision button:disabled,
    .source-action:disabled,
    .warning button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .warning {
      margin: 1rem 0;
      padding: 0.75rem;
      border: 1px solid var(--cf-theme-color-error, #b91c1c);
      border-radius: 8px;
      font-size: 0.75rem;
    }

    .follow-state {
      margin: 1rem 0;
      padding: 0.75rem;
      border: 1px solid var(--cf-theme-color-error, #b91c1c);
      border-radius: 8px;
      font-size: 0.75rem;
    }

    .follow-state.note-state {
      border-color: var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
    }

    .follow-state p {
      margin: 0 0 0.625rem;
    }

    .follow-state p:last-child {
      margin-bottom: 0;
    }

    /* A compiler's report arrives with its own line breaks, and keeping them
      is what makes it readable. Only this line keeps them: elsewhere the
      template's own indentation would come through with them. */
    .follow-reason {
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .follow-reason span {
      font-family: var(--cf-theme-font-family, sans-serif);
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .source-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin: 1rem 0 0;
    }

    .origin-entry-label {
      display: block;
      font-size: 0.8125rem;
      color: var(--cf-theme-color-text-muted, #6b7280);
    }

    .origin-entry-input {
      display: block;
      width: 100%;
      margin-top: 0.75rem;
      box-sizing: border-box;
    }

    .warning p {
      margin: 0 0 0.625rem;
      white-space: pre-wrap;
    }

    .access-summary {
      margin: 0 0 1rem;
      font-size: 0.8125rem;
    }

    .access-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
    }

    .access-table th,
    .access-table td {
      padding: 0.5rem;
      border-bottom: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.1));
      text-align: left;
      vertical-align: middle;
    }

    .access-table th {
      color: var(--cf-theme-color-text-muted, #6b7280);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .access-user {
      overflow-wrap: anywhere;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
    }

    .access-controls {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem;
    }

    .access-select,
    .access-input,
    .access-remove,
    .access-add {
      padding: 0.375rem 0.5rem;
      border: 1px solid var(--cf-theme-color-border, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: var(--cf-theme-color-surface, #ffffff);
      color: inherit;
      font: inherit;
      font-size: 0.75rem;
    }

    .access-remove,
    .access-add {
      cursor: pointer;
    }

    .access-remove:disabled,
    .access-add:disabled,
    .access-select:disabled,
    .access-input:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .access-add-form {
      display: grid;
      grid-template-columns: minmax(12rem, 1fr) auto auto;
      gap: 0.5rem;
      margin-top: 1rem;
    }

    .access-input {
      min-width: 0;
      font-family: var(--cf-theme-font-mono, "SF Mono", monospace);
    }
  `;

  /** The space the menu addresses. */
  declare space?: DID;

  /** The runtime the space is read and changed through. */
  declare runtime?: RuntimeClient;

  /** The piece the menu addresses, when it was opened over one. */
  declare cell?: CellHandle;

  /** Client X coordinate of where the click landed. */
  declare x: number;

  /** Client Y coordinate, read the same way. */
  declare y: number;

  static override properties = {
    space: { attribute: false },
    runtime: { attribute: false },
    cell: { attribute: false },
    x: { attribute: false },
    y: { attribute: false },
  };

  @state()
  private accessor panel: Panel | undefined = undefined;

  @state()
  private accessor selectedFile = 0;

  @state()
  private accessor source: PieceSourceView | undefined = undefined;

  @state()
  private accessor sourceRevision: PieceSourceRevisionView | undefined =
    undefined;

  @state()
  private accessor revisionSource: PieceSourceRevisionSourceView | undefined =
    undefined;

  @state()
  private accessor revisionReadError: string | undefined = undefined;

  @state()
  private accessor revisionReadPending = false;

  @state()
  private accessor readError: string | undefined = undefined;

  @state()
  private accessor argumentValue: unknown = undefined;

  @state()
  private accessor argumentLoaded = false;

  @state()
  private accessor resultValue: unknown = undefined;

  @state()
  private accessor dataError: string | undefined = undefined;

  @state()
  private accessor payloadText = "";

  @state()
  private accessor dispatchNote:
    | { kind: "ok" | "error"; text: string }
    | undefined = undefined;

  @state()
  private accessor sourceActionPending = false;

  @state()
  private accessor clonePending = false;

  @state()
  private accessor cloneMode: CloneMode | undefined = undefined;

  @state()
  private accessor cloneError: string | undefined = undefined;

  @state()
  private accessor sourceActionError: string | undefined = undefined;

  @state()
  private accessor sourceExecutionWarning: string | undefined = undefined;

  @state()
  private accessor compatibilityWarning:
    | {
      action: PieceSourceAction;
      message: string;
      confirmationToken: string;
    }
    | undefined = undefined;

  @state()
  private accessor originEntryOpen = false;

  @state()
  private accessor originEntryUrl = "";

  @state()
  private accessor spaceAccess: SpaceAclView | undefined = undefined;

  @state()
  private accessor accessError: string | undefined = undefined;

  @state()
  private accessor accessActionPending = false;

  @state()
  private accessor newAccessUser = "";

  @state()
  private accessor newAccessCapability: SpaceAclCapability = "READ";

  /** Identifies the read a late response belongs to, so a stale one is dropped. */
  private readToken = 0;

  private sourceActionToken = 0;
  private sourceRead: Promise<void> | undefined;
  private sourceReadPending = false;
  private accessRead: Promise<void> | undefined;
  private revisionReadToken = 0;

  /** Set once a data/actions panel has started its piece-state read. */
  #dataRequested = false;

  /**
   * The generation of the current piece-state read. Every reset — reopening,
   * closing, disconnecting, refreshing — advances it, and every step of an
   * in-flight read checks it, so a read that outlives its generation can
   * neither install a subscription nor write stale state.
   */
  #dataGeneration = 0;

  /** The schema-bearing handle the piece read resolved, for addressing streams. */
  #pieceCell: CellHandle | undefined;

  /** The schema-bearing handle of the piece's argument cell, when resolved. */
  #argumentCell: CellHandle | undefined;

  /** Cancels the live result subscription. */
  #cancelResult: (() => void) | undefined;

  /** Cancels the live argument subscription. */
  #cancelArgument: (() => void) | undefined;

  /** True while a dispatch is in flight, so a rapid double-click sends once. */
  #dispatching = false;

  /** The renderer that owns the open menu. */
  #menuOwner: Element | undefined;

  /** The element whose rendered area receives the visual highlight. */
  #highlightTarget: Element | undefined;

  /** A top-level renderer marked so its shadow-root highlight becomes visible. */
  #markedPiece: Element | undefined;

  #highlightMutationObserver: MutationObserver | undefined;
  #highlightPieceSubscription: (() => void) | undefined;
  #highlightAnimationFrame: number | undefined;
  #nestedHighlightGeometry: string[] = [];

  constructor() {
    super();
    this.x = 0;
    this.y = 0;
  }

  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("keydown", this.#onKeyDown);
    if (
      this.cell && this.source === undefined && !this.clonePending &&
      !this.sourceActionPending
    ) {
      void this.#readSource(this.cell);
    }
  }

  override disconnectedCallback() {
    globalThis.removeEventListener("keydown", this.#onKeyDown);
    const sourceReadPending = this.sourceReadPending &&
      (this.panel === "source" || this.panel === "origin");
    if (!this.clonePending && !this.sourceActionPending && !sourceReadPending) {
      this.close();
    } else {
      this.#setHighlightedPiece(undefined, undefined);
      this.#resetPieceState();
      this.#resetAccessState();
      this.sourceRead = undefined;
      this.sourceReadPending = false;
      this.readToken++;
    }
    super.disconnectedCallback();
  }

  /**
   * Show the menu at a click position, over `cell` when the click landed on a
   * piece. A caller with no piece to name — a surface one failed to load into
   * — passes the space and the runtime instead, and the menu offers what it
   * can reach without a piece.
   */
  open(
    { cell, space, runtime, x, y, highlightedPiece, highlightTarget }: {
      cell?: CellHandle;
      space?: DID;
      runtime?: RuntimeClient;
      x: number;
      y: number;
      highlightedPiece?: Element;
      highlightTarget?: Element;
    },
  ): void {
    if (this.clonePending) return;
    // The host covers the viewport while the menu is up, so a menu that would
    // show nothing has to stay down rather than sit over the page unseen.
    if (!cell && !space) {
      this.close();
      return;
    }
    const target = highlightTarget ?? highlightedPiece;
    if (
      cell && highlightedPiece && target && target !== highlightedPiece &&
      !this.#elementRepresentsPiece(target, cell)
    ) {
      this.close();
      return;
    }
    this.cell = cell;
    this.space = cell ? cell.space() : space;
    this.runtime = cell ? cell.runtime() : runtime;
    this.#setHighlightedPiece(highlightedPiece, target);
    this.x = x;
    this.y = y;
    this.panel = undefined;
    this.selectedFile = 0;
    this.source = undefined;
    this.#resetRevisionSource();
    this.readError = undefined;
    this.#resetPieceState();
    this.payloadText = "";
    this.sourceRead = undefined;
    this.sourceReadPending = false;
    this.sourceActionPending = false;
    this.clonePending = false;
    this.cloneMode = undefined;
    this.cloneError = undefined;
    this.sourceActionError = undefined;
    this.sourceExecutionWarning = undefined;
    this.compatibilityWarning = undefined;
    this.#closeOriginEntry();
    this.#resetAccessState();
    this.sourceActionToken++;
    this.readToken++;
    this.hidden = false;
    if (cell) void this.#readSource(cell);
  }

  /**
   * Hides the menu and forgets what it addressed. A clone progress dialog
   * remains mounted until the request settles so it can report failure or
   * navigate.
   */
  close(): void {
    if (this.clonePending) return;
    this.#setHighlightedPiece(undefined, undefined);
    this.hidden = true;
    this.panel = undefined;
    this.cell = undefined;
    this.space = undefined;
    this.runtime = undefined;
    this.source = undefined;
    this.#resetRevisionSource();
    this.#resetPieceState();
    this.sourceRead = undefined;
    this.sourceReadPending = false;
    this.sourceActionPending = false;
    this.clonePending = false;
    this.cloneMode = undefined;
    this.cloneError = undefined;
    this.sourceActionError = undefined;
    this.sourceExecutionWarning = undefined;
    this.compatibilityWarning = undefined;
    this.#closeOriginEntry();
    this.#resetAccessState();
    this.sourceActionToken++;
    this.readToken++;
  }

  /** Close when `piece` is the render element this menu addresses. */
  closeFor(piece: Element): void {
    if (piece === this.#menuOwner) this.close();
  }

  /** Move the visual highlight to the element the menu addresses. */
  #setHighlightedPiece(
    owner: Element | undefined,
    target: Element | undefined,
  ): void {
    this.#markedPiece?.removeAttribute(PIECE_MENU_OPEN_ATTRIBUTE);
    this.#markedPiece = undefined;
    this.#highlightMutationObserver?.disconnect();
    this.#highlightMutationObserver = undefined;
    this.#highlightPieceSubscription?.();
    this.#highlightPieceSubscription = undefined;
    if (this.#highlightAnimationFrame !== undefined) {
      globalThis.cancelAnimationFrame?.(this.#highlightAnimationFrame);
      this.#highlightAnimationFrame = undefined;
    }
    this.#nestedHighlightGeometry = [];
    this.#menuOwner = owner;
    this.#highlightTarget = target;

    if (owner && target === owner) {
      owner.setAttribute(PIECE_MENU_OPEN_ATTRIBUTE, "");
      this.#markedPiece = owner;
    }
    if (
      owner && target && target !== owner &&
      typeof MutationObserver !== "undefined"
    ) {
      this.#highlightMutationObserver = new MutationObserver(() => {
        if (this.#highlightTarget?.isConnected === false) this.close();
        else if (!this.#highlightTargetMatchesPiece()) this.close();
        else this.#updateNestedHighlightGeometry();
      });
      for (const root of this.#composedShadowRoots(target)) {
        this.#highlightMutationObserver.observe(root, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
      }
    }
    if (target && target !== owner) {
      this.#highlightPieceSubscription = subscribePieceBoundary(
        target,
        (piece) => {
          if (
            this.cell &&
            (piece?.element !== target || !piece.cell.equals(this.cell))
          ) this.close();
        },
      );
      if (typeof globalThis.requestAnimationFrame === "function") {
        this.#highlightAnimationFrame = globalThis.requestAnimationFrame(
          this.#trackHighlightGeometry,
        );
      }
      this.#updateNestedHighlightGeometry();
    }
    this.requestUpdate();
  }

  #trackHighlightGeometry = (): void => {
    this.#highlightAnimationFrame = undefined;
    if (
      !this.#menuOwner || !this.#highlightTarget ||
      this.#menuOwner === this.#highlightTarget
    ) return;
    if (this.#highlightTarget.isConnected === false) {
      this.close();
      return;
    }
    if (!this.#highlightTargetMatchesPiece()) {
      this.close();
      return;
    }
    this.#updateNestedHighlightGeometry();
    if (typeof globalThis.requestAnimationFrame === "function") {
      this.#highlightAnimationFrame = globalThis.requestAnimationFrame(
        this.#trackHighlightGeometry,
      );
    }
  };

  #highlightTargetMatchesPiece(): boolean {
    if (!this.#highlightTarget || !this.cell) return true;
    return this.#elementRepresentsPiece(this.#highlightTarget, this.cell);
  }

  #elementRepresentsPiece(target: Element, cell: CellHandle): boolean {
    const piece = getPieceBoundary(target);
    return piece?.element === target && piece.cell.equals(cell);
  }

  #updateNestedHighlightGeometry(): void {
    const next = this.#computeNestedHighlightGeometry();
    if (
      next.length === this.#nestedHighlightGeometry.length &&
      next.every((style, index) =>
        style === this.#nestedHighlightGeometry[index]
      )
    ) return;
    this.#nestedHighlightGeometry = next;
    this.requestUpdate();
  }

  /** Ancestors along the rendered tree, including slots and shadow hosts. */
  #composedAncestors(element: Element): Element[] {
    const ancestors: Element[] = [];
    const visited = new Set<Element>([element]);
    let current: Element | null = element;
    while (current) {
      const root: Node | undefined = typeof current.getRootNode === "function"
        ? current.getRootNode()
        : undefined;
      const shadowHost: Element | null = root && "host" in root
        ? (root as ShadowRoot).host
        : null;
      const next: Element | null = current.assignedSlot ??
        current.parentElement ??
        shadowHost;
      if (!next || visited.has(next)) break;
      ancestors.push(next);
      visited.add(next);
      current = next;
    }
    return ancestors;
  }

  #composedShadowRoots(element: Element): ShadowRoot[] {
    const roots = new Set<ShadowRoot>();
    for (const item of [element, ...this.#composedAncestors(element)]) {
      if (typeof item.getRootNode !== "function") continue;
      const root = item.getRootNode();
      if (root && "host" in root) roots.add(root as ShadowRoot);
    }
    return [...roots];
  }

  /** Fixed overlay geometry clipped to rendered overflow and the viewport. */
  #computeNestedHighlightGeometry(): string[] {
    const owner = this.#menuOwner;
    const target = this.#highlightTarget;
    if (!owner || !target || owner === target) return [];

    const ownerRect = owner.getBoundingClientRect();
    const viewportWidth = globalThis.innerWidth ?? Number.POSITIVE_INFINITY;
    const viewportHeight = globalThis.innerHeight ?? Number.POSITIVE_INFINITY;
    const targetRects = typeof target.getClientRects === "function"
      ? Array.from(target.getClientRects())
      : [];
    if (targetRects.every((rect) => rect.width <= 0 || rect.height <= 0)) {
      targetRects.length = 0;
      const range = globalThis.document?.createRange?.();
      if (range) {
        range.selectNodeContents(target);
        targetRects.push(...Array.from(range.getClientRects()));
        range.detach();
      }
    }
    if (targetRects.length === 0) {
      targetRects.push(target.getBoundingClientRect());
    }

    const clippingAncestors: Array<{
      rect: { left: number; top: number; right: number; bottom: number };
      clipX: boolean;
      clipY: boolean;
    }> = [];
    if (typeof globalThis.getComputedStyle === "function") {
      for (const ancestor of this.#composedAncestors(target)) {
        const style = globalThis.getComputedStyle(ancestor);
        const clips = (value: string) =>
          value === "auto" || value === "scroll" || value === "hidden" ||
          value === "clip";
        const clipX = clips(style.overflowX);
        const clipY = clips(style.overflowY);
        if (clipX || clipY) {
          const borderRect = ancestor.getBoundingClientRect();
          const element = ancestor as HTMLElement;
          const scaleX = element.offsetWidth > 0
            ? borderRect.width / element.offsetWidth
            : 1;
          const scaleY = element.offsetHeight > 0
            ? borderRect.height / element.offsetHeight
            : 1;
          const left = borderRect.left + ancestor.clientLeft * scaleX;
          const top = borderRect.top + ancestor.clientTop * scaleY;
          clippingAncestors.push({
            rect: {
              left,
              top,
              right: left + ancestor.clientWidth * scaleX,
              bottom: top + ancestor.clientHeight * scaleY,
            },
            clipX,
            clipY,
          });
        }
      }
    }

    return targetRects.flatMap((targetRect) => {
      let left = Math.max(0, ownerRect.left, targetRect.left);
      let top = Math.max(0, ownerRect.top, targetRect.top);
      let right = Math.min(viewportWidth, ownerRect.right, targetRect.right);
      let bottom = Math.min(
        viewportHeight,
        ownerRect.bottom,
        targetRect.bottom,
      );
      for (const ancestor of clippingAncestors) {
        if (ancestor.clipX) {
          left = Math.max(left, ancestor.rect.left);
          right = Math.min(right, ancestor.rect.right);
        }
        if (ancestor.clipY) {
          top = Math.max(top, ancestor.rect.top);
          bottom = Math.min(bottom, ancestor.rect.bottom);
        }
      }
      return right > left && bottom > top
        ? [
          `left: ${left}px; top: ${top}px; width: ${right - left}px; ` +
          `height: ${bottom - top}px`,
        ]
        : [];
    });
  }

  #resetAccessState(): void {
    this.spaceAccess = undefined;
    this.accessError = undefined;
    this.accessActionPending = false;
    this.newAccessUser = "";
    this.newAccessCapability = "READ";
    this.accessRead = undefined;
  }

  /** Drop everything the data/actions panels read, and their subscriptions. */
  #resetPieceState(): void {
    // Invalidate first: an in-flight read must see the new generation before
    // any of its remaining steps run, or a late completion could subscribe
    // after this cleanup and leak.
    this.#dataGeneration++;
    this.#cancelResult?.();
    this.#cancelResult = undefined;
    this.#cancelArgument?.();
    this.#cancelArgument = undefined;
    this.#pieceCell = undefined;
    this.#argumentCell = undefined;
    this.#dataRequested = false;
    this.argumentValue = undefined;
    this.argumentLoaded = false;
    this.resultValue = undefined;
    this.dataError = undefined;
    this.dispatchNote = undefined;
  }

  #resetRevisionSource(): void {
    this.revisionReadToken++;
    this.sourceRevision = undefined;
    this.revisionSource = undefined;
    this.revisionReadError = undefined;
    this.revisionReadPending = false;
  }

  #onKeyDown = (e: KeyboardEvent) => {
    if (this.hidden || e.key !== "Escape") return;
    e.preventDefault();
    // Escape dismisses the topmost thing first: the origin dialog, then a
    // panel back to the menu, then the menu.
    if (this.originEntryOpen) {
      if (!this.sourceActionPending) this.#closeOriginEntry();
    } else if (this.panel) {
      this.panel = undefined;
      this.#resetRevisionSource();
    } else this.close();
  };

  /** Show the source file at `index`, as choosing its tab does. */
  selectFile(index: number): void {
    this.selectedFile = index;
  }

  /**
   * A right-click on the backdrop dismisses the menu rather than opening a
   * second one behind it.
   */
  private _onBackdropContextMenu = (e: Event) => {
    e.preventDefault();
    this.close();
  };

  /**
   * Show one of the panels, as choosing its entry does. The source panels
   * read the piece's source state the first time either is opened for that
   * piece; the data and actions panels read its argument and result the
   * first time either of those is.
   */
  async showPanel(panel: Panel) {
    this.panel = panel;
    this.selectedFile = 0;
    this.#resetRevisionSource();
    // The access panel is addressed by space; every other panel by piece.
    if (panel === "access") {
      await this.#readSpaceAccess();
      return;
    }
    const cell = this.cell;
    if (!cell) return;
    if (panel === "data" || panel === "actions") {
      if (this.#dataRequested) return;
      this.#dataRequested = true;
      await this.#readPieceState(cell);
      return;
    }
    if (this.source !== undefined) return;
    await this.#readSource(cell);
  }

  #readSpaceAccess(): Promise<void> {
    this.accessRead ??= this.#performSpaceAccessRead();
    return this.accessRead;
  }

  async #performSpaceAccessRead(): Promise<void> {
    const { runtime, space } = this;
    if (!runtime || !space) return;
    const token = this.readToken;
    try {
      const access = await runtime.getSpaceAcl(space);
      if (token !== this.readToken) return;
      this.spaceAccess = access;
    } catch (error) {
      if (token !== this.readToken || runtime.signal.aborted) return;
      this.accessError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Add or replace one explicit entry in the current space's ACL. */
  async setSpaceAccessEntry(
    user: string,
    capability: SpaceAclCapability,
  ): Promise<void> {
    const { runtime, space } = this;
    const normalizedUser = user.trim();
    if (
      !runtime || !space || this.accessActionPending ||
      normalizedUser.length === 0
    ) {
      return;
    }
    const token = this.readToken;
    this.accessActionPending = true;
    this.accessError = undefined;
    try {
      const access = await runtime.setSpaceAclEntry(
        space,
        normalizedUser,
        capability,
      );
      if (token !== this.readToken) return;
      this.spaceAccess = access;
      if (this.newAccessUser.trim() === normalizedUser) {
        this.newAccessUser = "";
      }
    } catch (error) {
      if (token !== this.readToken || runtime.signal.aborted) return;
      this.accessError = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === this.readToken) this.accessActionPending = false;
    }
  }

  /** Remove one explicit entry from the current space's ACL. */
  async removeSpaceAccessEntry(user: string): Promise<void> {
    const { runtime, space } = this;
    if (!runtime || !space || this.accessActionPending) return;
    const token = this.readToken;
    this.accessActionPending = true;
    this.accessError = undefined;
    try {
      const access = await runtime.removeSpaceAclEntry(space, user);
      if (token !== this.readToken) return;
      this.spaceAccess = access;
    } catch (error) {
      if (token !== this.readToken || runtime.signal.aborted) return;
      this.accessError = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === this.readToken) this.accessActionPending = false;
    }
  }

  /** Ask for an origin, starting from an empty field and no stale error. */
  #openOriginEntry(): void {
    this.originEntryUrl = "";
    this.sourceActionError = undefined;
    this.originEntryOpen = true;
  }

  /**
   * Put the origin dialog away, discarding what was typed into it and
   * whatever answer that produced. The failure and the warning belong to the
   * dialog: surfacing either on the panel behind it, once the question they
   * answer is gone, reads as a fresh problem with the piece.
   */
  #closeOriginEntry(): void {
    this.originEntryOpen = false;
    this.originEntryUrl = "";
    this.sourceActionError = undefined;
    this.compatibilityWarning = undefined;
  }

  #onOriginEntryUrl = (event: Event): void => {
    this.originEntryUrl = (event.currentTarget as HTMLInputElement).value;
    // Both answers were about the URL that was there before.
    this.sourceActionError = undefined;
    this.compatibilityWarning = undefined;
  };

  #followEnteredOrigin = (event: SubmitEvent): void => {
    event.preventDefault();
    const url = this.originEntryUrl.trim();
    if (url.length === 0) return;
    const warning = this.compatibilityWarning;
    if (warning !== undefined) {
      void this.changeSource(warning.action, warning.confirmationToken);
      return;
    }
    void this.changeSource({ kind: "repoint", url });
  };

  #onNewAccessUser = (event: Event): void => {
    this.newAccessUser = (event.currentTarget as HTMLInputElement).value;
  };

  #onNewAccessCapability = (event: Event): void => {
    this.newAccessCapability = (event.currentTarget as HTMLSelectElement)
      .value as SpaceAclCapability;
  };

  #addSpaceAccessEntry = (event: SubmitEvent): void => {
    event.preventDefault();
    void this.setSpaceAccessEntry(
      this.newAccessUser,
      this.newAccessCapability,
    );
  };

  /** Navigate through the shell, preserving normal modified-link behavior. */
  #navigate(event: MouseEvent, command: NavigationCommand): void {
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey) {
      openInNewTab(command);
      return;
    }
    this.close();
    navigate(command);
  }

  /** Show the retained files for one exact source revision. */
  async #showRevisionSource(
    event: MouseEvent,
    revision: PieceSourceRevisionView,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const cell = this.cell;
    if (
      cell === undefined ||
      (this.revisionReadPending &&
        this.sourceRevision?.revisionId === revision.revisionId)
    ) return;
    const token = ++this.revisionReadToken;
    this.sourceRevision = revision;
    this.revisionSource = undefined;
    this.revisionReadError = undefined;
    this.revisionReadPending = true;
    this.selectedFile = 0;
    this.panel = "source";
    void this.updateComplete.then(() => {
      if (token !== this.revisionReadToken || this.panel !== "source") return;
      this.shadowRoot?.querySelector<HTMLButtonElement>(".panel-close")
        ?.focus();
    });
    try {
      const source = await cell.runtime().getPieceSourceRevision(
        cell.id(),
        cell.space(),
        revision.revisionId,
        cell.ref().scope,
      );
      if (token !== this.revisionReadToken) return;
      this.revisionSource = source;
    } catch (error) {
      if (token !== this.revisionReadToken) return;
      if (cell.runtime().signal.aborted) return;
      this.revisionReadError = error instanceof Error
        ? error.message
        : String(error);
    } finally {
      if (token === this.revisionReadToken) this.revisionReadPending = false;
    }
  }

  #readSource(cell: CellHandle): Promise<void> {
    if (this.sourceRead === undefined) {
      this.sourceReadPending = true;
      const read = this.#performSourceRead(cell);
      this.sourceRead = read;
      const settled = () => {
        if (this.sourceRead === read) this.sourceReadPending = false;
      };
      void read.then(settled, settled);
    }
    return this.sourceRead;
  }

  async #performSourceRead(cell: CellHandle): Promise<void> {
    const token = this.readToken;
    try {
      const source = await cell.runtime().getPieceSource(
        cell.id(),
        cell.space(),
        cell.ref().scope,
      );
      if (token !== this.readToken) return;
      this.source = source;
    } catch (error) {
      if (token !== this.readToken) return;
      // A disposal race (logout, runtime swap) cancels the read; that is
      // cancellation, not a failure to report.
      if (cell.runtime().signal.aborted) return;
      this.readError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Read the piece's argument and result. The menu's own cell addresses the
   * piece but carries no result schema, and stream fields only keep their
   * `asCell` tags under a schema'd read, so the piece read resolves one —
   * running the piece if it was not already.
   */
  async #readPieceState(cell: CellHandle): Promise<void> {
    const generation = this.#dataGeneration;
    const fresh = () => generation === this.#dataGeneration;
    try {
      const rt = cell.runtime();
      const piece = await rt.getPiece(
        cell.id(),
        cell.space(),
        true,
        cell.ref().scope,
      );
      if (!fresh()) return;
      const pieceCell = (piece?.cell() as CellHandle | undefined) ?? cell;
      this.#pieceCell = pieceCell;
      this.#cancelResult = pieceCell.subscribe((value) => {
        if (!fresh()) return;
        this.resultValue = value;
      });
      const response = await rt[$conn]().request<RequestType.CellGet>({
        type: RequestType.CellGet,
        cell: pieceCell.ref(),
        meta: "argument",
        includeRef: true,
      });
      if (!fresh()) return;
      if (response.cell) {
        // The argument's own schema-bearing ref: its schema carries the
        // stream declarations for argument-side handlers, and the handle
        // gives the panel a live view instead of a one-shot snapshot.
        const argumentCell = new CellHandle(
          rt,
          response.cell,
          CellHandle.deserialize(
            new CellHandle(rt, response.cell),
            response.value,
          ),
        );
        this.#argumentCell = argumentCell;
        this.#cancelArgument = argumentCell.subscribe((value) => {
          if (!fresh()) return;
          this.argumentValue = value;
        });
      } else {
        this.argumentValue = CellHandle.deserialize(pieceCell, response.value);
      }
      this.argumentLoaded = true;
    } catch (error) {
      if (!fresh()) return;
      if (cell.runtime().signal.aborted) return;
      this.dataError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Re-read the piece's argument and result, as the Refresh control does.
   * Also the retry path for a failed read: the reset advances the read
   * generation, so a still-in-flight earlier read cannot install anything.
   */
  refreshData(): void {
    const cell = this.cell;
    if (!cell) return;
    const dispatchNote = this.dispatchNote;
    this.#resetPieceState();
    // A refresh replaces the read, not the conversation: keep the last
    // dispatch outcome visible.
    this.dispatchNote = dispatchNote;
    this.#dataRequested = true;
    void this.#readPieceState(cell);
  }

  /** A schema's per-property fragments. */
  #schemaProperties(of: CellHandle | undefined): Record<string, unknown> {
    const schema = of?.ref().schema as
      | { properties?: Record<string, unknown> }
      | undefined;
    return schema?.properties ?? {};
  }

  /** The result keys the piece schema declares as streams. */
  #declaredStreamKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (
      const [name, fragment] of Object.entries(
        this.#schemaProperties(this.#pieceCell),
      )
    ) {
      if (schemaDeclaresStream(fragment)) keys.add(name);
    }
    return keys;
  }

  /**
   * The handler streams the piece's argument and result carry at their top
   * level, deduplicated when the same stream is reachable from both sides.
   *
   * A handler read through a schema'd read arrives as a `CellHandle` carrying
   * the handler's event schema; the `asCell: ["stream"]` declaration stays on
   * the PARENT schema's property, so each side's parent schema is the primary
   * signal (piece schema for the result, argument schema for the argument).
   * The handle's own schema tag covers a value that arrived stream-tagged.
   * There is deliberately no guess for an untagged, undeclared handle:
   * dispatching to a non-stream cell would silently overwrite its value.
   */
  collectActions(): PieceAction[] {
    const actions: PieceAction[] = [];
    const seen = new Set<string>();
    const parents = {
      result: this.#pieceCell,
      argument: this.#argumentCell,
    };
    const scan = (value: unknown, source: "result" | "argument") => {
      if (!isObjectNotArray(value)) return;
      const declared = this.#schemaProperties(parents[source]);
      for (const [name, item] of Object.entries(value)) {
        const declaredStream = schemaDeclaresStream(declared[name]);
        let handle: CellHandle | undefined;
        if (isCellHandle(item)) {
          if (!declaredStream && !isStreamHandle(item)) continue;
          handle = item;
        } else if (declaredStream && parents[source]) {
          // The value did not arrive as a handle — a schema-less read leaves
          // whatever the document holds, and a stream's holds nothing — but
          // the parent schema declares the stream. Address it through the
          // parent, which is the trusted signal here; nothing a value could
          // hold is dispatchable on its own.
          handle = (parents[source]!.asSchema(
            {
              type: "object",
              properties: { [name]: { asCell: ["stream"] } },
              required: [name],
            } as unknown as Parameters<CellHandle["asSchema"]>[0],
          ) as CellHandle<Record<string, unknown>>).key(name) as CellHandle;
        } else {
          continue;
        }
        // Identity is structural, minus the schema: the same stream seen
        // through two reads carries two different schema views.
        const ref = handle.ref();
        const key = JSON.stringify({
          space: ref.space,
          scope: ref.scope,
          id: ref.id,
          path: ref.path,
        });
        if (seen.has(key)) continue;
        seen.add(key);
        const eventSchema = schemaDeclaresStream(ref.schema)
          ? undefined
          : ref.schema;
        actions.push({ name, source, handle, eventSchema });
      }
    };
    scan(this.resultValue, "result");
    scan(this.argumentValue, "argument");
    return actions;
  }

  /**
   * Dispatch an event to one of the piece's handler streams, with the panel's
   * JSON payload if one was entered. Goes through the raw request rather than
   * `CellHandle.send()`, which logs and swallows failures — but note the
   * limit: the worker commits the event asynchronously after acknowledging
   * the request, so acceptance here means "accepted for delivery". A refusal
   * during the later commit is not reported back.
   */
  async dispatchAction(action: PieceAction): Promise<void> {
    const cell = this.cell;
    if (!cell || this.#dispatching) return;
    this.dispatchNote = undefined;
    // What `JSON.parse()` yields, which is what a cell's value may be minus
    // the handles this menu never puts in one.
    let payload: JSONValue = {};
    const text = this.payloadText.trim();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        this.dispatchNote = {
          kind: "error",
          text: `The payload is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
        return;
      }
    }
    const generation = this.#dataGeneration;
    this.#dispatching = true;
    try {
      await cell.runtime()[$conn]().request<RequestType.CellSend>({
        type: RequestType.CellSend,
        cell: action.handle.ref(),
        event: CellHandle.serialize(payload),
      });
      if (generation !== this.#dataGeneration) return;
      this.dispatchNote = {
        kind: "ok",
        text: `Event accepted for ${action.name}.`,
      };
    } catch (error) {
      if (generation !== this.#dataGeneration) return;
      if (cell.runtime().signal.aborted) return;
      this.dispatchNote = {
        kind: "error",
        text: `Dispatch to ${action.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    } finally {
      this.#dispatching = false;
    }
  }

  /** Apply one source-history action, optionally accepting incompatibility. */
  async changeSource(
    action: PieceSourceAction,
    confirmationToken?: string,
  ): Promise<void> {
    const cell = this.cell;
    if (!cell || this.sourceActionPending) return;
    const actionToken = ++this.sourceActionToken;
    this.sourceActionPending = true;
    this.sourceActionError = undefined;
    this.sourceExecutionWarning = undefined;
    this.compatibilityWarning = undefined;
    try {
      const response = await cell.runtime().updatePieceSource(
        cell.id(),
        cell.space(),
        action,
        {
          ...(confirmationToken === undefined ? {} : { confirmationToken }),
          scope: cell.ref().scope,
        },
      );
      if (actionToken !== this.sourceActionToken) return;
      this.source = response.source;
      if (response.compatibilityWarning !== undefined) {
        if (response.confirmationToken === undefined) {
          throw new Error(
            "the runtime did not provide a compatibility confirmation",
          );
        }
        this.compatibilityWarning = {
          action,
          message: response.compatibilityWarning,
          confirmationToken: response.confirmationToken,
        };
      } else {
        this.compatibilityWarning = undefined;
        this.sourceExecutionWarning = response.executionWarning;
        this.#closeOriginEntry();
        this.panel = "origin";
      }
    } catch (error) {
      if (
        actionToken !== this.sourceActionToken || cell.runtime().signal.aborted
      ) return;
      this.sourceActionError = error instanceof Error
        ? error.message
        : String(error);
      this.panel = "origin";
      // A failed attempt still records what it concluded — an origin that
      // could not be reached is a state of the piece, not just of this
      // request — so the panel reads the piece again rather than going on
      // showing what it knew before the attempt.
      await this.#rereadSource(cell, actionToken);
    } finally {
      if (actionToken === this.sourceActionToken) {
        this.sourceActionPending = false;
      }
    }
  }

  /**
   * Take what the active origin offers now, accepting an incompatible contract
   * without stopping to ask.
   *
   * The check still runs, and what it finds is applied through the same
   * one-use confirmation a reviewed override uses, so the source that lands is
   * the exact one the check reviewed. A candidate whose contract the piece's
   * stored data cannot satisfy is still refused: that is not a warning to
   * accept, it is source the piece cannot run.
   */
  async forceUpdateFromOrigin(): Promise<void> {
    await this.changeSource({ kind: "adopt" });
    const warning = this.compatibilityWarning;
    if (warning === undefined) return;
    await this.changeSource(warning.action, warning.confirmationToken);
  }

  /**
   * Read the piece's source state again, leaving the panel as it was if the
   * read fails or another action has since started. A refresh that cannot
   * happen is not worth reporting: the caller is already reporting why the
   * action did not.
   */
  async #rereadSource(cell: CellHandle, actionToken: number): Promise<void> {
    try {
      const source = await cell.runtime().getPieceSource(
        cell.id(),
        cell.space(),
        cell.ref().scope,
      );
      if (actionToken === this.sourceActionToken) this.source = source;
    } catch {
      // Keeping the previous view is the fallback, and the action's own
      // failure is what the panel is showing.
    }
  }

  /** Open the clone dialog and begin the selected clone operation. */
  private async startClone(mode: CloneMode): Promise<void> {
    if (this.clonePending) return;
    this.cloneMode = mode;
    this.cloneError = undefined;
    await this.cloneIntoNewSpace({ copyData: mode === "copy-data" });
  }

  /** Clone the selected piece into a unique named space and open the copy. */
  async cloneIntoNewSpace(
    {
      copyData = false,
      spaceName = `piece-copy-${crypto.randomUUID()}`,
    }: { copyData?: boolean; spaceName?: string } = {},
  ): Promise<void> {
    const cell = this.cell;
    if (!cell || this.clonePending) return;
    // The name is derived into a space key AND put in the URL as a name; a DID
    // would mean two different spaces on those two routes.
    assertNotDID(spaceName, "A space name");
    this.cloneMode = copyData ? "copy-data" : "fresh";
    this.clonePending = true;
    this.cloneError = undefined;
    try {
      const runtime = cell.runtime();
      const destinationSpace = await runtime.resolveSpaceName(spaceName);
      const clone = await runtime.clonePiece(
        cell.id(),
        cell.space(),
        destinationSpace,
        { copyData, scope: cell.ref().scope },
      );
      this.clonePending = false;
      this.close();
      navigate({ spaceName, pieceId: clone.id() });
    } catch (error) {
      this.cloneError = cell.runtime().signal.aborted
        ? "The clone was canceled because the runtime stopped."
        : error instanceof Error
        ? error.message
        : String(error);
    } finally {
      this.clonePending = false;
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    this.#placeMenu();
  }

  /**
   * Put the open menu at the click, pulled back inside the viewport by as much
   * as it hangs over an edge. The menu is measured at the top left corner,
   * where the whole viewport is available to it, so the box it reports is the
   * one it occupies wherever it lands: the clamp never puts it anywhere with
   * less room than it was measured in.
   */
  #placeMenu(): void {
    const menu = this.shadowRoot?.querySelector<HTMLElement>(".menu");
    if (!menu) return;
    menu.style.left = "4px";
    menu.style.top = "4px";
    const { width, height } = menu.getBoundingClientRect();
    const left = Math.max(
      4,
      Math.min(this.x, globalThis.innerWidth - width - 4),
    );
    const top = Math.max(
      4,
      Math.min(this.y, globalThis.innerHeight - height - 4),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  protected override render() {
    if (this.hidden || (!this.cell && !this.space)) return nothing;
    return html`
      ${this.#renderNestedHighlight()} ${this.cloneMode !== undefined
        ? this.#renderCloneDialog()
        : this.panel
        ? this.#renderPanel(this.panel)
        : this.#renderMenu()} ${this.originEntryOpen
        ? this.#renderOriginEntryDialog()
        : nothing}
    `;
  }

  #renderNestedHighlight(): TemplateResult | typeof nothing {
    const styles = this.#nestedHighlightGeometry;
    return styles.length > 0
      ? html`
        ${styles.map((style) =>
          html`
            <div
              class="nested-piece-highlight"
              aria-hidden="true"
              style="${style}"
            ></div>
          `
        )}
      `
      : nothing;
  }

  #renderMenu(): TemplateResult {
    // A piece carrying an origin nothing can follow gets the detach entry too:
    // detaching is what repairs it.
    const entries = pieceMenuEntries(
      this.source?.origin !== undefined ||
        this.source?.unusableOrigin !== undefined,
    );
    // The menu renders in the corner, which is where `#placeMenu` measures it.
    // That measurement and the move to the click both happen within the
    // update, so the corner is never painted.
    return html`
      <div
        class="backdrop"
        @click="${() => this.close()}"
        @contextmenu="${this._onBackdropContextMenu}"
      ></div>
      <div class="menu" role="menu" style="left: 4px; top: 4px">
        <div class="menu-title">
          ${this.cell ? `Piece ${this.cell.id()}` : "Piece unavailable"}
        </div>
        ${entries.map((entry) =>
          html`
            <button
              class="menu-item"
              role="menuitem"
              test-id="${entry.testId}"
              ?disabled="${!this.cell || this.sourceActionPending ||
                this.clonePending}"
              @click="${() =>
                "panel" in entry
                  ? this.showPanel(entry.panel)
                  : entry.action === "clone-fresh"
                  ? this.startClone("fresh")
                  : entry.action === "clone-copy-data"
                  ? this.startClone("copy-data")
                  : this.changeSource({ kind: "detach" })}"
            >
              ${entry.label}
            </button>
          `
        )}
        <div class="menu-divider" role="separator"></div>
        <div class="menu-title">
          ${this.space ? `Space ${this.space}` : "Space unavailable"}
        </div>
        <button
          class="menu-item"
          role="menuitem"
          test-id="${SPACE_ACCESS_ENTRY.testId}"
          ?disabled="${!this.runtime || !this.space}"
          @click="${() => this.showPanel(SPACE_ACCESS_ENTRY.panel)}"
        >
          ${SPACE_ACCESS_ENTRY.label}
        </button>
      </div>
    `;
  }

  #renderCloneDialog(): TemplateResult {
    const copyData = this.cloneMode === "copy-data";
    return html`
      <div class="backdrop dimmed" @click="${() => this.close()}"></div>
      <div
        class="panel"
        role="dialog"
        aria-label="Clone piece"
        aria-live="polite"
        test-id="piece-clone-dialog"
      >
        <div class="panel-head">
          <h2>${copyData
            ? "Clone piece and copy data"
            : "Clone fresh piece"}</h2>
          <span class="subject">${this.source?.name ?? this.cell?.id() ??
            ""}</span>
          <button
            class="panel-close"
            ?disabled="${this.clonePending}"
            @click="${() => this.close()}"
          >
            Close
          </button>
        </div>
        <div class="panel-body">
          ${this.clonePending
            ? html`
              <div class="clone-status">
                <progress aria-label="Cloning piece"></progress>
                <span>Cloning piece into a new space…</span>
              </div>
            `
            : this.cloneError
            ? html`
              <p class="error">
                Could not clone this piece: ${this.cloneError}
              </p>
              <div class="clone-actions">
                <button class="source-action" @click="${() => this.close()}">
                  Close
                </button>
                <button
                  class="source-action"
                  test-id="piece-clone-retry"
                  @click="${() => this.startClone(this.cloneMode!)}"
                >
                  Try again
                </button>
              </div>
            `
            : nothing}
        </div>
      </div>
    `;
  }

  #renderPanel(panel: Panel): TemplateResult {
    const title = PANEL_TITLES[panel];
    const subject = panel === "access"
      ? this.space ?? ""
      : panel !== "source" || this.sourceRevision === undefined
      ? this.source?.name ?? this.cell?.id() ?? ""
      : `Pattern ${
        patternRefLabel(this.sourceRevision.pattern, { whole: true })
      }`;
    return html`
      <div class="backdrop dimmed" @click="${() => this.close()}"></div>
      <div
        class="panel"
        role="dialog"
        aria-label="${title}"
        test-id="piece-panel-${panel}"
      >
        <div class="panel-head">
          <h2>${title}</h2>
          <span class="subject">${subject}</span>
          <button class="panel-close" @click="${() => this.close()}">
            Close
          </button>
        </div>
        <span
          class="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >${panel === "source" && this.sourceRevision !== undefined
          ? this.#revisionReadStatus()
          : ""}</span>
        ${panel === "source" ? this.#renderSourceTabs() : nothing}
        <div class="panel-body">
          ${panel === "access"
            ? this.#renderSpaceAccess()
            : panel === "data"
            ? this.#renderData()
            : panel === "actions"
            ? this.#renderActions()
            : this.readError
            ? html`
              <p class="error">
                Could not read this piece's source: ${this.readError}
              </p>
            `
            : this.source === undefined
            ? html`
              <p>Reading source…</p>
            `
            : panel === "source"
            ? this.#renderSource(this.source)
            : this.#renderOrigin(this.source)}
        </div>
      </div>
    `;
  }

  #renderSpaceAccess(): TemplateResult {
    if (this.spaceAccess === undefined) {
      return this.accessError
        ? html`
          <p class="error">
            Could not read this space's access rights: ${this.accessError}
          </p>
        `
        : html`
          <p>Reading access rights…</p>
        `;
    }
    const access = this.spaceAccess;
    const entries = Object.entries(access.acl).sort(([left], [right]) => {
      if (left === "*") return -1;
      if (right === "*") return 1;
      return left.localeCompare(right);
    });
    return html`
      <p class="access-summary">
        ${access.canEdit
          ? "You can change these rights because you have OWNER access."
          : "You can view these rights. Only a space owner can change them."}
      </p>
      <table class="access-table">
        <thead>
          <tr>
            <th scope="col">Identity</th>
            <th scope="col">Access</th>
            ${access.canEdit
              ? html`
                <th scope="col">Actions</th>
              `
              : nothing}
          </tr>
        </thead>
        <tbody>
          ${entries.length === 0
            ? html`
              <tr>
                <td colspan="${access.canEdit ? 3 : 2}">No ACL entries.</td>
              </tr>
            `
            : entries.map(([user, capability]) =>
              this.#renderSpaceAccessEntry(access, user, capability)
            )}
        </tbody>
      </table>
      ${this.accessError
        ? html`
          <p class="error">Could not change access rights: ${this
            .accessError}</p>
        `
        : nothing} ${access.canEdit
        ? html`
          <form
            class="access-add-form"
            test-id="space-access-add-form"
            @submit="${this.#addSpaceAccessEntry}"
          >
            <input
              class="access-input"
              aria-label="Identity DID or wildcard"
              placeholder="did:key:... or *"
              .value="${this.newAccessUser}"
              ?disabled="${this.accessActionPending}"
              @input="${this.#onNewAccessUser}"
            />
            <select
              class="access-select"
              aria-label="Access level for new entry"
              ?disabled="${this.accessActionPending}"
              @change="${this.#onNewAccessCapability}"
            >
              ${this.#renderCapabilityOptions(this.newAccessCapability)}
            </select>
            <button
              class="access-add"
              type="submit"
              test-id="space-access-add"
              ?disabled="${this.accessActionPending ||
                this.newAccessUser.trim().length === 0}"
            >
              Add
            </button>
          </form>
        `
        : nothing}
      <p class="note">
        READ can view the space. WRITE can also change its pieces. OWNER can also
        change these access rights. The <code>*</code> entry applies to every
        authenticated identity without a more specific entry.
      </p>
    `;
  }

  #renderSpaceAccessEntry(
    access: SpaceAclView,
    user: string,
    capability: SpaceAclCapability,
  ): TemplateResult {
    return html`
      <tr>
        <td class="access-user">
          ${user === "*" ? "Anyone (*)" : user}${user === access.principal
            ? " (you)"
            : ""}
        </td>
        <td>
          ${access.canEdit
            ? html`
              <select
                class="access-select"
                aria-label="Access level for ${user}"
                ?disabled="${this.accessActionPending}"
                @change="${(event: Event) =>
                  this.setSpaceAccessEntry(
                    user,
                    (event.currentTarget as HTMLSelectElement)
                      .value as SpaceAclCapability,
                  )}"
              >
                ${this.#renderCapabilityOptions(capability)}
              </select>
            `
            : capability}
        </td>
        ${access.canEdit
          ? html`
            <td>
              <div class="access-controls">
                <button
                  class="access-remove"
                  type="button"
                  aria-label="Remove ${user}"
                  test-id="space-access-remove"
                  ?disabled="${this.accessActionPending}"
                  @click="${() => this.removeSpaceAccessEntry(user)}"
                >
                  Remove
                </button>
              </div>
            </td>
          `
          : nothing}
      </tr>
    `;
  }

  #renderCapabilityOptions(selected: SpaceAclCapability): TemplateResult {
    return html`
      <option value="READ" .selected="${live(
        selected === "READ",
      )}">READ</option>
      <option value="WRITE" .selected="${live(
        selected === "WRITE",
      )}">WRITE</option>
      <option value="OWNER" .selected="${live(
        selected === "OWNER",
      )}">OWNER</option>
    `;
  }

  #revisionReadStatus(): string {
    if (this.revisionReadError !== undefined) {
      return `Could not read source revision: ${this.revisionReadError}`;
    }
    if (this.revisionSource === undefined) {
      return this.revisionReadPending
        ? "Reading source revision."
        : "Source revision read was cancelled.";
    }
    const count = this.revisionSource.files.length;
    if (count === 0) return "Source revision is not available.";
    return `Source revision loaded with ${count} ${
      count === 1 ? "file" : "files"
    }.`;
  }

  /** A read failure with the retry the failure would otherwise block. */
  #renderDataError(what: string): TemplateResult {
    return html`
      <p class="error">
        Could not read this piece's ${what}: ${this.dataError}
        <button class="refresh" @click="${() => this.refreshData()}">
          Retry
        </button>
      </p>
    `;
  }

  #renderData(): TemplateResult {
    if (this.dataError) return this.#renderDataError("data");
    return html`
      <h3 class="section-title">Argument</h3>
      ${this.argumentLoaded
        ? html`
          <pre class="source">${formatPieceValue(this.argumentValue)}</pre>
        `
        : html`
          <p>Reading argument…</p>
        `}
      <h3 class="section-title">Result</h3>
      ${this.resultValue === undefined
        ? html`
          <p>Waiting for a value…</p>
        `
        : html`
          <pre class="source">${formatPieceValue(
            this.resultValue,
            this.#declaredStreamKeys(),
          )}</pre>
        `}
      <p class="note">
        Values stay live while the menu is open.
        <button class="refresh" @click="${() => this.refreshData()}">
          Refresh
        </button>
      </p>
    `;
  }

  #renderActions(): TemplateResult {
    if (this.dataError) return this.#renderDataError("handlers");
    if (!this.argumentLoaded && this.resultValue === undefined) {
      return html`
        <p>Reading handlers…</p>
      `;
    }
    const actions = this.collectActions();
    if (actions.length === 0) {
      return html`
        <p>This piece exposes no handler streams.</p>
        <p class="note">
          Handlers appear here when the piece's argument or result carries stream
          fields.
        </p>
      `;
    }
    return html`
      <label class="payload-label">
        Optional JSON event payload
        <textarea
          class="payload"
          placeholder="{}"
          .value="${this.payloadText}"
          @input="${(e: Event) => {
            this.payloadText = (e.target as HTMLTextAreaElement).value;
          }}"
        ></textarea>
      </label>
      <div class="actions-list">
        ${actions.map((action) =>
          html`
            <div class="action-row">
              <span class="action-name">${action.name}</span>
              ${payloadHint(action)
                ? html`
                  <span class="action-hint">${payloadHint(action)}</span>
                `
                : nothing}
              <span class="action-source">${action.source}</span>
              <button
                class="action-send"
                test-id="piece-action-${action.name}"
                @click="${() => this.dispatchAction(action)}"
              >
                Send
              </button>
            </div>
          `
        )}
      </div>
      ${this.dispatchNote
        ? html`
          <p class="${this.dispatchNote.kind === "error" ? "error" : "status"}">
            ${this.dispatchNote.text}
          </p>
        `
        : nothing}
      <p class="note">
        "Accepted" means the runtime accepted the event for delivery; the commit
        happens asynchronously, so a later refusal is not reported here. Events sent
        here are also not renderer-trusted: a handler gated on UI provenance will
        refuse them.
      </p>
    `;
  }

  #renderSourceTabs() {
    const files = this.sourceRevision === undefined
      ? this.source?.files ?? []
      : this.revisionSource?.files ?? [];
    if (files.length < 2) return nothing;
    return html`
      <div class="file-tabs">
        ${files.map((file, index) =>
          html`
            <button
              class="file-tab ${index === this.selectedFile ? "active" : ""}"
              @click="${() => this.selectFile(index)}"
            >
              ${file.name}
            </button>
          `
        )}
      </div>
    `;
  }

  #renderSource(source: PieceSourceView): TemplateResult {
    if (this.sourceRevision !== undefined) {
      if (this.revisionReadError !== undefined) {
        return html`
          <p class="error">
            Could not read this source revision: ${this.revisionReadError}
          </p>
        `;
      }
      if (this.revisionSource === undefined) {
        return this.revisionReadPending
          ? html`<p>Reading source revision…</p>`
          : html`<p>Source revision read was cancelled.</p>`;
      }
    }
    const files = this.sourceRevision === undefined
      ? source.files
      : this.revisionSource!.files;
    const pattern = this.sourceRevision === undefined
      ? source.pattern
      : this.revisionSource!.pattern;
    if (files.length === 0) {
      return html`
        <p>
          This ${this.sourceRevision
            ? "revision"
            : "piece"}'s source is not available in its space. Its pattern is
          ${pattern
            ? html`
              <code>${pattern.identity}</code>
            `
            : "not recorded"}.
        </p>
      `;
    }
    const file = files[Math.min(this.selectedFile, files.length - 1)];
    return html`
      <pre class="source">${file.contents}</pre>
    `;
  }

  #renderOrigin(source: PieceSourceView): TemplateResult {
    const origin = describeOrigin(source.origin);
    const follow = describeFollowState(source);
    const originView = source.origin?.kind === "fabric-piece"
      ? fabricPieceNavigation(source.origin.url, source.space)
      : undefined;
    return html`
      <dl class="facts">
        <dt>Origin</dt>
        <dd class="prose">
          ${source.unusableOrigin
            ? html`
              Unusable origin —
              <code>${source.unusableOrigin.recorded}</code>
            `
            : html`
              ${origin.label}${source.origin
                ? originView
                  ? html`
                    —
                    <a
                      class="text-link"
                      href="${navigationHref(originView)}"
                      test-id="piece-source-origin-current"
                      @click="${(event: MouseEvent) =>
                        this.#navigate(event, originView)}"
                    ><code>${source.origin.url}</code></a>
                  `
                  : html`
                    — <code>${source.origin.url}</code>
                  `
                : nothing}
              <div class="note">${origin.detail}</div>
            `}
        </dd>
        <dt>Source updates</dt>
        <dd class="prose" test-id="piece-origin-follow-state">
          ${follow.label}${follow.at === undefined
            ? nothing
            : ` · ${formatTimestamp(follow.at)}`}
        </dd>
        ${source.origin?.recorded
          ? html`
            <dt>Recorded as</dt>
            <dd>${source.origin.recorded}</dd>
          `
          : nothing} ${source.pattern
          ? html`
            <dt>Pattern</dt>
            <dd title="${source.pattern.identity}">
              ${patternRefLabel(source.pattern)}
            </dd>
          `
          : nothing} ${source.setupPattern &&
            (source.setupPattern.identity !== source.pattern?.identity ||
              source.setupPattern.symbol !== source.pattern?.symbol)
          ? html`
            <dt>Setup applied for</dt>
            <dd title="${source.setupPattern.identity}">
              ${patternRefLabel(source.setupPattern)}
            </dd>
          `
          : nothing} ${source.displacedPattern
          ? html`
            <dt>Previously ran</dt>
            <dd title="${source.displacedPattern.identity}">
              ${patternRefLabel(source.displacedPattern)}${source
                  .displacedPattern.displacedAt
                ? ` · replaced ${
                  formatTimestamp(source.displacedPattern.displacedAt)
                }`
                : ""}
            </dd>
          `
          : nothing} ${source.repository
          ? html`
            <dt>Repository</dt>
            <dd>${source.repository}</dd>
          `
          : nothing} ${source.entry
          ? html`
            <dt>Entry file</dt>
            <dd>${source.entry}</dd>
          `
          : nothing}
        <dt>Files retained</dt>
        <dd>${source.files.length}</dd>
        <dt>Piece</dt>
        <dd>${source.pieceId}</dd>
        <dt>Space</dt>
        <dd>
          <a
            class="text-link"
            href="${navigationHref({ spaceDid: source.space })}"
            test-id="piece-source-space"
            @click="${(event: MouseEvent) =>
              this.#navigate(event, { spaceDid: source.space })}"
          >${source.space}</a>
        </dd>
      </dl>
      ${this.#renderFollowState(follow)} ${this.sourceActionError &&
          !this.originEntryOpen
        ? html`
          <p class="error">
            Could not change this piece's source: ${this.sourceActionError}
          </p>
        `
        : nothing} ${this.sourceExecutionWarning
        ? html`
          <p class="error">
            The source change was saved, but a later refresh failed: ${this
              .sourceExecutionWarning}
          </p>
        `
        : nothing} ${this.originEntryOpen
        ? nothing
        : this.#renderCompatibilityWarning()}
      <div class="source-actions">
        ${source.origin !== undefined || source.unusableOrigin !== undefined
          ? html`
            <button
              class="source-action"
              test-id="piece-origin-detach-source"
              ?disabled="${this.sourceActionPending}"
              @click="${() => this.changeSource({ kind: "detach" })}"
            >
              Stop following source
            </button>
          `
          : nothing}
        ${this.#renderOriginEntryOpener()}
      </div>
      ${this.#renderHistory(source)}
    `;
  }

  /**
   * What following the origin last did, and what can be done about it.
   *
   * Only the states with something to say get a box. A piece running what its
   * origin offered has nothing wrong with it, and a piece that records no
   * origin has nothing to say about one, so both are left to the facts above:
   * a box with a button in it reads as a problem to fix. The states that may
   * still come good on their own read as notes rather than as errors.
   */
  #renderFollowState(follow: FollowDescription) {
    if (follow.state === "detached" || follow.state === "following") {
      return nothing;
    }
    const offered = follow.offered;
    const settled = follow.state === "refused" || follow.state === "unusable";
    return html`
      <div
        class="follow-state ${settled ? "" : "note-state"}"
        role="status"
        test-id="piece-origin-follow-detail"
      >
        <p><strong>${follow.summary}</strong> ${follow.detail}</p>
        ${follow.reason
          // Written on one line: this paragraph keeps its whitespace, so the
          // template's indentation would otherwise be rendered with it.
          ? html`<p class="follow-reason"><span>Reason:</span> ${follow.reason}</p>`
          : nothing} ${offered
          ? html`
            <p title="${offered.identity}">
              The origin is offering ${patternRefLabel(offered)}.
            </p>
          `
          : nothing}
        ${follow.canUpdate
          ? html`
            <div class="warning-actions">
              <button
                test-id="piece-origin-update-now"
                ?disabled="${this.sourceActionPending}"
                @click="${() => this.changeSource({ kind: "adopt" })}"
              >
                Update from the origin now
              </button>
              ${follow.canForce
                ? html`
                  <button
                    test-id="piece-origin-force-update"
                    ?disabled="${this.sourceActionPending}"
                    @click="${() => this.forceUpdateFromOrigin()}"
                  >
                    Update, ignoring the compatibility check
                  </button>
                `
                : nothing}
            </div>
          `
          : nothing}
      </div>
    `;
  }

  /**
   * The control that asks for an origin. A piece with no origin gets it too:
   * gaining one is the same operation as moving to another.
   */
  #renderOriginEntryOpener() {
    return html`
      <button
        class="source-action"
        test-id="piece-origin-enter-source"
        ?disabled="${this.sourceActionPending}"
        @click="${() => this.#openOriginEntry()}"
      >
        Follow another source...
      </button>
    `;
  }

  /**
   * The dialog that moves a piece to an origin it has never followed. It sits
   * over the origin panel rather than opening inside it: asking for a URL
   * neither displaces the panel's own content nor puts a second Cancel beside
   * the one an incompatibility warning offers.
   *
   * The origin is resolved and adopted when the dialog is submitted, so a URL
   * nothing answers is reported here, with what was typed still in the field,
   * rather than recorded on the piece.
   */
  #renderOriginEntryDialog(): TemplateResult {
    const pending = this.sourceActionPending;
    // A warning is an answer about the URL in the field, so the same submit
    // accepts it. What the reader confirms is the candidate the check
    // reviewed, not a fresh resolution of the origin.
    const warning = this.compatibilityWarning;
    const failure = this.sourceActionError === undefined
      ? undefined
      : describeSourceFailure(this.sourceActionError);
    return html`
      <div
        class="backdrop dimmed stacked"
        @click="${() => {
          if (!pending) this.#closeOriginEntry();
        }}"
      ></div>
      <form
        class="panel stacked"
        role="dialog"
        aria-label="Follow another source"
        test-id="piece-origin-entry"
        @submit="${this.#followEnteredOrigin}"
      >
        <div class="panel-head">
          <h2>Follow another source</h2>
          <span class="subject">${this.source?.name ?? this.cell?.id() ??
            ""}</span>
        </div>
        <div class="panel-body">
          <label class="origin-entry-label" for="piece-origin-url">
            The web or fabric URL this piece should follow. It is fetched when
            you confirm, and this piece adopts the source found there.
          </label>
          <input
            id="piece-origin-url"
            class="access-input origin-entry-input"
            test-id="piece-origin-url"
            placeholder="https://... or cf:..."
            .value="${this.originEntryUrl}"
            ?disabled="${pending}"
            @input="${this.#onOriginEntryUrl}"
          />
          ${failure
            ? html`
              <div class="warning" role="alert" test-id="piece-origin-failure">
                <p>${failure.summary}</p>
                <p class="follow-reason"><span>Reason:</span> ${failure
                  .reason}</p>
              </div>
            `
            : nothing} ${warning
            ? html`
              <div
                class="warning"
                role="alert"
                test-id="piece-origin-entry-warning"
              >
                <p>
                  This source changes the piece's data contract: ${warning
                    .message}
                </p>
                <p>
                  Following it anyway keeps the piece's data as it stands. The
                  piece may not read all of it.
                </p>
              </div>
            `
            : nothing}
        </div>
        <div class="panel-foot">
          <button
            class="source-action"
            type="button"
            test-id="piece-origin-entry-cancel"
            ?disabled="${pending}"
            @click="${() => this.#closeOriginEntry()}"
          >
            Cancel
          </button>
          <button
            class="source-action"
            type="submit"
            test-id="piece-origin-follow-entered"
            ?disabled="${pending || this.originEntryUrl.trim().length === 0}"
          >
            ${pending
              ? "Following…"
              : warning
              ? "Follow this source anyway"
              : "Follow this source"}
          </button>
        </div>
      </form>
    `;
  }

  #renderCompatibilityWarning() {
    const warning = this.compatibilityWarning;
    if (warning === undefined) return nothing;
    return html`
      <div class="warning" role="alert" test-id="piece-source-warning">
        <p>
          This source version changes the piece's data contract: ${warning
            .message}
        </p>
        <div class="warning-actions">
          ${html`
            <button
              test-id="piece-source-warning-confirm"
              ?disabled="${this.sourceActionPending}"
              @click="${() =>
                this.changeSource(warning.action, warning.confirmationToken)}"
            >
              Use it anyway
            </button>
          `} ${html`
            <button
              test-id="piece-source-warning-cancel"
              ?disabled="${this.sourceActionPending}"
              @click="${() => {
                this.compatibilityWarning = undefined;
              }}"
            >
              Cancel
            </button>
          `}
        </div>
      </div>
    `;
  }

  #renderHistory(source: PieceSourceView) {
    if (source.history.length === 0) {
      return html`
        <section class="history">
          <h3>Source history</h3>
          <p class="note">
            No source changes have been recorded yet. The first change will retain this
            current version as the baseline.
          </p>
        </section>
      `;
    }
    return html`
      <section class="history">
        <h3>Source history</h3>
        ${[...source.history].reverse().map((revision) =>
          this.#renderRevision(source, revision)
        )}
      </section>
    `;
  }

  #renderRevision(
    source: PieceSourceView,
    revision: PieceSourceRevisionView,
  ) {
    const current = revision.revisionId === source.currentRevisionId;
    const origin = describeOrigin(revision.origin);
    const alreadyFollowing = revision.origin !== undefined &&
      source.origin?.url === revision.origin.url;
    const originView = revision.origin?.kind === "fabric-piece"
      ? fabricPieceNavigation(revision.origin.url, source.space)
      : undefined;
    // The entry shows the string the piece recorded. A deployment-served
    // origin is the only kind that resolves to a URL a browser can open, so
    // only that kind offers the route beside the string, and only when the
    // route is not already the string on show.
    const recordedForm = revision.origin?.recorded ?? revision.origin?.url;
    const openableRoute = revision.origin?.kind === "system" &&
        recordedForm !== revision.origin.url
      ? revision.origin.url
      : undefined;
    return html`
      <article class="revision" test-id="piece-source-revision">
        <div class="revision-head">
          <strong>
            ${sourceOperationLabel(revision.operation)}${current
              ? " · Current"
              : ""}
          </strong>
          <span>${formatTimestamp(revision.timestamp)}</span>
        </div>
        <div class="revision-details">
          Pattern ${patternRefLabel(revision.pattern)} ·
          <button
            type="button"
            class="text-link"
            test-id="piece-source-view-${revision.revisionId}"
            ?disabled="${this.revisionReadPending &&
              this.sourceRevision?.revisionId === revision.revisionId}"
            @click="${(event: MouseEvent) =>
              this.#showRevisionSource(event, revision)}"
          >view source</button>
        </div>
        <div class="revision-details">
          ${origin.label}${revision.origin
            ? originView
              ? html`
                —
                <a
                  class="text-link"
                  href="${navigationHref(originView)}"
                  test-id="piece-source-origin-${revision.revisionId}"
                  @click="${(event: MouseEvent) =>
                    this.#navigate(event, originView)}"
                ><code>${revision.origin.url}</code></a>
              `
              : html`
                — <code>${recordedForm}</code>${openableRoute
                  ? html`
                    ·
                    <a
                      class="text-link"
                      href="${openableRoute}"
                      target="_blank"
                      rel="noopener noreferrer"
                      test-id="piece-source-origin-open-${revision.revisionId}"
                    >open</a>
                  `
                  : nothing}
              `
            : nothing}
        </div>
        ${current ? nothing : html`
          <div class="revision-actions">
            <button
              test-id="piece-source-restore"
              ?disabled="${this.sourceActionPending}"
              @click="${() =>
                this.changeSource({
                  kind: "restore",
                  revisionId: revision.revisionId,
                })}"
            >
              Use this version
            </button>
            ${revision.origin !== undefined && !alreadyFollowing
              ? html`
                <button
                  test-id="piece-source-follow"
                  ?disabled="${this.sourceActionPending}"
                  @click="${() =>
                    this.changeSource({
                      kind: "follow",
                      revisionId: revision.revisionId,
                    })}"
                >
                  ${revision.origin.kind === "fabric-pattern"
                    ? "Use this pinned source again"
                    : "Follow this source again"}
                </button>
              `
              : nothing}
          </div>
        `}
      </article>
    `;
  }
}

/** The shell view named by a mutable Fabric piece origin. */
function fabricPieceNavigation(
  url: string,
  currentSpace: DID,
): NavigationCommand | undefined {
  let ref;
  try {
    ref = parseFabricRef(url);
  } catch {
    return undefined;
  }
  if (
    ref === undefined || ref.host !== undefined || ref.pin !== undefined ||
    ref.subpath !== undefined
  ) {
    return undefined;
  }
  const space = ref.space;
  const spaceView = space === undefined
    ? { spaceDid: currentSpace }
    : isDID(space)
    ? { spaceDid: space }
    : { spaceName: space };
  if (ref.ref.kind === "slug") {
    return { ...spaceView, pieceSlug: ref.ref.slug };
  }
  if (ref.ref.scheme === "pattern") return undefined;
  return {
    ...spaceView,
    pieceId: `${ref.ref.scheme}:fid1:${ref.ref.hash}`,
  };
}

/** A native link target that keeps the shell's current display mode. */
function navigationHref(command: NavigationCommand): string {
  try {
    return appViewToUrlPath(
      preserveAppViewMode(
        urlToAppView(new URL(globalThis.location.href)),
        command,
      ),
    );
  } catch {
    return appViewToUrlPath(command);
  }
}

function sourceOperationLabel(
  operation: PieceSourceRevisionView["operation"],
): string {
  switch (operation) {
    case "baseline":
      return "Baseline";
    case "create":
      return "Created from source";
    case "edit":
      return "Direct source edit";
    case "origin-update":
      return "Source update";
    case "detach":
      return "Stopped following source";
    case "revert":
      return "Restored source version";
    case "follow":
      return "Followed source";
    case "repoint":
      return "Followed earlier source";
  }
}

/**
 * The theme tokens the menu reads. Mounting outside `cf-theme`'s subtree is what
 * keeps the menu clear of a piece's clipping and scaling, and it also puts it
 * out of reach of the inherited theme variables, so these are copied across from
 * the element that opened it.
 */
const THEME_VARIABLES = [
  "--cf-theme-font-family",
  "--cf-theme-font-mono",
  "--cf-theme-color-text",
  "--cf-theme-color-text-muted",
  "--cf-theme-color-surface",
  "--cf-theme-color-surface-hover",
  "--cf-theme-color-border",
  "--cf-theme-color-error",
];

/** Copy the menu's theme tokens from `from`, resolved, onto `to`. */
function copyThemeVariables(from: Element, to: HTMLElement): void {
  const computed = globalThis.getComputedStyle(from);
  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) to.style.setProperty(name, value);
    else to.style.removeProperty(name);
  }
}

/**
 * The one menu element, mounted on `document.body`. A single shared instance
 * means a right-click while a menu is open replaces it rather than stacking
 * another overlay. The shared element stays mounted between openings, including
 * when the `cf-render` that opened it disconnects and closes it.
 */
let shared: CFPieceMenu | undefined;

/**
 * Show the menu at a click position, mounting it on `document.body` the first
 * time. It addresses either a piece — `cell`, which the space and runtime are
 * read from — or a space with no piece, named by `space` and reached through
 * `runtime`. A call carrying neither leaves the menu closed.
 */
export function openPieceMenu(
  { cell, space, runtime, x, y, themeFrom, highlightedPiece, highlightTarget }:
    {
      cell?: CellHandle;

      /** The space to address when the click landed on no piece. */
      space?: DID;

      /** The runtime that space is reached through, alongside `space`. */
      runtime?: RuntimeClient;

      x: number;
      y: number;

      /** The element the click came from, whose theme the menu adopts. */
      themeFrom?: Element;

      /** The rendered piece to highlight while the menu remains open. */
      highlightedPiece?: Element;

      /** A nested pattern root to highlight within the rendered piece. */
      highlightTarget?: Element;
    },
): CFPieceMenu {
  if (!shared || !shared.isConnected) {
    shared = globalThis.document.createElement("cf-piece-menu") as CFPieceMenu;
    globalThis.document.body.appendChild(shared);
  }
  if (themeFrom) copyThemeVariables(themeFrom, shared);
  shared.open({
    cell,
    space,
    runtime,
    x,
    y,
    highlightedPiece,
    highlightTarget,
  });
  return shared;
}

/** Close the shared menu if `piece` is the render element that opened it. */
export function closePieceMenuFor(piece: Element): void {
  shared?.closeFor(piece);
}
