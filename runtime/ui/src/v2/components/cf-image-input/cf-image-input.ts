import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { CFFileInput } from "../cf-file-input/index.ts";
import type { StoredFile } from "../../utils/file-cell-storage.ts";
import {
  compressImage,
  formatFileSize,
} from "../../utils/image-compression.ts";

/**
 * Image data structure (extends FileData with image-specific fields)
 */
export interface ImageData extends StoredFile {
  width?: number;
  height?: number;
}

/**
 * CFImageInput - Image capture and upload component with camera support
 *
 * Extends CFFileInput with image-specific features like compression
 * and camera capture support.
 *
 * @element cf-image-input
 *
 * @attr {boolean} multiple - Allow multiple images (default: false)
 * @attr {number} maxImages - Max number of images (default: unlimited)
 * @attr {number} maxSizeBytes - Max size in bytes before compression (default: 5MB)
 * @attr {string} capture - Capture mode: "user" | "environment" | false
 * @attr {string} buttonText - Custom button text (default: "📷 Add Photo")
 * @attr {string} variant - Button style variant
 * @attr {string} size - Button size
 * @attr {boolean} showPreview - Show image previews (default: true)
 * @attr {string} previewSize - Preview thumbnail size: "sm" | "md" | "lg"
 * @attr {boolean} removable - Allow removing images (default: true)
 * @attr {boolean} disabled - Disable the input
 *
 * @fires cf-change - Fired when image(s) are added or removed. On add, images contains the newly added images. On remove, images contains the updated full list for compatibility. detail: { images: ImageData[], allImages: ImageData[] }
 * @fires cf-remove - Fired when an image is removed. detail: { id: string, images: ImageData[], allImages: ImageData[] }
 * @fires cf-error - Fired when an error occurs. detail: { error: Error, message: string }
 *
 * @example
 * <cf-image-input capture="environment" buttonText="📸 Scan"></cf-image-input>
 * @example
 * <cf-image-input maxSizeBytes={5000000} buttonText="📸 Upload"></cf-image-input>
 */
export class CFImageInput extends CFFileInput {
  // Override default properties with image-specific defaults
  @property({ type: String })
  override accessor buttonText = "📷 Add Photo";

  @property({ type: String })
  override accessor accept = "image/*";

  @property({ type: Number })
  override accessor maxSizeBytes = 5 * 1024 * 1024; // Default to 5MB for images

  // Image-specific properties
  @property({ type: String })
  accessor capture: "user" | "environment" | false | undefined = undefined;

  /** Alias of `maxFiles`, for backward compatibility. */
  get maxImages(): number | undefined {
    return this.maxFiles;
  }

  set maxImages(value: number | undefined) {
    this.maxFiles = value;
  }

  /**
   * Compresses `file` with the image compression utility when `maxSizeBytes`
   * is set and exceeded, and returns it as is otherwise.
   */
  protected override async compressFile(file: File): Promise<Blob> {
    if (!this.maxSizeBytes || file.size <= this.maxSizeBytes) return file;

    const result = await compressImage(file, {
      maxSizeBytes: this.maxSizeBytes,
    });

    // Log compression result
    if (result.compressedSize < result.originalSize) {
      console.log(
        `Compressed ${file.name}: ${formatFileSize(result.originalSize)} → ${
          formatFileSize(result.compressedSize)
        } (${result.width}x${result.height}, q${result.quality.toFixed(2)})`,
      );
    }

    if (result.compressedSize > this.maxSizeBytes) {
      console.warn(
        `Could not compress ${file.name} below ${
          formatFileSize(this.maxSizeBytes)
        }. Final size: ${formatFileSize(result.compressedSize)}`,
      );
    }

    return result.blob;
  }

  /**
   * Processes `file`, reading its image dimensions and storing it with them.
   */
  protected override async processFile(file: File): Promise<ImageData> {
    const dimensions = await readImageDimensions(file);
    return await this.storeFile(file, dimensions) as ImageData;
  }

  /** Renders the preview, always with `<img>`, these being images. */
  protected override renderPreview(file: ImageData): TemplateResult {
    return html`
      <img src="${file.url}" alt="${file.name}" />
    `;
  }

  /** Renders the file input, adding the `capture` attribute. */
  protected override renderFileInput(): TemplateResult {
    const captureAttr = this.capture !== false ? this.capture : undefined;

    return html`
      <input
        type="file"
        accept="${this.accept}"
        ?multiple="${this.multiple}"
        ?disabled="${this.disabled}"
        capture="${ifDefined(captureAttr)}"
        @change="${this._handleFileChange}"
      />
    `;
  }

  /**
   * Like the inherited `render()`, except the loading text reads
   * `Processing images...`.
   */
  override render() {
    return html`
      <div class="container">
        ${this.renderFileInput()} ${this.renderButton()} ${this.loading
          ? html`
            <div class="loading">Processing images...</div>
          `
          : ""} ${this.renderPreviews()}
      </div>
    `;
  }

  /** Emits an event, adding image-specific event details. */
  protected override emit<T = any>(
    eventName: string,
    detail?: T,
    options?: EventInit,
  ): boolean {
    if (
      (eventName === "cf-change" || eventName === "cf-remove") &&
      (detail as any)?.files
    ) {
      return super.emit(eventName, {
        ...detail,
        images: (detail as any).files,
        allImages: (detail as any).allFiles,
      } as T, options);
    }
    return super.emit(eventName, detail, options);
  }
}

function readImageDimensions(
  file: File,
): Promise<Pick<ImageData, "width" | "height">> {
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: img.width, height: img.height });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load image"));
    };
    img.src = objectUrl;
  });
}
