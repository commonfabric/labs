import { Task } from "@lit/task";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { RuntimeInternals } from "../lib/runtime.ts";
import { BaseView } from "./BaseView.ts";

import "../components/OmniLayout.ts";

import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import type { JSONSchema } from "@commonfabric/runner/shared";
import { CellHandle, PieceHandle, VNode } from "@commonfabric/runtime-client";
import type { DID } from "@commonfabric/identity";
import { openPieceMenu } from "@commonfabric/ui";
import { isObjectOrArray } from "@commonfabric/utils/types";

type SubPages = {
  sidebarUI?: VNode;
};

export type LoadError = {
  kind: "space" | "piece";
  error: unknown;
};

const SubPagesSchema = {
  type: "object",
  properties: {
    sidebarUI: { $ref: "#/$defs/vdomNode" },
  },
  $defs: {
    ...rendererVDOMSchema.$defs,
  },
} as const satisfies JSONSchema;

export class XBodyView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 0 1.5rem;
      box-sizing: border-box;
    }

    .content.embedded {
      padding: 0;
    }

    @media (max-width: 768px) {
      .content {
        padding: 1rem;
      }

      .content.embedded {
        padding: 0;
      }
    }

    x-omni-layout {
      flex: 1;
    }

    cf-piece,
    cf-render[slot="main"] {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .load-error {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100%;
      padding: clamp(1rem, 5vw, 3rem);
      box-sizing: border-box;
    }

    .load-error cf-alert {
      width: min(100%, 42rem);
    }

    .load-error h2 {
      margin: 0;
      font: inherit;
      font-weight: 600;
    }

    .load-error-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
    }

    .load-error-details {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      margin-top: 0.75rem;
      padding: 0.75rem;
      border: 1px solid currentColor;
      border-radius: 0.375rem;
      text-align: left;
    }

    .load-error-details span {
      font-size: 0.75rem;
      font-weight: 600;
    }

    .load-error-details code {
      font-family: var(--font-primary, ui-monospace, monospace);
      font-size: 0.8rem;
      font-weight: 400;
      line-height: 1.5;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .runtime-error {
      flex: none;
      margin: 1rem 0 0;
    }
  `;

  @property({ attribute: false })
  accessor rt: RuntimeInternals | undefined = undefined;

  /** The space being viewed, which the piece menu addresses. */
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  @property({ attribute: false })
  accessor activePattern: PieceHandle | undefined = undefined;

  /** Pointer keys selecting a view inside the active result document. */
  @property({ attribute: false })
  accessor piecePath: string[] = [];

  private get activeCell(): CellHandle | undefined {
    let cell: CellHandle | undefined = this.activePattern?.cell();
    for (const key of this.piecePath) cell = cell?.key(key as never);
    return cell;
  }

  @property()
  accessor showShellPieceListView = false;

  @property({ type: Boolean })
  accessor showSidebar = false;

  @property({ attribute: false })
  accessor loadError: LoadError | undefined = undefined;

  @property({ attribute: false })
  accessor runtimeError: LoadError | undefined = undefined;

  @property({ type: Boolean })
  accessor embedded = false;

  #subPages = new Task(this, {
    task: async ([_activePattern, embedded, _path]) => {
      if (embedded) {
        return {
          sidebarUI: undefined,
        };
      }
      const sidebarUI = await getSidebarCell(
        this.activeCell as CellHandle<SubPages> | undefined,
      );
      return {
        sidebarUI,
      };
    },
    args: () => [this.activePattern, this.embedded, this.piecePath],
  });

  /**
   * Open the piece menu over the surface a piece failed to load into. A right
   * click reaches `cf-render` everywhere else, and there is no `cf-render`
   * here, so this stands in for it: the menu is handed the space with no
   * piece, and offers what it can reach without one. Shift reaches the
   * browser's own menu, as it does over piece content, which is how the error
   * text under here is copied.
   */
  #onLoadErrorContextMenu = (event: MouseEvent) => {
    const space = this.space;
    if (event.shiftKey || !space || !this.rt) return;
    event.preventDefault();
    openPieceMenu({
      space,
      runtime: this.rt.runtime(),
      x: event.clientX,
      y: event.clientY,
      themeFrom: this,
    });
  };

  override render() {
    const mainContent = this.loadError
      ? html`
        <div
          slot="main"
          class="load-error"
          @contextmenu="${this.#onLoadErrorContextMenu}"
        >
          <cf-alert status="error">
            <span slot="icon" class="load-error-icon" aria-hidden="true">
              !
            </span>
            <h2 slot="title">
              We could not load this ${this.loadError.kind}
            </h2>
            <span slot="description">
              Try reloading the page. If the problem continues, check that the link is
              correct and that you have access.
            </span>
            <div class="load-error-details">
              <span>Error details</span>
              <code>${loadErrorMessage(this.loadError.error)}</code>
            </div>
          </cf-alert>
        </div>
      `
      : this.activePattern
      ? html`
        <cf-piece slot="main" .pieceId="${this.activePattern.id()}">
          <cf-render .cell="${this.activeCell}"></cf-render>
        </cf-piece>
      `
      : null;

    const sidebar = this.embedded
      ? undefined
      : this.#subPages?.value?.sidebarUI;
    const runtimeError = this.runtimeError
      ? html`
        <cf-alert class="runtime-error" status="error">
          <span slot="icon" class="load-error-icon" aria-hidden="true">!</span>
          <h2 slot="title">
            This ${this.runtimeError.kind} encountered an error
          </h2>
          <span slot="description">
            Some content may not be available. Try reloading the page if the problem
            continues.
          </span>
          <div class="load-error-details">
            <span>Error details</span>
            <code>${loadErrorMessage(this.runtimeError.error)}</code>
          </div>
        </cf-alert>
      `
      : null;

    return html`
      <div class="content ${this.embedded ? "embedded" : ""}">
        ${runtimeError}
        <x-omni-layout .sidebarOpen="${!this.embedded && this.showSidebar}">
          ${mainContent} ${sidebar
            ? html`
              <cf-render slot="sidebar" .cell="${sidebar}"></cf-render>
            `
            : null}
        </x-omni-layout>
      </div>
    `;
  }
}

/** Return the useful detail carried by an unknown thrown value. */
function loadErrorMessage(error: unknown): string {
  try {
    let message: string | undefined;
    if (error instanceof Error) {
      message = error.message;
    } else if (
      isObjectOrArray(error) && "message" in error &&
      typeof error.message === "string"
    ) {
      message = error.message;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
    return message?.trim() || "No additional error details were provided.";
  } catch {
    return "No additional error details were provided.";
  }
}

globalThis.customElements.define("x-body-view", XBodyView);

async function getSidebarCell(
  cell: CellHandle<SubPages> | undefined,
): Promise<CellHandle<VNode> | undefined> {
  if (!cell) return undefined;
  const typedCell = cell.asSchema<SubPages>(SubPagesSchema);
  let value = typedCell.get();
  if (!value) {
    await typedCell.sync();
    value = typedCell.get();
    if (!value) {
      return;
    }
  }
  if (value.sidebarUI) {
    return typedCell.key("sidebarUI").asSchema<VNode>(rendererVDOMSchema);
  }
}
