import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { BaseElement } from "../../core/base-element.ts";
import { oneOf } from "../../core/property-guards.ts";
import "../cf-image/index.ts";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
export type AvatarShape = "circle" | "square";

const avatarSizes = ["xs", "sm", "md", "lg", "xl"] as const;
const avatarShapes = ["circle", "square"] as const;

/**
 * Returns true only when `src` is a `data:` URI — an inline, self-contained
 * image with NO network fetch.
 *
 * The UI library forbids external resource loading (see packages/ui/README.md,
 * "No External Resources"): `cf-avatar` runs on the trusted main thread and its
 * `src` is often supplied by a sandboxed pattern, so rendering an `<img>` that
 * points at `http(s):`, a protocol-relative `//host`, `blob:`, or any other
 * remote/opaque scheme would silently fetch an external resource — a privacy /
 * exfil beacon and tracking vector. Those values are therefore treated as NOT
 * an image so the caller falls back to the inline glyph / initials path.
 *
 * Only `data:` URIs are inline and safe to render as an `<img>`. Anything else
 * (emoji, initials text, relative paths, remote URLs) returns false.
 */
export const isAvatarImageUrl = (src: string): boolean =>
  /^data:/i.test(src.trim());

/**
 * Returns true when `src` looks like a URL / path / scheme rather than a typed
 * glyph (emoji or a couple of letters). Such values are NOT fetched (only
 * `data:` URIs render as images), and rendering the raw URL text inside the
 * avatar would look broken — so they degrade to initials instead of the glyph
 * path. Matches any `scheme:` prefix or leading `/` (covers `http(s):`, `blob:`,
 * `ftp:`, protocol-relative `//host`, and root/relative paths), excluding the
 * inline `data:` case handled by `isAvatarImageUrl`.
 */
export const isRemoteLikeSource = (src: string): boolean => {
  const trimmed = src.trim();
  return !/^data:/i.test(trimmed) &&
    /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(trimmed);
};

/** Up to two uppercase initials derived from a display name. */
export const initialsForName = (name: string | undefined): string => {
  if (!name) return "?";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
  return initials || "?";
};

/**
 * CFAvatar — generic avatar primitive: image, glyph, or initials fallback.
 *
 * Presentation only; it carries NO trust claims, so any code — including
 * sandboxed user-space patterns — may render it. The trusted, profile-cell-bound
 * identity presentation lives in `<cf-profile-badge>`, which composes this.
 *
 * Rendering precedence:
 *   1. non-empty `bytes`             → the image they hold, via `<cf-image>`
 *   2. `src` that is a `data:` URI   → `<img>` (falls back to initials on error)
 *   3. a short typed glyph (emoji)   → the glyph as-is
 *   4. otherwise                     → initials derived from `name`.
 *      Remote URL/path-like `src` (http(s):, //host, blob:, /path, …) is never
 *      fetched and is not shown as raw text — it degrades to initials here
 *      (see `isAvatarImageUrl` / `isRemoteLikeSource`).
 *
 * @element cf-avatar
 * @property {FabricBytes} bytes - The bytes of a raster image, such as a
 *   profile's picture
 * @attr {string} src   - A `data:` image URI, or a glyph/emoji string
 * @attr {string} name  - Display name; drives the initials fallback + alt text
 * @attr {string} alt   - Explicit alt text (defaults to `name`)
 * @attr {string} size  - xs | sm | md | lg | xl (default md)
 * @attr {string} shape - circle | square (default circle)
 */
export class CFAvatar extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-avatar-size: 2rem;
        --cf-avatar-font-size: 0.8125rem;
        --cf-avatar-bg: var(--cf-theme-color-secondary, hsl(0, 0%, 92%));
        --cf-avatar-fg: var(
          --cf-theme-color-secondary-foreground,
          hsl(0, 0%, 25%)
        );
        display: inline-block;
        vertical-align: middle;
      }

      :host([size="xs"]) {
        --cf-avatar-size: 1.25rem;
        --cf-avatar-font-size: 0.5625rem;
      }
      :host([size="sm"]) {
        --cf-avatar-size: 1.5rem;
        --cf-avatar-font-size: 0.6875rem;
      }
      /* md is the default — no override */
      :host([size="lg"]) {
        --cf-avatar-size: 2.75rem;
        --cf-avatar-font-size: 1rem;
      }
      :host([size="xl"]) {
        --cf-avatar-size: 4rem;
        --cf-avatar-font-size: 1.5rem;
      }

      .avatar {
        box-sizing: border-box;
        width: var(--cf-avatar-size);
        height: var(--cf-avatar-size);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        background: var(--cf-avatar-bg);
        color: var(--cf-avatar-fg);
        font-size: var(--cf-avatar-font-size);
        font-weight: var(--cf-font-weight-semibold, 600);
        line-height: 1;
        user-select: none;
        border-radius: var(--cf-border-radius-full, 9999px);
      }

      :host([shape="square"]) .avatar {
        border-radius: var(--cf-border-radius-md, 6px);
      }

      .avatar img,
      .avatar cf-image {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .glyph {
        font-size: calc(var(--cf-avatar-font-size) * 1.4);
      }
    `,
  ];

  @property({ attribute: false })
  accessor bytes: FabricBytes | undefined = undefined;

  @property({ type: String })
  accessor src: string | undefined = undefined;

  @property({ type: String })
  accessor name: string | undefined = undefined;

  @property({ type: String })
  accessor alt: string | undefined = undefined;

  @property({ type: String, reflect: true })
  accessor size: AvatarSize = "md";

  @property({ type: String, reflect: true })
  accessor shape: AvatarShape = "circle";

  @state()
  private accessor _imgError = false;

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    // A new src gets a fresh chance to load before we fall back to initials.
    if (changed.has("src") || changed.has("bytes")) this._imgError = false;
    if (changed.has("size")) this.size = oneOf(this.size, avatarSizes, "md");
    if (changed.has("shape")) {
      this.shape = oneOf(this.shape, avatarShapes, "circle");
    }
  }

  override render() {
    const src = (this.src ?? "").trim();
    const name = this.name;
    const showBytes = (this.bytes?.length ?? 0) > 0;
    const showImage = !showBytes && src.length > 0 && isAvatarImageUrl(src) &&
      !this._imgError;
    // Short typed glyphs (emoji / a couple of letters) render as-is; URL/path
    // -like sources are neither fetched nor shown as raw text — they fall
    // through to initials.
    const showGlyph = !showBytes && src.length > 0 && !showImage &&
      !isRemoteLikeSource(src);

    return html`
      <span
        class="avatar"
        part="avatar"
        role="img"
        aria-label="${this.alt ?? name ?? "avatar"}"
      >
        ${showBytes
          ? html`
            <cf-image
              .bytes="${this.bytes}"
              alt="${this.alt ?? name ?? ""}"
            ></cf-image>
          `
          : showImage
          ? html`
            <img
              src="${src}"
              alt="${this.alt ?? name ?? ""}"
              @error="${this._onImgError}"
            />
          `
          : showGlyph
          ? html`
            <span class="glyph" part="glyph">${src}</span>
          `
          : html`
            <span class="initials" part="initials">
              ${initialsForName(name)}
            </span>
          `}
      </span>
    `;
  }

  private _onImgError = (): void => {
    this._imgError = true;
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-avatar": CFAvatar;
  }
}
