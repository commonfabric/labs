import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { consume } from "@lit/context";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { DID } from "@commonfabric/identity";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";
import "../cf-button/index.ts";

/** The width and height, in pixels, of the image an avatar is stored as. */
export const AVATAR_PIXELS = 128;

/**
 * Returns a square avatar made from `image`: its centered square, scaled to
 * `AVATAR_PIXELS` on each side, encoded as WebP, or as PNG where the browser
 * cannot encode WebP, with the media type it is encoded as.
 */
export async function avatarFromImage(image: Blob): Promise<Blob> {
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
    return await canvas.convertToBlob({
      type: "image/webp",
      quality: 0.85,
    });
  } finally {
    bitmap.close();
  }
}

/** Thrown by {@link avatarFromImage} for a file that is not an image. */
export class NotAnImageError extends Error {
  constructor() {
    super("The file is not an image");
  }
}

/**
 * CFAvatarInput - Picks an image file and hands it on as an avatar, stored as
 * a blob in the blob store of the space it is shown in, as `cf-file-input`
 * stores a file.
 *
 * The picked image is cropped to its centered square and scaled down to
 * `AVATAR_PIXELS` on each side, so what a profile shows is small whatever
 * the user picks.
 *
 * @element cf-avatar-input
 *
 * @attr {boolean} disabled - Disables the button
 *
 * @fires cf-change - The picked image: its bytes, and the blob they are stored
 *   in, by its space's DID and its id there. detail: { bytes: FabricBytes,
 *   blob: { space: string, id: string } }
 * @fires cf-error - The picked file is not an image, the browser could not
 *   draw it into a picture, or it could not be stored. detail:
 *   { message: string }
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

  /** The runtime that stores the picked image as a blob. */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  /** The space whose blob store the picked image is stored in. */
  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

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
    // What failed, as the error that follows will say it.
    let failure = `${file.name} could not be made into a picture`;
    try {
      const avatar = await avatarFromImage(file);
      const body = new Uint8Array(await avatar.arrayBuffer());
      failure = `${file.name} could not be stored`;
      const { runtime, space } = this;
      if (runtime === undefined || space === undefined) {
        throw new Error("There is no runtime or space to store it in");
      }
      const { id } = await runtime.uploadBlob({
        space,
        contentType: avatar.type,
        body,
      });
      this.emit("cf-change", {
        bytes: new FabricBytes(body, true),
        blob: { space, id },
      });
    } catch (error) {
      if (error instanceof NotAnImageError) {
        this.emit("cf-error", { message: `${file.name} is not an image` });
        return;
      }
      console.error(`cf-avatar-input: ${failure}`, error);
      this.emit("cf-error", { message: failure });
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
