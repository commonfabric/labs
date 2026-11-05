import { consume } from "@lit/context";
import { css, html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";
import { type BlobReference, BlobUrlResolver } from "../../utils/blob-url.ts";

/**
 * CFImage - Renders an image from raw bytes, or from a blob in a space's blob
 * store.
 *
 * The cell holds the raw response bytes (from `fetchBinary`); this render-layer
 * component mints an object URL from a Blob and revokes it when the bytes
 * change or the element is removed. Patterns pass `bytes` and `mediaType`
 * directly without touching `URL.createObjectURL`.
 *
 * The `bytes` value may arrive as a `FabricBytes` wrapper, a `Uint8Array`, or a
 * plain `number[]`, so coercion is defensive.
 *
 * With no `bytes`, the component shows the blob a `blob` reference names
 * instead. The reference is `{ space, id }`, a space's DID and a blob's id
 * there, as a FabriFile entry holds it. The component asks the runtime for the
 * URL the space's host serves the blob at, so a pattern can show a stored
 * image without forming a URL itself.
 *
 * @element cf-image
 *
 * @property {unknown} bytes - Raw image bytes (FabricBytes, Uint8Array, or number[])
 * @property {object} blob - A blob reference, `{ space, id }`, shown where there are no bytes
 * @attr {string} media-type - Media type for the Blob, e.g. "image/png"
 * @attr {string} alt - Alternative text for the image
 */
export class CFImage extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
      }

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    `,
  ];

  @property({ attribute: false })
  accessor bytes: unknown = undefined;

  @property({ type: String, attribute: "media-type" })
  accessor mediaType = "";

  @property({ type: String })
  accessor alt = "";

  /** A blob to show, by its space and its id, where there are no `bytes`. */
  @property({ attribute: false })
  accessor blob: BlobReference | undefined = undefined;

  /** The runtime that resolves a `blob` reference to a URL. */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  private _objectUrl: string | null = null;

  #blobUrl = new BlobUrlResolver(this);

  private _revokeObjectUrl() {
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
  }

  /**
   * Coerce the various shapes `bytes` may take into a Uint8Array. Returns null
   * when the value can't be read as bytes (the image then stays empty).
   */
  private _coerceBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
    if (value == null) return null;

    // Copy into a fresh ArrayBuffer-backed array so the result is a valid
    // BlobPart regardless of the source's backing buffer.
    if (value instanceof Uint8Array) return new Uint8Array(value);

    const maybe = value as {
      slice?: (start?: number, end?: number) => unknown;
      length?: number;
    };

    if (typeof maybe.slice === "function") {
      try {
        return new Uint8Array(maybe.slice() as ArrayLike<number>);
      } catch {
        // Fall through to the remaining strategies.
      }
    }

    if (Array.isArray(value)) {
      return new Uint8Array(value as number[]);
    }

    if (typeof maybe.length === "number") {
      try {
        return Uint8Array.from(value as ArrayLike<number>);
      } catch {
        return null;
      }
    }

    return null;
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("blob") || changedProperties.has("runtime")) {
      this.#blobUrl.resolve(this.runtime, this.blob);
    }

    if (changedProperties.has("bytes") || changedProperties.has("mediaType")) {
      this._revokeObjectUrl();

      const u8 = this._coerceBytes(this.bytes);
      if (u8) {
        const blob = new Blob([u8], { type: this.mediaType || undefined });
        this._objectUrl = URL.createObjectURL(blob);
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._revokeObjectUrl();
  }

  override render() {
    const src = this._objectUrl ?? this.#blobUrl.url;
    if (!src) return null;
    return html`
      <img src="${src}" alt="${this.alt}" />
    `;
  }
}
