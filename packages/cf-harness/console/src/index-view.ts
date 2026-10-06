/**
 * The Index view: the pattern index as an operator reads it. What is
 * published and how it ranks, what this identity did with it, and what a query
 * would actually return — the last beside the request that produced it, because
 * the point of the playground is the search's behavior rather than its answer.
 *
 * Every read goes through the server, which signs it with the fabric identity
 * and refuses anything outside its allowlist. Source is not among what this
 * surface asks for: a pattern's metadata, schemas, dependencies and events are
 * what it shows, and source is read through the CLI.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import {
  eventBadges,
  filterEvents,
  formatIndexTime,
  matchRatio,
  patternsByScore,
  searchRequestOf,
  truncateId,
} from "../index-inspector.ts";
import type {
  PatternIndexEvent,
  PatternIndexListedPattern,
  PatternIndexPattern,
  PatternIndexSearchResult,
} from "../../src/pattern-index/client.ts";
import {
  listIndexEvents,
  listIndexPatterns,
  readIndexPattern,
  searchIndexPatterns,
} from "./api.ts";

/** One pattern read open, and that pattern's own events beside it. */
interface OpenPattern {
  patternId: string;
  pattern?: PatternIndexPattern;
  events?: readonly PatternIndexEvent[];
  error?: string;

  /** Why `events` is absent when its read failed rather than pending. */
  eventsError?: string;
}

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

export class ConsoleIndexView extends LitElement {
  static override properties = {
    patterns: { attribute: false },
    eventTypes: { attribute: false },
    patternsError: { attribute: false },
    open: { attribute: false },
    events: { attribute: false },
    eventsError: { attribute: false },
    eventFilter: { attribute: false },
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
  declare events: readonly PatternIndexEvent[];
  declare eventsError: string | undefined;
  declare eventFilter: string;

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

  /** Which search is current, for the same reason. */
  #searches = 0;

  constructor() {
    super();
    this.patterns = [];
    this.eventTypes = {};
    this.events = [];
    this.eventFilter = "";
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
   * Re-reads both listings. Neither read's failure hides the other's answer,
   * and a refresh superseded by a newer one writes nothing — two clicks in
   * flight must not let the older answer land last.
   */
  async refresh(): Promise<void> {
    const generation = ++this.#refreshes;
    await Promise.all([
      this.#loadPatterns(generation),
      this.#loadEvents(generation),
    ]);
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
      this.patternsError = reason(error);
    }
  }

  async #loadEvents(generation: number): Promise<void> {
    try {
      const events = await listIndexEvents({ limit: 100 });
      if (generation !== this.#refreshes) return;
      this.events = events;
      this.eventsError = undefined;
    } catch (error) {
      if (generation !== this.#refreshes) return;
      this.eventsError = reason(error);
    }
  }

  /**
   * Opens one pattern, or closes it when it is the one already open. The
   * pattern and its events are read independently, so one endpoint refusing
   * still shows what the other returned.
   */
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
    const [pattern, events] = await Promise.all([
      readIndexPattern(patternId).catch((error: unknown) => reason(error)),
      listIndexEvents({ patternId }).catch((error: unknown) => reason(error)),
    ]);
    if (read !== this.#detailReads) {
      return;
    }
    this.open = {
      patternId,
      ...(typeof pattern === "string" ? { error: pattern } : { pattern }),
      ...(typeof events === "string" ? { eventsError: events } : { events }),
    };
  }

  async #runSearch(): Promise<void> {
    // The disabled binding lands on the next render, not on the click.
    if (this.searching) return;
    const field = (id: string): string =>
      (this.querySelector(`#${id}`) as HTMLInputElement | null)?.value ?? "";
    const request = searchRequestOf(
      field("index-tags"),
      field("index-text"),
      field("index-limit"),
    );
    const run = ++this.#searches;
    this.searchRequest = prettyJson(request);
    this.searching = true;
    try {
      const response = await searchIndexPatterns(request);
      if (run !== this.#searches) {
        return;
      }
      this.searchResults = response.results;
      this.searchError = undefined;
    } catch (error) {
      if (run !== this.#searches) {
        return;
      }
      this.searchError = reason(error);
      this.searchResults = undefined;
    } finally {
      if (run === this.#searches) {
        this.searching = false;
      }
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

  #eventsTable(events: readonly PatternIndexEvent[]): TemplateResult {
    return html`
      <table class="index-table">
        <thead>
          <tr>
            <th>when</th>
            <th>event</th>
            <th>pattern</th>
            <th>author</th>
            <th>note</th>
          </tr>
        </thead>
        <tbody>
          ${events.map((event) =>
            html`
              <tr>
                <td class="muted">${formatIndexTime(event.ts)}</td>
                <td>${event.eventType}</td>
                <td>${this.#idCell(event.patternId)}</td>
                <td>${this.#idCell(event.did, 14)}</td>
                <td>${event.note ?? ""}</td>
              </tr>
            `
          )}
        </tbody>
      </table>
    `;
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
              owner ${this.#idCell(pattern.ownerDid, 18)} · created
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
        <div class="label">its events</div>
        ${open.eventsError !== undefined
          ? html`<p class="error">${open.eventsError}</p>`
          : open.events === undefined
          ? html`<p class="empty">Reading…</p>`
          : open.events.length === 0
          ? html`<p class="empty">You recorded none against this pattern.</p>`
          : this.#eventsTable(open.events)}
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
            <th>hashtags</th>
            <th>events</th>
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
                <td>${this.#hashtags(pattern.hashtags)}</td>
                <td>
                  ${eventBadges(pattern.events, pattern.eventAuthors).map((
                    badge,
                  ) =>
                    html`<span class="badge">
                    ${badge.eventType} ×${badge.count}
                    · ${
                      badge.did === undefined
                        ? "author unavailable"
                        : this.#idCell(badge.did, 18)
                    }
                  </span>`
                  )}
                </td>
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
                    <td colspan="6">${this.#detail(this.open)}</td>
                  </tr>
                `
                : nothing}
            `
          )}
        </tbody>
      </table>
    `;
  }

  #eventsPane(): TemplateResult {
    if (this.eventsError !== undefined) {
      return html`<p class="empty bad">${this.eventsError}</p>`;
    }
    const showing = filterEvents(this.events, this.eventFilter);
    return html`
      <div class="index-toolbar">
        <label>
          filter
          <input
            .value=${this.eventFilter}
            placeholder="any field"
            @input=${(event: Event) =>
              this.eventFilter = (event.target as HTMLInputElement).value}
          />
        </label>
        <span class="muted">
          ${showing.length} of ${this.events.length} shown
        </span>
      </div>
      ${this.events.length === 0
        ? html`
          <p class="empty">
            ${this.loaded
              ? "This identity has recorded nothing in the index."
              : "Reading…"}
          </p>
        `
        : this.#eventsTable(showing)}
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
          <span>Your events</span>
        </div>
        ${this.#eventsPane()}

        <div class="run-list-head">
          <span>Search</span>
        </div>
        ${this.#searchPane()}
      </div>
    `;
  }
}

customElements.define("console-index-view", ConsoleIndexView);
