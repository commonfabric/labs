import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  type CellHandle,
  joinLoomPresenceRoom,
  type PresenceEvent,
  type PresenceRoomHandle,
} from "@commonfabric/runtime-client";

import { BaseElement } from "../../core/base-element.ts";
import {
  type PresenceFailureCategory,
  presenceFailureCategory,
} from "../../core/presence-failure.ts";
import {
  type PresentParticipant,
  presentParticipantsOf,
} from "./presence-roster.ts";

/**
 * Who is present in a Loom right now: the members of the Loom's presence
 * room, drawn the way a chat shows who is in the room. The room is the one
 * every client with the Loom open joins (`joinLoomPresenceRoom()` in
 * `@commonfabric/runtime-client`), derived from the Loom's space and
 * nothing else, so the element is bound a cell in that space with `$cell`
 * and reads nothing of the cell but its space and its runtime. It joins as
 * a member that publishes the viewer's `name` when one is set, and shows
 * every other person present, one per principal, with the viewer's own
 * principal left out; a person with the Loom open on two devices shows
 * once.
 *
 * A join the runtime refuses is reported once through `cf-presence-error`
 * as a category with no room, name, or server payload in it. A
 * `configuration` failure, a runtime or server without presence, stands
 * until the bound cell changes; any other is asked again on the next change
 * the element sees, the viewer's name or the bound cell's value, since a
 * join asked the moment a runtime reports ready can race its first socket.
 * Unmounting the element leaves the room.
 *
 * @element cf-loom-presence
 * @attr {string} name - The viewer's display name, published to the room.
 *   Empty publishes nothing, and the viewer is unseen by the others.
 * @fires cf-presence-error - Fired once per failure, with its category.
 * @fires cf-presence-join - Fired each time the element joins the room,
 *   including a rejoin after `cf-presence-error`. It carries no detail.
 */
export class CFLoomPresence extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .roster {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.375rem;
        font-size: var(--cf-font-size-sm, 0.8125rem);
        color: var(--cf-theme-color-text-secondary, hsl(0, 0%, 40%));
      }

      .member {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.125rem 0.5rem;
        border-radius: var(--cf-border-radius-full, 9999px);
        border: 1px solid var(--cf-theme-color-border, hsl(0, 0%, 89%));
        background: var(--cf-theme-color-surface, hsl(0, 0%, 99%));
        color: var(--cf-theme-color-text, hsl(0, 0%, 9%));
        white-space: nowrap;
      }

      .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: var(--cf-border-radius-full, 9999px);
        background: var(--cf-theme-color-success, hsl(142, 71%, 45%));
      }
    `,
  ];

  /**
   * A cell in the Loom's space, bound from a pattern via `$cell={cell}`. The
   * room joined is the Loom's, not the cell's field's.
   */
  @property({ attribute: false })
  accessor cell: CellHandle | undefined = undefined;

  /** The viewer's display name, published to the room when set. */
  @property({ type: String })
  accessor name = "";

  @state()
  private accessor _present: readonly PresentParticipant[] = [];

  #room: PresenceRoomHandle | undefined;
  #unsubscribe: (() => void) | undefined;

  /** The cell the room is held, or being joined, through. */
  #bound: CellHandle | undefined;

  #unwatch: (() => void) | undefined;
  #joining = false;

  /** Bumped by each leave, so a join in flight for an earlier room lets go. */
  #generation = 0;

  #failure: PresenceFailureCategory | undefined;

  /** The update hook, which a test drives in place of Lit's update cycle. */
  get accessForTestingOnly(): {
    willUpdate(changed: PropertyValues): void;
  } {
    return { willUpdate: (changed) => this.willUpdate(changed) };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#bind();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#unbind();
  }

  override render() {
    if (this._present.length === 0) return nothing;
    return html`
      <div class="roster" role="list" aria-label="Present now">
        ${repeat(
          this._present,
          (participant) => participant.principal,
          (participant) =>
            html`
              <span
                class="member"
                role="listitem"
                data-principal=${participant.principal}
                title=${participant.principal}
              >
                <span class="dot" aria-hidden="true"></span>
                ${participant.name}
              </span>
            `,
        )}
      </div>
    `;
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has("name") && this.#room !== undefined) {
      this.#room.setName(this.name);
    }
    this.#bind();
  }

  /**
   * Holds the room through the cell bound now: the one already held where
   * the binding is unchanged, else a fresh one, the previous binding's room
   * left. Hears each change of the bound cell's value, on which a refused
   * join is asked again; the value itself is not read.
   */
  #bind(): void {
    if (!this.isConnected) return;
    const cell = this.cell;
    if (cell !== this.#bound) {
      this.#unbind();
      this.#bound = cell;
      if (cell !== undefined) {
        this.#unwatch = cell.subscribe(() => this.#join(), {
          onRefused: () => this.#join(),
        });
      }
    }
    this.#join();
  }

  #unbind(): void {
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#bound = undefined;
    this.#failure = undefined;
    this.#leave();
  }

  #join(): void {
    const cell = this.#bound;
    if (
      cell === undefined || this.#room !== undefined || this.#joining ||
      this.#failure === "configuration"
    ) {
      return;
    }
    this.#failure = undefined;
    this.#joining = true;
    const generation = this.#generation;
    const runtime = cell.runtime();
    joinLoomPresenceRoom(runtime, cell.space()).then((handle) => {
      if (generation !== this.#generation) {
        void handle.leave();
        return;
      }
      this.#joining = false;
      this.#room = handle;
      this.#unsubscribe = handle.subscribe((event) =>
        this.#onEvent(handle, event)
      );
      if (this.name !== "") handle.setName(this.name);
      this._present = presentParticipantsOf(
        handle.participants,
        runtime.actingPrincipalDid(),
      );
      this.emit("cf-presence-join");
    }, (error) => {
      if (generation !== this.#generation) return;
      this.#joining = false;
      this.#fail(presenceFailureCategory(error));
    });
  }

  #onEvent(handle: PresenceRoomHandle, event: PresenceEvent): void {
    if (event.kind === "failure") {
      this.#fail(presenceFailureCategory(event.error));
      return;
    }
    this._present = presentParticipantsOf(
      handle.participants,
      this.#bound?.runtime().actingPrincipalDid(),
    );
  }

  #fail(category: PresenceFailureCategory): void {
    this.#leave();
    this.#failure = category;
    this.emit("cf-presence-error", { category });
  }

  /** Releases the room, and lets a join in flight go when it lands. */
  #leave(): void {
    this.#generation++;
    this.#joining = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const room = this.#room;
    this.#room = undefined;
    void room?.leave();
    this._present = [];
  }
}
