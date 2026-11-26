/**
 * The Index view: the pattern index as an operator reads it. What is
 * published, who published it, where it stands in discovery and how it ranks,
 * and what a query would actually return — the last beside the request that
 * produced it, because the point of the playground is the search's behavior
 * rather than its answer.
 *
 * Every read goes through the server, which signs it with the fabric identity
 * and refuses anything outside its allowlist. Source is not among what this
 * surface asks for: a pattern's metadata, schemas, dependencies and event
 * counts are what it shows, and source is read through the CLI.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type {
  PatternIndexListedPattern,
  PatternIndexPattern,
  PatternIndexSearchResult,
} from "@commonfabric/pattern-index/client";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import {
  eventBadges,
  formatIndexTime,
  listingLabel,
  matchRatio,
  patternsByScore,
  searchRequestOf,
  truncateId,
} from "../index-inspector.ts";
import {
  listIndexPatterns,
  readIndexPattern,
  searchIndexPatterns,
} from "./api.ts";

/** One pattern read open. */
interface OpenPattern {
  patternId: string;
  pattern?: PatternIndexPattern;
  error?: string;
}

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

export class ConsoleIndexView extends LitElement {
  static override properties = {
    patterns: { attribute: false },
    eventTypes: { attribute: false },
    patternsError: { attribute: false },
    open: { attribute: false },
    copied: { attribute: false },
    searchRequest: { attribute: false },
    searchResults: { attribute: false },
    searchError: { attribute: false },
    searching: { attribute: false },
    loaded: { attribute: false },
  };

  declare patterns: readonly PatternIndexListedPattern[];

  /** The weight the index scores each event type at, as it reported them. */
  declare eventTypes: Readonly<Record<string, number>>;

  declare patternsError: string | undefined;
  declare open: OpenPattern | undefined;

  /** The identifier the last copy button copied, so the page can say so. */
  declare copied: string | undefined;

  declare searchRequest: string | undefined;
  declare searchResults: readonly PatternIndexSearchResult[] | undefined;
  declare searchError: string | undefined;
  declare searching: boolean;

  /** False until the first read of the index answers, however it answered. */
  declare loaded: boolean;

  /** Which read of a pattern's detail is current; only the newest may show. */
  #detailReads = 0;

  #refreshes = 0;

  constructor() {
    super();
    this.patterns = [];
    this.eventTypes = {};
    this.searching = false;
    this.loaded = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  /**
   * Re-reads the listing. A refresh superseded by a newer one writes nothing —
   * two clicks in flight must not let the older answer land last.
   */
  async refresh(): Promise<void> {
    const generation = ++this.#refreshes;
    await this.#loadPatterns(generation);
    if (generation === this.#refreshes) {
      this.loaded = true;
    }
  }

  async #loadPatterns(generation: number): Promise<void> {
    try {
      const listing = await listIndexPatterns();
      if (generation !== this.#refreshes) return;
      this.patterns = listing.patterns;
      this.eventTypes = listing.eventTypes ?? {};
      this.patternsError = undefined;
    } catch (error) {
      if (generation !== this.#refreshes) return;
      this.patternsError = describeFailure(error);
    }
  }

  /** Opens one pattern, or closes it when it is the one already open. */
  async #openPattern(patternId: string): Promise<void> {
    if (this.open?.patternId === patternId) {
      // Closing also invalidates a read still in flight, so its late answer
      // cannot reopen the row.
      ++this.#detailReads;
      this.open = undefined;
      return;
    }
    const read = ++this.#detailReads;
    this.open = { patternId };
    const pattern = await readIndexPattern(patternId).catch(describeFailure);
    if (read !== this.#detailReads) {
      return;
    }
    this.open = {
      patternId,
      ...(typeof pattern === "string" ? { error: pattern } : { pattern }),
    };
  }

  async #runSearch(): Promise<void> {
    // One search at a time, so an older answer cannot land over a newer one.
    // The disabled binding lands on the next render, not on the click, so the
    // click is refused here as well.
    if (this.searching) return;
    const field = (id: string): string =>
      (this.querySelector(`#${id}`) as HTMLInputElement | null)?.value ?? "";
    const request = searchRequestOf(
      field("index-tags"),
      field("index-text"),
      field("index-limit"),
    );
    this.searchRequest = prettyJson(request);
    this.searching = true;
    try {
      this.searchResults = (await searchIndexPatterns(request)).results;
      this.searchError = undefined;
    } catch (error) {
      this.searchError = describeFailure(error);
      this.searchResults = undefined;
    } finally {
      this.searching = false;
    }
  }

  /**
   * A truncated identifier that hands over the whole of itself. The column is
   * narrow enough to read a table by and a pattern id is what every other tool
   * wants in full, so the cell is the button.
   */
  #idCell(value: string | undefined, length = 10): TemplateResult {
    if (value === undefined || value === "") {
      return html`<span class="muted">—</span>`;
    }
    return html`
      <button
        class="index-id"
        title=${value}
        type="button"
        @click=${(event: Event) => {
          event.stopPropagation();
          this.copied = value;
          void navigator.clipboard?.writeText(value);
        }}
      >
        ${this.copied === value ? "copied" : truncateId(value, length)}
      </button>
    `;
  }

  #hashtags(hashtags: readonly string[] | undefined): TemplateResult {
    return html`${
      (hashtags ?? []).map((tag) =>
        html`<span class="index-tag">#${tag}</span>`
      )
    }`;
  }

  /**
   * Who published a pattern: the pseudonym the index gives its author, and
   * `you` beside it when the caller is that author.
   */
  #owner(
    entry: { handle?: string; ownerDid?: string; mine?: boolean },
  ): TemplateResult {
    // A deployment that predates handles names the author by DID instead.
    return html`${this.#idCell(entry.handle ?? entry.ownerDid, 14)}${
      entry.mine
        ? html`
          <span class="index-mine">you</span>
        `
        : nothing
    }`;
  }

  #detail(open: OpenPattern): TemplateResult {
    const pattern = open.pattern;
    return html`
      <div class="index-detail">
        ${open.error === undefined
          ? nothing
          : html`<p class="empty bad">${open.error}</p>`}
        ${pattern === undefined
          ? (open.error === undefined
            ? html`<p class="empty">Reading…</p>`
            : nothing)
          : html`
            <div class="label">
              owner ${this.#owner(pattern)} · created
              ${formatIndexTime(pattern.createdAt)}
              ${pattern.priorPatternId === undefined
                ? nothing
                : html`· revises ${this.#idCell(pattern.priorPatternId)}`}
            </div>
            <div class="label">
              dependencies
              <span class="tool">
                ${pattern.dependencies.length === 0
                  ? "none"
                  : pattern.dependencies.join(", ")}
              </span>
            </div>
            ${pattern.argumentSchema === undefined ? nothing : html`
              <div class="label">argument schema</div>
              <pre class="raw">${prettyJson(pattern.argumentSchema)}</pre>
            `}
            ${pattern.resultSchema === undefined ? nothing : html`
              <div class="label">result schema</div>
              <pre class="raw">${prettyJson(pattern.resultSchema)}</pre>
            `}
          `}
      </div>
    `;
  }

  #patternsPane(): TemplateResult {
    if (this.patternsError !== undefined) {
      return html`<p class="empty bad">${this.patternsError}</p>`;
    }
    if (this.patterns.length === 0) {
      return html`
        <p class="empty">
          ${this.loaded ? "The index holds no patterns." : "Reading…"}
        </p>
      `;
    }
    return html`
      <table class="index-table">
        <thead>
          <tr>
            <th>pattern</th>
            <th>description</th>
            <th>owner</th>
            <th>hashtags</th>
            <th>events</th>
            <th>listing</th>
            <th>score</th>
            <th>created</th>
          </tr>
        </thead>
        <tbody>
          ${patternsByScore(this.patterns).map((pattern) =>
            html`
              <tr
                class="index-row ${this.open?.patternId === pattern.patternId
                  ? "open"
                  : ""}"
                @click=${() => this.#openPattern(pattern.patternId)}
              >
                <td>${this.#idCell(pattern.patternId)}</td>
                <td>${pattern.description}</td>
                <td>${this.#owner(pattern)}</td>
                <td>${this.#hashtags(pattern.hashtags)}</td>
                <td>
                  ${eventBadges(pattern.events).map((badge) =>
                    html`<span class="badge">${badge.eventType} ×${badge.count}</span>`
                  )}
                </td>
                <td class="muted">${listingLabel(pattern) ?? "—"}</td>
                <td>
                  ${pattern.score ?? 0}
                  ${pattern.signals?.inherited
                    ? html`<div class="muted">
                      Includes ${pattern.signals.inherited.score} inherited from
                      ${this.#idCell(pattern.signals.inherited.priorPatternId)}
                      as of ${formatIndexTime(pattern.signals.inherited.asOf)}
                    </div>`
                    : nothing}
                </td>
                <td class="muted">${formatIndexTime(pattern.createdAt)}</td>
              </tr>
              ${this.open?.patternId === pattern.patternId
                ? html`
                  <tr class="index-detail-row">
                    <td colspan="8">${this.#detail(this.open)}</td>
                  </tr>
                `
                : nothing}
            `
          )}
        </tbody>
      </table>
    `;
  }

  #searchPane(): TemplateResult {
    return html`
      <div class="index-toolbar">
        <label>tags <input id="index-tags" placeholder="comma,separated" /></label>
        <label>text <input id="index-text" placeholder="free text" /></label>
        <label>limit <input id="index-limit" size="4" value="20" /></label>
        <button
          type="button"
          ?disabled=${this.searching}
          @click=${() => this.#runSearch()}
        >
          Search
        </button>
      </div>
      <div class="index-search">
        <div>
          ${this.searchError !== undefined
            ? html`<p class="empty bad">${this.searchError}</p>`
            : this.searchResults === undefined
            ? html`<p class="empty">No query has been run yet.</p>`
            : this.searchResults.length === 0
            ? html`<p class="empty">No pattern matched.</p>`
            : html`
              <table class="index-table">
                <thead>
                  <tr>
                    <th>match</th>
                    <th>pattern</th>
                    <th>description</th>
                    <th>hashtags</th>
                    <th>uses</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.searchResults.map((result) =>
                    html`
                      <tr>
                        <td>
                          ${matchRatio(result) ??
                            html`<span class="muted">—</span>`}
                        </td>
                        <td>${this.#idCell(result.patternId)}</td>
                        <td>${result.description}</td>
                        <td>${this.#hashtags(result.hashtags)}</td>
                        <td>${result.signals?.uses ?? 0}</td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
            `}
        </div>
        <div>
          <div class="label">request sent</div>
          <pre class="raw">${this.searchRequest ?? "—"}</pre>
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const weights = Object.entries(this.eventTypes)
      .map(([eventType, weight]) => `${eventType}=${weight}`)
      .join(" ");
    return html`
      <div class="index-view">
        <div class="run-list-head">
          <span>
            Patterns
            ${weights === ""
              ? nothing
              : html`<span class="index-weights">${weights}</span>`}
          </span>
          <button class="secondary" type="button" @click=${() =>
            this.refresh()}>
            Refresh
          </button>
        </div>
        ${this.#patternsPane()}

        <div class="run-list-head">
          <span>Search</span>
        </div>
        ${this.#searchPane()}
      </div>
    `;
  }
}

customElements.define("console-index-view", ConsoleIndexView);
