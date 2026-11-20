import type { DID } from "@commonfabric/identity";
import { Task, TaskStatus } from "@lit/task";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import { iconClose } from "../components/icons.ts";
import {
  type PatternChange,
  type RuntimeInternals,
  type SpaceHistoryStep,
  withOlderSteps,
} from "../lib/runtime.ts";
import { BaseView } from "./BaseView.ts";

/** The step of history a fork shows, and where the fork stands. */
export type OpenHistory = {
  /** The point of the space's history the fork was taken at. */
  seq: number;

  /** Whether the fork is still being opened, restored or closed. */
  busy: boolean;
};

/** A restore of a piece's pattern code the panel asked for, and its state. */
export type PatternRestore = {
  /** The piece whose pattern is being restored. */
  pieceId: string;

  /** The source revision it is being restored to. */
  revisionId: string;

  /** The scope that completes `pieceId` into a document address. */
  scope?: PatternChange["scope"];

  /** Whether the runtime has yet to answer. */
  busy: boolean;

  /**
   * Why the runtime did not restore the source: it does not fit the piece's
   * data as it stands.
   */
  warning?: string;

  /** The token that, sent back, restores the source despite `warning`. */
  confirmationToken?: string;

  /** Why the restore failed, when it did. */
  error?: string;
};

/** Returns what the step list calls `step`. */
function stepLabel(step: SpaceHistoryStep): string {
  switch (step.kind) {
    case "event":
      return step.events === 1 ? "Event" : `${step.events} events`;
    case "restore":
      return `Restored to #${step.restoredSeq}`;
    case "write":
      return "Edit";
  }
}

/**
 * Returns `did` short enough for a line of the step list: its method and
 * the start and end of its identifier.
 */
function shortDid(did: string): string {
  return did.length <= 24 ? did : `${did.slice(0, 14)}…${did.slice(-6)}`;
}

/**
 * The panel listing the steps of the viewed space's history. Choosing a step
 * asks the root for a fork of the space as that step left it, which the rest
 * of the shell then shows, and the panel offers the way back and the way to
 * restore the space to what the fork holds.
 */
export class XHistoryView extends BaseView {
  static override styles = css`
    :host {
      position: fixed;
      z-index: 999;
      top: 4rem;
      right: 1rem;
      bottom: 1rem;
      display: flex;
      flex-direction: column;
      width: min(20rem, calc(100vw - 2rem));
      border: 1px solid
        var(--shell-divider, var(--cf-theme-color-border, #111));
      border-radius: 0.75rem;
      color: var(--font-color, var(--cf-theme-color-text, #111));
      background: var(--shell-surface, var(--cf-theme-color-surface, #fff));
      box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 18%);
      font-size: 0.875rem;
    }

    header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem;
    }

    h2 {
      flex: 1;
      margin: 0;
      font-size: 1rem;
    }

    button {
      font: inherit;
      color: inherit;
      background: none;
      border: 0;
      cursor: pointer;
    }

    .icon-button {
      width: 1.5rem;
      height: 1.5rem;
      padding: 0.125rem;
    }

    .open {
      display: grid;
      gap: 0.5rem;
      padding: 0.75rem;
      border-top: 1px solid
        var(--shell-divider, var(--cf-theme-color-border, #111));
    }

    .open p {
      margin: 0;
      line-height: 1.35;
    }

    .actions {
      display: flex;
      gap: 0.5rem;
    }

    ol {
      flex: 1;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
      border-top: 1px solid
        var(--shell-divider, var(--cf-theme-color-border, #111));
    }

    .step {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.125rem 0.5rem;
      width: 100%;
      padding: 0.5rem 0.75rem;
      text-align: left;
    }

    .step:hover,
    .step[aria-current="true"] {
      background: rgb(127 127 127 / 18%);
    }

    .step:disabled {
      cursor: default;
      opacity: 0.6;
    }

    .detail {
      opacity: 0.65;
      font-size: 0.75rem;
    }

    .by {
      grid-column: 1 / -1;
    }

    .pattern-change {
      display: grid;
      gap: 0.25rem;
      justify-items: start;
      padding: 0 0.75rem 0.5rem 1.5rem;
    }

    .pattern-change .note {
      padding: 0;
    }

    .note {
      margin: 0;
      padding: 0.75rem;
      opacity: 0.75;
    }

    .error {
      color: var(--cf-theme-color-error, #b00020);
    }
  `;

  /** The runtime of the space as it stands, whose history this lists. */
  @property({ attribute: false })
  accessor rt: RuntimeInternals | undefined = undefined;

  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  /** The fork the shell is showing, when it is showing one. */
  @property({ attribute: false })
  accessor open: OpenHistory | undefined = undefined;

  /** Why the last fork, return or restore failed, when one did. */
  @property({ attribute: false })
  accessor error: string | undefined = undefined;

  /**
   * The piece in view, where the view names one by id: its pattern changes
   * are listed whether or not the space lists the piece.
   */
  @property({ attribute: false })
  accessor pieceId: string | undefined = undefined;

  /** The scope that completes `pieceId`, where it is not the space's. */
  @property({ attribute: false })
  accessor pieceScope: PatternChange["scope"] = undefined;

  /** The pattern restore the panel asked for, while it is unsettled. */
  @property({ attribute: false })
  accessor patternRestore: PatternRestore | undefined = undefined;

  /**
   * How many changes the shell has made that add to the space's history; a
   * new count lists the history again.
   */
  @property({ attribute: false })
  accessor changes = 0;

  /** The steps listed so far, newest first. */
  @state()
  private accessor _steps: readonly SpaceHistoryStep[] = [];

  /** The seq the next older stretch of history starts below. */
  @state()
  private accessor _next: number | undefined = undefined;

  /** How many listings have begun, which tells a superseded one apart. */
  #listing = 0;

  /**
   * Lists a stretch of history: the newest when `before` is absent, which
   * replaces the list, and otherwise the one below `before`, which extends
   * it.
   */
  #list = new Task<[number | undefined], void>(this, {
    task: async ([before]) => {
      const { rt, space, pieceId, pieceScope } = this;
      const listing = ++this.#listing;
      if (rt === undefined || space === undefined) {
        this._steps = [];
        this._next = undefined;
        return;
      }
      const page = await rt.spaceHistory(
        space,
        before,
        pieceId === undefined ? [] : [{
          id: pieceId,
          ...(pieceScope !== undefined ? { scope: pieceScope } : {}),
        }],
      );
      // A stretch that arrives after a later listing began belongs to a list
      // that one has replaced.
      if (listing !== this.#listing) return;
      this._steps = before === undefined
        ? page.steps
        : withOlderSteps(this._steps, page.steps);
      this._next = page.next;
    },
  });

  protected override willUpdate(changed: PropertyValues<this>): void {
    const moved = changed.has("rt") || changed.has("space");
    // The steps of another space name points of a history this space does
    // not have, so none is left to choose while its own are listed.
    if (moved) {
      this._steps = [];
      this._next = undefined;
    }
    // Returning from a fork, by discarding it or restoring from it, is what
    // can have added to the space's history; opening one adds nothing, and
    // keeps the stretch the open step was chosen from.
    if (
      moved || changed.has("changes") || changed.has("pieceId") ||
      changed.has("pieceScope") ||
      (changed.has("open") && this.open === undefined)
    ) {
      void this.#list.run([undefined]);
    }
  }

  #close = (): void => {
    this.command({ type: "set-config", key: "showHistoryView", value: false });
  };

  #renderOpen(open: OpenHistory) {
    return html`
      <section class="open" role="status">
        <p>
          Showing this space as it stood at #${open.seq}. Changes you make
          here stay in this view and are discarded when you leave it.
          Restoring sets the space back to this point and does not carry
          them over.
        </p>
        <div class="actions">
          <cf-button
            id="history-back"
            variant="outline"
            ?disabled="${open.busy}"
            @click="${() => this.command({ type: "close-history" })}"
          >Back to now</cf-button>
          <cf-button
            id="history-restore"
            ?disabled="${open.busy}"
            @click="${() => this.command({ type: "restore-history" })}"
          >Restore this version</cf-button>
        </div>
      </section>
    `;
  }

  /**
   * Renders one step. `eventIndex` counts the `event` steps listed before
   * this one, which gives a test a stable way to name such a step.
   */
  #renderStep(step: SpaceHistoryStep, eventIndex: number) {
    const current = this.open?.seq === step.seq;
    return html`
      <li>
        <button
          class="step"
          data-kind="${step.kind}"
          data-seq="${step.seq}"
          data-event-index="${step.kind === "event" ? eventIndex : nothing}"
          aria-current="${current ? "true" : "false"}"
          ?disabled="${this.open?.busy === true || current}"
          @click="${() =>
            this.command({ type: "open-history", seq: step.seq })}"
        >
          <span>${stepLabel(step)}</span>
          <span class="detail">#${step.seq}</span>
          <span class="detail">${new Date(step.at).toLocaleString()}</span>
          <span class="detail">${step.settled ? "" : "in progress"}</span>
          ${step.principal === undefined ? nothing : html`
            <span class="detail by" title="${step.principal}">
              by ${shortDid(step.principal)}
            </span>
          `}
        </button>
        ${step.patternChanges.map((change) =>
          this.#renderPatternChange(change)
        )}
      </li>
    `;
  }

  /**
   * Renders one change of a piece's pattern code a step recorded, with the
   * way to put the piece back on that code without touching its data.
   */
  #renderPatternChange(change: PatternChange) {
    const restore = this.patternRestore;
    const mine = restore?.pieceId === change.pieceId &&
      restore.revisionId === change.revisionId;
    const blocked = this.open !== undefined || restore?.busy === true;
    return html`
      <div
        class="pattern-change"
        data-revision="${change.revisionId}"
      >
        <span>
          ${change.pieceName ?? `Piece #${change.pieceId.slice(-6)}`}:
          ${change.label}${change.current ? " · Current" : ""}
        </span>
        <span class="detail">${change.originLabel}</span>
        ${change.current ? nothing : html`
          <cf-button
            class="pattern-restore"
            variant="outline"
            size="sm"
            title="Puts the piece back on this version of its pattern code and keeps its current data"
            ?disabled="${blocked}"
            @click="${() =>
              this.command({
                type: "restore-pattern",
                pieceId: change.pieceId,
                revisionId: change.revisionId,
                ...(change.scope !== undefined ? { scope: change.scope } : {}),
              })}"
          >Restore this pattern version</cf-button>
        `}
        ${mine && restore?.warning !== undefined
          ? html`
            <p class="note error" role="alert">${restore.warning}</p>
            ${restore.confirmationToken === undefined ? nothing : html`
              <cf-button
                class="pattern-restore-confirm"
                size="sm"
                ?disabled="${blocked}"
                @click="${() =>
                  this.command({
                    type: "restore-pattern",
                    pieceId: change.pieceId,
                    revisionId: change.revisionId,
                    ...(change.scope !== undefined
                      ? { scope: change.scope }
                      : {}),
                    confirmationToken: restore.confirmationToken,
                  })}"
              >Restore it anyway</cf-button>
            `}
          `
          : nothing}
        ${mine && restore?.error !== undefined
          ? html`
            <p class="note error" role="alert">${restore.error}</p>
          `
          : nothing}
      </div>
    `;
  }

  override render() {
    const failed = this.#list.status === TaskStatus.ERROR;
    let events = 0;
    return html`
      <header>
        <h2>History</h2>
        <button
          class="icon-button"
          aria-label="Close history"
          @click="${this.#close}"
        >${iconClose()}</button>
      </header>
      ${this.open === undefined ? nothing : this.#renderOpen(this.open)}
      ${this.error === undefined ? nothing : html`
        <p class="note error" role="alert">${this.error}</p>
      `}
      ${failed
        ? html`
          <p class="note error" role="alert">
            This space's history could not be listed.
          </p>
        `
        : this._steps.length === 0 &&
            this.#list.status === TaskStatus.COMPLETE
        ? html`
          <p class="note">Nothing has happened in this space yet.</p>
        `
        : nothing}
      <ol aria-label="Steps of this space's history">
        ${this._steps.map((step) =>
          this.#renderStep(step, step.kind === "event" ? events++ : events)
        )}
        ${this._next === undefined ? nothing : html`
          <li>
            <button
              class="step"
              @click="${() => void this.#list.run([this._next])}"
            >Show older steps</button>
          </li>
        `}
      </ol>
    `;
  }
}

globalThis.customElements.define("x-history-view", XHistoryView);
