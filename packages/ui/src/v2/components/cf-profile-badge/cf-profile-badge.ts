import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";
import { ProfileBadgeSchema } from "@commonfabric/runner/component-read-contract";
import { consume } from "@lit/context";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";

import "../cf-avatar/index.ts";

import type { DID } from "@commonfabric/identity";
import { navigate, openInNewTab } from "@commonfabric/navigation";
import {
  type CellHandle,
  CellReadRefusedError,
  type CfcLabelView,
  NAME,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { ownerPrincipalFromLabel } from "../../core/cfc-label.ts";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";
import type { AvatarSize } from "../cf-avatar/cf-avatar.ts";
import { type IdentitySeal, identitySeal } from "./identity-seal.ts";
import {
  registerSeal,
  type SealLivenessClient,
  unregisterSeal,
} from "./seal-liveness.ts";

/** Verification state of the presented identity. */
export type ProfileBadgeState = "presented" | "verified" | "unverified";

export type ProfileBadgeDisplay = {
  name: string | undefined;
  avatar: string | undefined;
};

/** Extra profile details surfaced in the badge hover/focus tooltip (CT-1648). */
export type ProfileBadgeTooltip = {
  bio: string | undefined;
  pinnedCount: number;
};

/**
 * Extracts the tooltip details (bio + pinned-piece count) from a subscribed
 * profile-cell value. `bio` is the owner-authored free-text description;
 * `pinnedCount` is the number of profile `elements` (pinned pieces / cards).
 * Both are best-effort: a badge bound to a derived projection (e.g. the
 * self-view `{name, avatar}` cell) simply yields no bio and a zero count. Pure,
 * so it is unit-testable without a runtime.
 */
export const profileTooltipFromValue = (val: unknown): ProfileBadgeTooltip => {
  if (!val || typeof val !== "object") {
    return { bio: undefined, pinnedCount: 0 };
  }
  const record = val as Record<PropertyKey, unknown>;
  const rawBio = record["bio"];
  const bio = typeof rawBio === "string" && rawBio.trim().length > 0
    ? rawBio.trim()
    : undefined;
  const elements = record["elements"];
  const pinnedCount = Array.isArray(elements) ? elements.length : 0;
  return { bio, pinnedCount };
};

/**
 * Extracts the display name + avatar from a subscribed profile-cell value.
 * Prefers the profile's own editable `name` field, falling back to the cell's
 * `[NAME]`. This ordering matters: on `main`, profile-home sets `[NAME]` to the
 * static placeholder `"Profile"` (profile-home.tsx:303), so trusting `[NAME]`
 * first would render every profile as "Profile". The `name` field is the
 * reliable display name; on the multi-profile branch `[NAME]` becomes the
 * person's name and either source yields the same result. Pure, so it is
 * unit-testable without a runtime.
 */
export const profileDisplayFromValue = (val: unknown): ProfileBadgeDisplay => {
  if (!val || typeof val !== "object") {
    return { name: undefined, avatar: undefined };
  }
  const record = val as Record<PropertyKey, unknown>;
  const named = record[NAME as unknown as PropertyKey];
  const plain = record["name"];
  const avatar = record["avatar"];
  const name = typeof plain === "string" && plain.trim().length > 0
    ? plain
    : typeof named === "string" && named.trim().length > 0
    ? named
    : undefined;
  return {
    name,
    avatar: typeof avatar === "string" && avatar.trim().length > 0
      ? avatar
      : undefined,
  };
};

/**
 * CFProfileBadge — official presentation of a profile (avatar + name).
 *
 * You bind it a *cell* containing a profile (e.g. `$profile={profileCell}`) and
 * it renders the person's avatar + name as system chrome. It runs on the trusted
 * main thread (outside the iframe sandbox where patterns run), which is what lets
 * it draw an identity treatment a pattern cannot forge.
 *
 * When the bound cell carries a runtime-attested `represents-principal` CFC label
 * (read over trusted IPC via `getCfcLabel()`), the badge enters the **verified**
 * state and draws a *generative identity seal* — a deterministic aura derived
 * purely from the owner's principal DID (see `identity-seal.ts`). Because the
 * aura is a pure function of the DID, it is the *same everywhere* that person's
 * badge appears, so it reads as a recognizable fingerprint of their identity;
 * and because it is gated on the attestation (which user-space cannot mint), a
 * pattern can mimic the CSS but not earn the verified seal for a DID it doesn't
 * control. Without that label the badge stays in the plain "presented" state.
 *
 * @element cf-profile-badge
 * @attr {string} size - avatar size: xs | sm | md | lg | xl (default md)
 */
export class CFProfileBadge extends BaseElement implements SealLivenessClient {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        vertical-align: middle;
        max-width: 100%;
      }

      .badge {
        position: relative;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        max-width: 100%;
        padding: 0.1875rem 0.625rem 0.1875rem 0.1875rem;
        border-radius: var(--cf-border-radius-full, 9999px);
        border: 1px solid var(--cf-theme-color-border, hsl(0, 0%, 89%));
        background: var(--cf-theme-color-surface, hsl(0, 0%, 99%));
        color: var(--cf-theme-color-text, hsl(0, 0%, 9%));
        line-height: 1;
      }

      /* CT-1648: hover/focus tooltip surfacing the profile's configured bio +
        pinned-piece count. Hidden until the badge is hovered or focused
        (keyboard focus drives it on touch/AT). pointer-events:none so it never
        intercepts the badge's own click/navigation. */
      .tooltip {
        position: absolute;
        top: calc(100% + 0.4rem);
        left: 0;
        z-index: 30;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        box-sizing: border-box;
        width: max-content;
        max-width: 18rem;
        padding: 0.5rem 0.625rem;
        border-radius: var(--cf-border-radius-md, 0.5rem);
        border: 1px solid var(--cf-theme-color-border, hsl(0, 0%, 89%));
        background: var(--cf-theme-color-surface, hsl(0, 0%, 99%));
        color: var(--cf-theme-color-text, hsl(0, 0%, 9%));
        box-shadow: 0 6px 20px -6px rgba(0, 0, 0, 0.28);
        opacity: 0;
        visibility: hidden;
        transform: translateY(-2px);
        transition:
          opacity 120ms ease-out,
          transform 120ms ease-out,
          visibility 120ms;
        pointer-events: none;
        text-align: left;
        white-space: normal;
      }

      .badge:hover .tooltip,
      .badge:focus-visible .tooltip,
      .badge:focus-within .tooltip {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }

      .tooltip-name {
        font-size: var(--cf-font-size-sm, 0.8125rem);
        font-weight: var(--cf-font-weight-semibold, 600);
      }

      .tooltip-bio {
        font-size: var(--cf-font-size-xs, 0.75rem);
        line-height: 1.35;
        color: var(--cf-theme-color-text-secondary, hsl(0, 0%, 40%));
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .tooltip-meta {
        font-size: var(--cf-font-size-xs, 0.75rem);
        color: var(--cf-theme-color-muted-foreground, hsl(0, 0%, 45%));
      }

      @media (prefers-reduced-motion: reduce) {
        .tooltip {
          transition: none;
          transform: none;
        }
        .badge:hover .tooltip,
        .badge:focus-visible .tooltip,
        .badge:focus-within .tooltip {
          transform: none;
        }
      }

      /* CT-1750: navigable badges (bound to a real profile cell) act as links.
        The pointer is set on BOTH the host and the inner badge: the badge fills
        the host's content box, but a flex/line-box can stretch the host past it,
        and that uncovered host area would otherwise show the default arrow. */
      :host([data-navigable]) {
        cursor: pointer;
      }

      .badge[data-navigable] {
        cursor: pointer;
      }

      .badge[data-navigable]:focus-visible {
        outline: 2px solid var(--cf-theme-color-primary, hsl(212, 100%, 47%));
        outline-offset: 2px;
      }

      .name {
        font-size: var(--cf-font-size-sm, 0.8125rem);
        font-weight: var(--cf-font-weight-semibold, 600);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 16ch;
      }

      /* The generative aura ring. Transparent until the badge is verified; when
        verified, a separate aura-ring layer carries the per-identity conic
        gradient (a pure function of the owner DID) behind the avatar, so the ring
        is unique-but-stable for each person. Keeping it on its own layer lets it
        rotate in lockstep (the always-on animation below) and carry the shimmer
        and cursor-sheen layers, all without rotating the avatar. */
      .aura {
        position: relative;
        display: inline-flex;
        flex: 0 0 auto;
        border-radius: var(--cf-border-radius-full, 9999px);
        padding: 0;
      }

      .aura-ring {
        position: absolute;
        inset: 0;
        border-radius: var(--cf-border-radius-full, 9999px);
        z-index: 0;
        transform-origin: center;
      }

      /* Intrinsic shimmer — a soft light band that sweeps across the disc on a
        shared clock (seeded per-badge via animation-delay so every verified seal
        sweeps in lockstep). Keeps the seal visibly "alive" even when the cursor
        is still, in a way ordinary chrome never is. Sits above the avatar so the
        light glazes the face; screen-blended and contained by the aura's
        isolation so it only lifts the badge, not the page behind it. */
      .aura-glow {
        position: absolute;
        inset: 0;
        border-radius: var(--cf-border-radius-full, 9999px);
        z-index: 2;
        pointer-events: none;
        opacity: 0;
        mix-blend-mode: screen;
        background: linear-gradient(
          115deg,
          transparent 34%,
          hsl(var(--seal-hue, 200) 95% 90% / 0.5) 47%,
          rgba(255, 255, 255, 0.85) 50%,
          hsl(var(--seal-hue, 200) 95% 90% / 0.5) 53%,
          transparent 66%
        );
        background-size: 280% 280%;
      }

      /* Cursor sheen — a bright reflective hotspot that tracks the host cursor,
        even when the cursor is nowhere near the badge. Driven by
        --seal-mx/--seal-my/--seal-sheen-a/--seal-sheen-hue, which the shared
        liveness controller sets on the host (they inherit into this layer). A
        sandboxed pattern only sees pointer events inside its own iframe, so a
        forgery cannot reproduce this. */
      .aura-sheen {
        position: absolute;
        inset: 0;
        border-radius: var(--cf-border-radius-full, 9999px);
        z-index: 3;
        pointer-events: none;
        opacity: var(--seal-sheen-a, 0);
        mix-blend-mode: screen;
        background:
          radial-gradient(
          circle at var(--seal-mx, 50%) var(--seal-my, 50%),
          rgba(255, 255, 255, 1) 0%,
          rgba(255, 255, 255, 0.6) 11%,
          rgba(255, 255, 255, 0) 32%
        ),
          radial-gradient(
          circle at var(--seal-mx, 50%) var(--seal-my, 50%),
          hsl(var(--seal-sheen-hue, 200) 100% 72% / 0.9) 0%,
          hsl(var(--seal-sheen-hue, 200) 100% 60% / 0) 52%
        );
      }

      .aura cf-avatar {
        position: relative;
        z-index: 1;
      }

      .badge[data-state="verified"] .aura {
        padding: 3px;
        isolation: isolate;
        transition: transform 200ms ease-out;
      }

      .badge[data-state="verified"] .aura cf-avatar {
        box-shadow: 0 0 0 2px var(--cf-theme-color-surface, hsl(0, 0%, 99%));
        border-radius: var(--cf-border-radius-full, 9999px);
      }

      /* Ambient self-motion is gated to :hover so a dense roster stays calm at
        rest and a seal comes alive when engaged. The cursor sheen (.aura-sheen,
        above) is the *always-on* part — it reacts to the host cursor anywhere on
        screen, hovered or not, which is the unforgeable signal. On hover the ring
        rotates, the shimmer sweeps, and the seal lifts a touch. */
      .badge[data-state="verified"] .aura:hover .aura-ring {
        animation: cf-aura-spin 26s linear infinite;
      }

      .badge[data-state="verified"] .aura:hover .aura-glow {
        opacity: 1;
        animation: cf-aura-glow 7s linear infinite;
      }

      .badge[data-state="verified"] .aura:hover {
        transform: scale(1.04);
        transition: transform 160ms ease-out;
      }

      @keyframes cf-aura-spin {
        to {
          transform: rotate(1turn);
        }
      }

      @keyframes cf-aura-glow {
        0% {
          background-position: 0% 0%;
        }
        100% {
          background-position: 280% 280%;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .badge[data-state="verified"] .aura:hover .aura-ring,
        .badge[data-state="verified"] .aura:hover .aura-glow {
          animation: none;
        }
        .badge[data-state="verified"] .aura:hover .aura-glow {
          opacity: 0;
        }
        .badge[data-state="verified"] .aura:hover {
          transform: none;
        }
      }

      /*
      ** Variants
      */

      /* chip: compact name-first pill. No avatar — a small DID-hued "seal dot"
        carries the identity treatment, so an inline name still reads as a
        first-class, verifiable identity rather than plain text. */
      .badge[data-variant="chip"] {
        gap: 0.375rem;
        padding: 0.125rem 0.5rem 0.125rem 0.3125rem;
      }

      .seal-dot {
        display: block;
        width: 0.5rem;
        height: 0.5rem;
        border-radius: var(--cf-border-radius-full, 9999px);
        background: var(--cf-theme-color-border, hsl(0, 0%, 80%));
        box-sizing: border-box;
      }

      /* The verified dot is filled with the identity accent (supplied inline)
        and sits inside the shared .aura, so it inherits the same ring + glow +
        cursor-sheen liveness as the full badge — just at dot scale. */
      .badge[data-variant="chip"][data-state="verified"] .aura .seal-dot {
        box-shadow: 0 0 0 1.5px var(--cf-theme-color-surface, hsl(0, 0%, 99%));
      }

      /* circle: avatar + seal ring only. Drop the pill chrome and the name; the
        ring IS the seal. Used for dense avatar strips and message gutters. */
      .badge[data-variant="circle"] {
        gap: 0;
        padding: 0;
        border: none;
        background: transparent;
      }

      /* hero: large, centered avatar-over-name. For a profile page header — the
        seal aura is the focal point, so drop the pill chrome and stack the name
        beneath the avatar at display scale. */
      .badge[data-variant="hero"] {
        flex-direction: column;
        gap: 0.625rem;
        padding: 0;
        border: none;
        background: transparent;
        align-items: center;
        text-align: center;
      }

      .badge[data-variant="hero"] .name {
        font-size: var(--cf-font-size-xl, 1.5rem);
        font-weight: var(--cf-font-weight-bold, 700);
        max-width: min(28ch, 100%);
        white-space: normal;
      }
    `,
  ];

  /** The profile cell to present. Bound from a pattern via `$profile={cell}`. */
  @property({ attribute: false })
  accessor profile: CellHandle | undefined = undefined;

  @property({ type: String, reflect: true })
  accessor size: AvatarSize = "md";

  /**
   * Badge shape. The verification treatment is ALWAYS the generative seal — the
   * DID-derived aura ring + the cursor-reactive glint (a pattern can mimic the
   * chrome but cannot earn the seal for a DID it doesn't control). Variants
   * differ only in how much chrome they draw around it:
   *  - `full` (default): avatar + name pill. Roster rows, "playing as", etc.
   *  - `chip`: name + a compact DID-hued seal dot (no avatar). For inline names
   *    in dense UI where a full pill is too heavy but the identity treatment
   *    should still read.
   *  - `circle`: avatar + seal ring only, no name text (the name rides
   *    `aria-label` + the hover tooltip). For avatar strips and message gutters.
   *  - `hero`: large, centered avatar-over-name presentation. For a profile
   *    page header, where the seal IS the point. Pair with `noNavigate`.
   * @attr {string} variant - full | chip | circle | hero (default full)
   */
  @property({ type: String, reflect: true })
  accessor variant: "full" | "chip" | "circle" | "hero" = "full";

  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  /**
   * Suppress click-to-navigate. Set this when the badge is bound to a derived
   * view of the profile rather than the profile's own root piece — e.g. the
   * self-badge on a profile-home page, whose bound cell is a `computed()`
   * projection (not a navigable piece), so a click would otherwise resolve to a
   * non-piece cell id and route to an invalid URL.
   */
  @property({ type: Boolean, reflect: true, attribute: "nonavigate" })
  accessor noNavigate = false;

  /**
   * Name to present when no profile resolves.
   *
   * For a row that RECORDS who someone was without holding their profile —
   * a roster entry written before the space had profiles, say. Such a row
   * still knows the name it stored, and showing it beats telling the reader
   * the person is unknown. It is a fallback only: a resolved profile always
   * wins, so this can never mask or contradict a real identity, and it earns
   * no part of the verification treatment.
   */
  @property({ type: String, attribute: "fallback-name" })
  accessor fallbackName: string | undefined = undefined;

  @state()
  private accessor _name: string | undefined = undefined;

  /**
   * Whether a profile VALUE resolved, however little it carried.
   *
   * Separate from `_name` because a resolved profile may simply have no name,
   * and that case must not read as "no profile": verification is derived from
   * the resolved cell, so a caller-supplied fallback rendered there would sit
   * beside a seal it did not earn.
   */
  @state()
  private accessor _resolved = false;

  @state()
  private accessor _avatar: string | undefined = undefined;

  /** The bio, an extra detail surfaced in the hover/focus tooltip. */
  @state()
  private accessor _bio: string | undefined = undefined;

  /** The pinned count, an extra detail surfaced in the hover/focus tooltip. */
  @state()
  private accessor _pinnedCount = 0;

  @state()
  private accessor _state: ProfileBadgeState = "presented";

  /** Generative identity seal, derived from the owner DID once verified. */
  @state()
  private accessor _seal: IdentitySeal | undefined = undefined;

  /** The resolved profile cell. */
  private _resolvedCell: CellHandle | undefined = undefined;

  /**
   * Whether a click navigates, which is so only when `noNavigate` is unset and
   * the resolved cell is a root cell (a real profile piece). A badge bound to
   * a real profile (rosters/lists) navigates to that profile's page on click;
   * one bound to a derived/sub-path cell (e.g. a self-view `{name, avatar}`
   * cell on the profile page itself) is non-navigable and the click is a
   * no-op.
   */
  @state()
  private accessor _navigable = false;

  private _unsubscribe?: () => void;
  private _resolveGeneration = 0;

  /**
   * Whether this seal is currently registered with the shared cursor
   * controller.
   */
  private _livenessRegistered = false;

  /**
   * The last sheen alpha written, so far-from-cursor frames can skip redundant
   * style writes.
   */
  private _lastSheenA = -1;

  override connectedCallback(): void {
    super.connectedCallback();
    void this._resolve();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Bump the generation so any in-flight `_resolve` continuation fails its
    // `generation !== this._resolveGeneration` guard and bails before
    // subscribing / writing state on this now-detached instance. Without this,
    // an element that disconnects DURING the `await cell.resolveAsCell()` would
    // resume, pass the (unchanged) generation check, and leak a live
    // subscription that updates a detached element.
    this._resolveGeneration++;
    this._cleanup();
    this._setLiveness(false);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has("profile")) {
      void this._resolve();
    }
  }

  /**
   * Whether this badge is presenting a VERIFIED profile.
   *
   * The single answer the seal nodes, `data-state` and the cursor-sheen
   * liveness all take, because they are one claim wearing three faces and a
   * guard on only the nodes leaves the other two asserting it. Verification
   * is derived from the resolved cell's label, which can arrive while no
   * VALUE did — a badge showing a fallback name, or nothing, must not be in
   * a verified state on the strength of a label alone.
   */
  private get _verified(): boolean {
    return this._resolved && this._state === "verified" &&
      this._seal !== undefined;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    // Reflect navigability to the host so `:host([data-navigable])` can draw the
    // pointer cursor over the whole host box (not just the inner `.badge`).
    this.toggleAttribute("data-navigable", this._navigable);
    // Register for cursor sheen only while actually verified + connected. The
    // shared controller manages reduced-motion (it won't run the loop while the
    // user prefers reduced motion, and tears it down live if they enable it).
    this._setLiveness(this._verified && this.isConnected);
  }

  private _setLiveness(on: boolean): void {
    if (on === this._livenessRegistered) return;
    this._livenessRegistered = on;
    if (on) {
      registerSeal(this);
    } else {
      unregisterSeal(this);
      this._lastSheenA = -1;
    }
  }

  /**
   * Called once per animation frame by the shared liveness controller while
   * this seal is registered. Places a reflective hotspot on the seal in the
   * direction of the host cursor, brightening as the cursor nears — and
   * responding even when the cursor is far away (the unforgeable part). Reads
   * the aura's own rect so geometry is correct regardless of the badge's
   * surrounding layout, and culls when offscreen.
   */
  updateSeal(cursorX: number, cursorY: number, frameMs: number): void {
    const aura = this.shadowRoot?.querySelector(".aura") as HTMLElement | null;
    if (!aura) return;
    const r = aura.getBoundingClientRect();
    const vh = globalThis.innerHeight ?? 0;
    if (r.width === 0 || r.bottom < -80 || r.top > vh + 80) {
      if (this._lastSheenA !== 0) {
        this.style.setProperty("--seal-sheen-a", "0");
        this._lastSheenA = 0;
      }
      return;
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cursorX - cx;
    const dy = cursorY - cy;
    const dist = Math.hypot(dx, dy);
    const prox = Math.max(0, 1 - dist / 520); // 1 at center → 0 by ~520px
    const a = Math.min(1, prox * prox * 1.25 + prox * 0.15); // punchy near
    // Far + already dark: nothing to draw, skip all writes (cheap at scale).
    if (a === 0 && this._lastSheenA === 0) return;
    this._lastSheenA = a;
    const reach = Math.max(r.width, r.height) * 1.9;
    const nx = Math.max(-1, Math.min(1, dx / reach));
    const ny = Math.max(-1, Math.min(1, dy / reach));
    const hue = this._seal?.hue ?? 0;
    this.style.setProperty("--seal-mx", `${(50 + nx * 62).toFixed(1)}%`);
    this.style.setProperty("--seal-my", `${(50 + ny * 62).toFixed(1)}%`);
    this.style.setProperty("--seal-sheen-a", a.toFixed(3));
    this.style.setProperty(
      "--seal-sheen-hue",
      String(Math.round((hue + frameMs * 0.03 + nx * 40 + 360) % 360)),
    );
  }

  /**
   * Reset the cursor sheen to nothing. Called by the shared controller when it
   * stops the loop (e.g. the user enables reduced motion) so the highlight
   * doesn't freeze mid-glint.
   */
  clearSeal(): void {
    this.style.setProperty("--seal-sheen-a", "0");
    this._lastSheenA = 0;
  }

  private _cleanup(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
  }

  private async _resolve(): Promise<void> {
    const generation = ++this._resolveGeneration;
    this._cleanup();
    // Clear any prior verification up-front: a re-bind to a different profile
    // must not keep showing the previous profile's seal during the async
    // re-resolve + attestation gap. `_refreshVerification` re-derives it below.
    this._state = "presented";
    this._seal = undefined;
    this._resolved = false;
    // Drop navigation state until the (new) cell resolves — a stale link must
    // not survive a re-bind.
    this._resolvedCell = undefined;
    this._navigable = false;

    const cell = this.profile;
    if (!cell) {
      this._applyValue(undefined);
      return;
    }

    try {
      const resolved = await cell.resolveAsCell();
      // Bail if a newer resolve superseded us OR if we were disconnected during
      // the await (disconnectedCallback bumps the generation, so the first guard
      // already covers detachment; isConnected is kept as a belt-and-braces
      // check so we never subscribe / write state on a detached instance).
      if (generation !== this._resolveGeneration || !this.isConnected) return;

      // CT-1750: remember the resolved cell and whether it's a navigable root
      // piece (only root cells map to a profile page; sub-path/derived cells
      // don't).
      this._resolvedCell = resolved;
      this._navigable = !this.noNavigate && resolved.ref().path.length === 0;

      // Subscribe with a minimal schema so the runtime only resolves the fields
      // we render, rather than walking the whole profile output graph (mirrors
      // cf-cell-link's $NAME-only subscription). `bio` + `elements` feed the
      // hover tooltip (CT-1648); `elements` items request only `title` (a
      // same-space string) so we never deep-resolve the cross-space `cell` links
      // just to count them.
      const named = resolved.asSchema<
        {
          [NAME]?: string;
          name?: string;
          avatar?: string;
          bio?: string;
          elements?: Array<{ title?: string }>;
        }
      >(ProfileBadgeSchema);
      // The runtime-attested label rides each subscription update
      // (`includeCfcLabel`), read on the sink's tracked tx — so verification
      // re-derives whenever the profile's label changes (re-labeling, or the
      // doc first loading), not just on name/avatar edits, with no separate
      // getCfcLabel round-trip. The `generation` guard drops a callback that
      // fires after a re-bind/detach.
      this._unsubscribe = named.subscribe((val, cfcLabel) => {
        this._applyValue(val);
        this._deriveVerification(cfcLabel, generation);
      }, {
        includeCfcLabel: true,
        onRefused: () => this._applyRefusal(generation),
      });
    } catch (e) {
      if (generation !== this._resolveGeneration || !this.isConnected) return;
      // A disposal race (logout, runtime swap) cancels the resolve; that is
      // cancellation, not a failure to surface. Read the cell's own runtime,
      // not the ambient `this.runtime` (cleared to undefined on logout).
      if (cell.runtime().signal.aborted) return;
      this._resolvedCell = undefined;
      this._navigable = false;
      // A profile the worker will not say where it is, is shown as withheld,
      // an answer rather than a failure.
      if (e instanceof CellReadRefusedError) {
        this._applyRefusal(generation);
        return;
      }
      console.error("cf-profile-badge: failed to resolve profile cell", e);
      this._applyValue(undefined);
    }
  }

  /**
   * Navigate to the bound profile's page (CT-1750). No-op unless the resolved
   * cell is a navigable root piece. Mirrors cf-cell-link's navigation; Cmd/Ctrl
   * opens in a new tab.
   */
  private _navigateToProfile(newTab: boolean): void {
    if (this.noNavigate) return;
    const cell = this._resolvedCell;
    if (!cell || cell.ref().path.length > 0) return;
    const view = { spaceDid: cell.space(), pieceId: cell.id() };
    if (newTab) {
      openInNewTab(view);
    } else {
      navigate(view);
    }
  }

  private _handleClick(e: MouseEvent): void {
    if (!this._navigable) return;
    e.stopPropagation();
    this._navigateToProfile(e.metaKey || e.ctrlKey);
  }

  private _handleKeydown(e: KeyboardEvent): void {
    if (!this._navigable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this._navigateToProfile(e.metaKey || e.ctrlKey);
    }
  }

  private _applyValue(val: unknown): void {
    const { name, avatar } = profileDisplayFromValue(val);
    // A VALUE arrived, not merely an attempt that finished. The no-cell and
    // failed-resolve paths both land here with `undefined`, and treating
    // those as resolved would suppress the fallback in exactly the case it
    // exists for.
    this._resolved = val !== undefined;
    const { bio, pinnedCount } = profileTooltipFromValue(val);
    this._name = name;
    this._avatar = avatar;
    this._bio = bio;
    this._pinnedCount = pinnedCount;
    this.requestUpdate();
  }

  /**
   * Shows a profile the worker will not show as withheld: the placeholder in
   * place of its name, and no seal, since the label that earns one was not
   * delivered. It is not shown as a row holding no profile, so a fallback name
   * is not lent to it.
   */
  private _applyRefusal(generation: number): void {
    if (generation !== this._resolveGeneration || !this.isConnected) return;
    this._resolved = true;
    this._name = CFC_POLICY_PLACEHOLDER_TEXT;
    this._avatar = undefined;
    this._bio = undefined;
    this._pinnedCount = 0;
    this._seal = undefined;
    this._state = "presented";
    this.requestUpdate();
  }

  /**
   * Reads the resolved cell's runtime-attested CFC label and, if it carries a
   * `represents-principal` atom, enters the verified state and derives the
   * generative seal from the owner principal DID. The seal is a pure function of
   * the DID, so it is identical wherever this person's badge renders. No
   * attestation → the badge stays in the plain "presented" state (a pattern can
   * mimic the chrome but cannot mint the label that unlocks the seal).
   *
   * `generation` is captured by the subscription callback in `_resolve`; a
   * callback that fires after a re-bind/detach (which bumps the generation)
   * bails before writing `_state`/`_seal`, so it can't leak onto a stale or
   * detached instance.
   */
  private _deriveVerification(
    cfcLabel: CfcLabelView | undefined,
    generation: number,
  ): void {
    if (generation !== this._resolveGeneration || !this.isConnected) return;
    // The label is the runtime-attested, display-redacted view delivered over
    // the subscription; redaction strips Caveat.source but keeps the
    // `represents-principal` integrity atom that unlocks the seal.
    const owner = ownerPrincipalFromLabel(cfcLabel);
    if (owner) {
      this._seal = identitySeal(owner);
      this._state = "verified";
    } else {
      this._seal = undefined;
      this._state = "presented";
    }
  }

  override render() {
    // The fallback stands in for a row that holds NO profile. Once a value
    // resolves the profile is authoritative, so a nameless one reads as
    // unknown rather than borrowing a caller-supplied string — and a
    // fallback never renders beside the seal, which is earned by a resolved
    // cell's label and cannot be lent to text a caller passed in.
    const usingFallback = this._name === undefined && !this._resolved &&
      this.fallbackName !== undefined;
    const presentedName = this._name ??
      (usingFallback ? this.fallbackName : undefined);
    const displayName = presentedName ?? "Unknown profile";
    const verified = this._verified;
    // The aura ring layer carries the DID-derived conic gradient plus a soft glow
    // in the identity's hue, so the fingerprint reads at badge scale.
    const hue = this._seal?.hue ?? 0;
    const ringStyle = verified
      ? `background: ${
        this._seal!.ringGradient
      }; box-shadow: 0 0 0 1px hsl(${hue} 80% 58% / 0.3), 0 0 10px -1px hsl(${hue} 85% 60% / 0.7);`
      : "";
    // The chip's seal-dot is filled with the same DID-derived accent when
    // verified (supplied inline), so an inline name still carries the identity's
    // color even without an avatar.
    const dotStyle = verified ? `background: ${this._seal!.accent};` : "";
    // Per-identity hue, supplied inline so the hover shimmer is tinted to match
    // this identity's palette.
    const auraStyle = verified ? `--seal-hue: ${hue};` : "";

    // CT-1761: variant shape. The verification signal is ALWAYS the generative
    // seal (aura ring + cursor glint) — there is no separate shield icon. `full`
    // is an avatar+name pill; `chip` drops the avatar for a compact name + seal
    // dot; `circle` drops the name for an avatar + seal ring (name rides
    // aria-label/tooltip); `hero` is a large avatar-over-name presentation.
    const variant = this.variant;
    const showAvatar = variant !== "chip";
    const showName = variant !== "circle";

    // CT-1648: hover/focus tooltip surfacing the profile's configured details
    // (bio + pinned-piece count). Always shown for `circle` (whose name is
    // otherwise invisible); otherwise only when there's something beyond the
    // already-visible name.
    const pinnedLabel = this._pinnedCount === 1
      ? "1 pinned piece"
      : `${this._pinnedCount} pinned pieces`;
    const hasTooltip = this._bio !== undefined || this._pinnedCount > 0 ||
      variant === "circle";

    return html`
      <span
        class="badge"
        part="root"
        data-cf-profile-badge
        data-variant="${variant}"
        data-state="${verified ? "verified" : "presented"}"
        ?data-navigable="${this._navigable}"
        ?data-has-tooltip="${hasTooltip}"
        role="${this._navigable
          ? "link"
          : (variant === "circle" ? "img" : nothing)}"
        aria-label="${variant === "circle" ? displayName : nothing}"
        tabindex="${this._navigable ? "0" : (hasTooltip ? "0" : nothing)}"
        @click="${this._handleClick}"
        @keydown="${this._handleKeydown}"
      >
        <span class="aura" part="aura" style="${auraStyle}">
          ${verified
            ? html`
              <span class="aura-ring" part="aura-ring" style="${ringStyle}"> </span>
            `
            : null} ${showAvatar
            ? html`
              <cf-avatar
                part="avatar"
                exportparts="avatar"
                .src="${this._avatar}"
                .name="${presentedName}"
                size="${this.size}"
              ></cf-avatar>
            `
            : html`
              <span class="seal-dot" part="seal-dot" style="${dotStyle}"></span>
            `} ${verified
            ? html`
              <span class="aura-glow" part="aura-glow" aria-hidden="true"></span>
              <span class="aura-sheen" part="aura-sheen" aria-hidden="true"></span>
            `
            : null}
        </span>
        ${showName
          ? html`
            <span class="name" part="name">${displayName}</span>
          `
          : null} ${hasTooltip
          ? html`
            <span class="tooltip" part="tooltip" role="tooltip">
              <span class="tooltip-name">${presentedName ?? "Profile"}</span>
              ${this._bio !== undefined
                ? html`
                  <span class="tooltip-bio">${this._bio}</span>
                `
                : null} ${this._pinnedCount > 0
                ? html`
                  <span class="tooltip-meta">
                    <span aria-hidden="true">📌</span> ${pinnedLabel}
                  </span>
                `
                : null}
            </span>
          `
          : null}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-profile-badge": CFProfileBadge;
  }
}
