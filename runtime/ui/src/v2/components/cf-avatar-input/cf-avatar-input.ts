import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-button/index.ts";

/** The width and height, in pixels, of the image an avatar is stored as. */
export const AVATAR_PIXELS = 128;

/**
 * Returns the bytes of a square avatar made from `image`: its centered square,
 * scaled to `AVATAR_PIXELS` on each side, encoded as WebP, or as PNG where the
 * browser cannot encode WebP.
 */
export async function avatarBytesFromImage(image: Blob): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new NotAnImageError();
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(AVATAR_PIXELS, AVATAR_PIXELS);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas context is available");
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_PIXELS,
      AVATAR_PIXELS,
    );
    const blob = await canvas.convertToBlob({
      type: "image/webp",
      quality: 0.85,
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** Thrown by {@link avatarBytesFromImage} for a file that is not an image. */
export class NotAnImageError extends Error {
  constructor() {
    super("The file is not an image");
  }
}

/**
 * CFAvatarInput - Picks an image file and hands it on as avatar bytes.
 *
 * The picked image is cropped to its centered square and scaled down to
 * `AVATAR_PIXELS` on each side, so what a profile stores is small whatever
 * the user picks.
 *
 * @element cf-avatar-input
 *
 * @attr {boolean} disabled - Disables the button
 *
 * @fires cf-change - The picked image. detail: { bytes: FabricBytes }
 * @fires cf-error - The picked file is not an image, or the browser could not
 *   draw it into a picture. detail: { message: string }
 */
export class CFAvatarInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
      }

      input {
        display: none;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @state()
  private accessor _busy = false;

  #handleClick = (): void => {
    this.#input()?.click();
  };

  #handleChange = async (): Promise<void> => {
    const input = this.#input();
    const file = input?.files?.[0];
    if (!input || !file) return;
    // Cleared so that picking the same file again still fires a change.
    input.value = "";
    this._busy = true;
    try {
      const bytes = new FabricBytes(await avatarBytesFromImage(file), true);
      this.emit("cf-change", { bytes });
    } catch (error) {
      this.emit("cf-error", {
        message: error instanceof NotAnImageError
          ? `${file.name} is not an image`
          : `${file.name} could not be made into a picture`,
      });
    } finally {
      this._busy = false;
    }
  };

  override render() {
    return html`
      <input type="file" accept="image/*" @change="${this.#handleChange}" />
      <cf-button
        variant="outline"
        ?disabled="${this.disabled || this._busy}"
        @click="${this.#handleClick}"
      >
        Choose image
      </cf-button>
    `;
  }

  #input(): HTMLInputElement | null | undefined {
    return this.shadowRoot?.querySelector("input");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-avatar-input": CFAvatarInput;
  }
}
