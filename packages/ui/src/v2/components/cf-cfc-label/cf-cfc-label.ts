import type { CfcLabelView } from "@commonfabric/runtime-client";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { css, html } from "lit";

import { BaseElement } from "../../core/base-element.ts";

type LabelKey = "confidentiality" | "integrity";

type CfcLabelVariant = "full" | "badge";

type CfcLabelFilter = {
  atom?: string;
  kind?: string;
};

type CfcLabelQueryableValue = {
  getCfcLabel(): Promise<CfcLabelView | undefined>;
};

type CfcLabelSubscribableValue = {
  subscribe(
    callback: (value: unknown, cfcLabel?: CfcLabelView | undefined) => void,
    options?: { includeCfcLabel?: boolean },
  ): () => void;
};

const LABEL_KEYS = [
  "confidentiality",
  "integrity",
] as const satisfies readonly LabelKey[];

const hasLabelQuery = (value: unknown): value is CfcLabelQueryableValue =>
  isObjectOrArray(value) &&
  "getCfcLabel" in value &&
  typeof (value as { getCfcLabel?: unknown }).getCfcLabel === "function";

const hasLabelSubscription = (
  value: unknown,
): value is CfcLabelSubscribableValue =>
  isObjectOrArray(value) &&
  "subscribe" in value &&
  typeof (value as { subscribe?: unknown }).subscribe === "function";

const stableObjectEntries = (value: Record<string, unknown>) =>
  Object.keys(value).sort().map((key) => [key, value[key]] as const);

const atomObjectField = (value: unknown, field: string): string | undefined => {
  if (!isObjectNotArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
};

const atomMatchesFilter = (
  value: unknown,
  filter: CfcLabelFilter,
): boolean => {
  if (!filter.atom && !filter.kind) {
    return true;
  }

  if (filter.atom) {
    if (typeof value === "string") {
      return value === filter.atom;
    }
    const candidates = [
      atomObjectField(value, "atom"),
      atomObjectField(value, "id"),
      atomObjectField(value, "type"),
      atomObjectField(value, "name"),
    ];
    if (!candidates.includes(filter.atom)) {
      return false;
    }
  }

  if (filter.kind) {
    return atomObjectField(value, "kind") === filter.kind;
  }

  return true;
};

const filteredLabel = (
  label: CfcLabelView["entries"][number]["label"],
  filter: CfcLabelFilter,
): CfcLabelView["entries"][number]["label"] | undefined => {
  const result: CfcLabelView["entries"][number]["label"] = {};
  for (const key of LABEL_KEYS) {
    const values = label[key];
    if (!Array.isArray(values)) {
      continue;
    }
    const filtered = values.filter((value) => atomMatchesFilter(value, filter));
    if (filtered.length > 0) {
      result[key] = filtered;
    }
  }
  return LABEL_KEYS.some((key) => Array.isArray(result[key]))
    ? result
    : undefined;
};

export const filterCfcLabelView = (
  view: CfcLabelView | undefined,
  filter: CfcLabelFilter,
): CfcLabelView | undefined => {
  if (!view) {
    return undefined;
  }
  const entries = view.entries.flatMap((entry) => {
    const label = filteredLabel(entry.label, filter);
    return label ? [{ path: [...entry.path], label }] : [];
  });
  return entries.length > 0 ? { version: 1, entries } : undefined;
};

export const formatCfcLabelAtom = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isObjectNotArray(value)) {
    return JSON.stringify(Object.fromEntries(
      stableObjectEntries(value as Record<string, unknown>),
    ));
  }
  return JSON.stringify(value);
};

const formatPath = (path: readonly string[]): string =>
  path.length === 0 ? "/" : `/${path.join("/")}`;

/**
 * Renders the CFC label associated with a bound CellHandle value.
 *
 * The `full` variant lists every label entry that passes the filter. The
 * `badge` variant renders a single pill that reads as present when an
 * integrity atom passes the filter, which makes it the compact way to show
 * that a displayed value carries a particular integrity atom. Confidentiality
 * atoms never make the badge present.
 *
 * @element cf-cfc-label
 *
 * @prop {unknown} value - Usually supplied via `$value`; queried for CFC label IPC.
 * @attr {string} atom - Optional exact atom filter.
 * @attr {string} kind - Optional object-atom kind filter.
 * @attr {"full"|"badge"} variant - Presentation; defaults to `full`.
 * @attr {string} text - Badge text when a filtered integrity atom is present;
 *   defaults to "Verified". Without one the badge reads "Unverified".
 */
export class CFCFCLabel extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      color: var(--cf-theme-color-text, hsl(0, 0%, 9%));
      font-size: 0.8125rem;
      line-height: 1.4;
    }

    .label-view {
      display: grid;
      gap: var(--cf-size-sm-spacing, 4px);
    }

    .entry {
      display: grid;
      gap: var(--cf-size-sm-spacing, 4px);
      padding: var(--cf-size-md-spacing, 8px);
      border: 1px solid var(--cf-theme-color-border, hsl(0, 0%, 86%));
      border-radius: var(--cf-size-md-radius, 8px);
      background: var(--cf-theme-color-surface, hsl(0, 0%, 98%));
    }

    .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: var(--cf-size-md-font-size, 12px);
      color: var(--cf-theme-color-text-muted, hsl(0, 0%, 45%));
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--cf-size-sm-spacing, 4px);
    }

    .kind {
      color: var(--cf-theme-color-text-muted, hsl(0, 0%, 45%));
      font-weight: 600;
    }

    .atom {
      padding: 0.0625rem 0.375rem;
      border-radius: 999px;
      background: var(--cf-theme-color-muted, hsl(0, 0%, 92%));
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: var(--cf-size-md-font-size, 12px);
    }

    .empty {
      color: var(--cf-theme-color-text-muted, hsl(0, 0%, 45%));
    }

    :host([variant="badge"]) {
      display: inline-block;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.0625rem 0.5rem;
      border-radius: 999px;
      font-size: var(--cf-size-md-font-size, 12px);
      font-weight: 600;
      white-space: nowrap;
    }

    .badge[data-state="present"] {
      color: var(--cf-theme-color-success, var(--cf-colors-green-600, #16a34a));
      background: color-mix(
        in srgb,
        var(--cf-theme-color-success, var(--cf-colors-green-600, #16a34a)) 12%,
        transparent
      );
    }

    .badge[data-state="absent"] {
      color: var(--cf-theme-color-text-muted, hsl(0, 0%, 45%));
      background: var(--cf-theme-color-muted, hsl(0, 0%, 92%));
    }
  `;

  static override properties = {
    value: { attribute: false },
    cfcLabel: { attribute: false },
    atom: { type: String },
    kind: { type: String },
    variant: { type: String, reflect: true },
    text: { type: String },
  };

  declare cfcLabel: CfcLabelView | undefined;
  declare atom: string | undefined;
  declare kind: string | undefined;
  declare variant: CfcLabelVariant;
  declare text: string | undefined;

  private _labelRequestId = 0;
  private _value: unknown = undefined;
  private _observedValue: unknown = undefined;
  private _unsubscribeValue: (() => void) | undefined;

  constructor() {
    super();
    this.cfcLabel = undefined;
    this.atom = undefined;
    this.kind = undefined;
    this.variant = "full";
    this.text = undefined;
  }

  get value(): unknown {
    return this._value;
  }

  set value(next: unknown) {
    const previous = this._value;
    this._value = next;
    this.requestUpdate("value", previous);
    this.refreshForCurrentValue();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.refreshForCurrentValue();
  }

  override disconnectedCallback() {
    this.clearValueSubscription();
    super.disconnectedCallback();
  }

  protected override firstUpdated(
    changedProperties: Map<PropertyKey, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    this.refreshForCurrentValue();
  }

  override updated(changedProperties: Map<PropertyKey, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("value")) {
      this.refreshForCurrentValue();
    }
  }

  private refreshForCurrentValue(): void {
    const isSameValue = Object.is(this.value, this._observedValue);
    this.observeValue(this.value);
    if (!isSameValue) {
      void this.refreshLabel();
    } else if (this.cfcLabel !== undefined) {
      this.requestUpdate("cfcLabel");
    }
  }

  private observeValue(value: unknown): boolean {
    if (Object.is(value, this._observedValue)) {
      return this._unsubscribeValue !== undefined;
    }

    this.clearValueSubscription();
    this._observedValue = value;

    if (!hasLabelSubscription(value)) {
      return false;
    }

    // Reactive label delivery: the label rides each subscription update and the
    // worker reads it on the sink's tracked tx, so a label-only change re-fires
    // here too — no poll, no separate getCfcLabel round-trip.
    this._unsubscribeValue = value.subscribe((_value, cfcLabel) => {
      this.applyLabel(cfcLabel);
    }, { includeCfcLabel: true });
    return true;
  }

  private clearValueSubscription(): void {
    this._unsubscribeValue?.();
    this._unsubscribeValue = undefined;
    this._observedValue = undefined;
  }

  private applyLabel(cfcLabel: CfcLabelView | undefined): void {
    const previous = this.cfcLabel;
    this.cfcLabel = cfcLabel;
    this.requestUpdate("cfcLabel", previous);
  }

  /**
   * Refreshes the label, as the fallback for a value that exposes
   * `getCfcLabel()` but not `subscribe()` (no live channel). Subscribable
   * values get their label reactively via `observeValue()`.
   */
  async refreshLabel(): Promise<void> {
    const requestId = ++this._labelRequestId;
    if (hasLabelSubscription(this.value) || !hasLabelQuery(this.value)) {
      if (!hasLabelSubscription(this.value)) this.applyLabel(undefined);
      return;
    }
    const cfcLabel = await this.value.getCfcLabel();
    if (requestId === this._labelRequestId) {
      this.applyLabel(cfcLabel);
    }
  }

  override render() {
    const view = filterCfcLabelView(this.cfcLabel, {
      atom: this.atom,
      kind: this.kind,
    });
    if (this.variant === "badge") {
      return this.renderBadge(view);
    }
    if (!view) {
      return html`
        <span class="empty" part="empty">No CFC label</span>
      `;
    }

    return html`
      <div class="label-view" part="label-view">
        ${view.entries.map((entry) =>
          html`
            <div class="entry" part="entry">
              <div class="path" part="path">${formatPath(entry.path)}</div>
              ${LABEL_KEYS.map((key) => {
                const atoms = entry.label[key];
                return Array.isArray(atoms) && atoms.length > 0
                  ? html`
                    <div class="row" part="row">
                      <span class="kind" part="kind">${key}</span>
                      ${atoms.map((atom) =>
                        html`
                          <span class="atom" part="atom">
                            ${formatCfcLabelAtom(atom)}
                          </span>
                        `
                      )}
                    </div>
                  `
                  : null;
              })}
            </div>
          `
        )}
      </div>
    `;
  }

  private renderBadge(view: CfcLabelView | undefined) {
    // Only integrity atoms are claims about where a value came from, so only
    // they can make the badge read as present.
    const atoms = (view?.entries ?? []).flatMap((entry) =>
      entry.label.integrity ?? []
    );
    if (atoms.length === 0) {
      return html`
        <span class="badge" part="badge" data-state="absent">Unverified</span>
      `;
    }
    const title = [...new Set(atoms.map(formatCfcLabelAtom))].join(", ");
    return html`
      <span class="badge" part="badge" data-state="present" title="${title}">
        <span aria-hidden="true">✓</span>${this.text ?? "Verified"}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-cfc-label": CFCFCLabel;
  }
}
