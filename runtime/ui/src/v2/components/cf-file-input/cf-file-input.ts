import type { DID } from "@commonfabric/identity";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { css, html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";
import {
  type StoredFile,
  type StoreFileOptions,
  uploadFile,
} from "../../utils/file-cell-storage.ts";
import { formatFileSize } from "../../utils/image-compression.ts";
import type { ButtonSize, ButtonVariant } from "../cf-button/cf-button.ts";
import { applyThemeToElement, type CFTheme } from "../theme-context.ts";

import "../cf-button/index.ts";

export type FileData = StoredFile;

/**
 * CFFileInput - Generic file upload component
 *
 * @element cf-file-input
 *
 * @attr {boolean} multiple - Allow multiple files (default: false)
 * @attr {number} maxFiles - Max number of files (default: unlimited)
 * @attr {string} accept - File types to accept (default: "*\/*")
 * @attr {string} buttonText - Custom button text (default: "📎 Add File")
 * @attr {string} variant - Button style variant
 * @attr {string} size - Button size
 * @attr {boolean} showPreview - Show file previews (default: true)
 * @attr {string} previewSize - Preview thumbnail size: "sm" | "md" | "lg"
 * @attr {boolean} removable - Allow removing files (default: true)
 * @attr {boolean} disabled - Disable the input
 * @attr {number} maxSizeBytes - Max size warning threshold (default: none)
 * @attr {boolean} includeData - Include a data URL in emitted file descriptors
 *
 * @fires cf-change - Fired when file(s) are added or removed. On add, files contains the newly added files. On remove, files contains the updated full list for compatibility. detail: { files: StoredFile[], allFiles: StoredFile[] }
 * @fires cf-remove - Fired when a file is removed. detail: { id: string, files: StoredFile[], allFiles: StoredFile[] }
 * @fires cf-error - Fired when an error occurs. detail: { error: Error, message: string }
 *
 * @example
 * <cf-file-input accept=".pdf,.docx" buttonText="📄 Upload Document"></cf-file-input>
 * @example
 * <cf-file-input accept="image/\*,application/pdf" multiple></cf-file-input>
 */
export class CFFileInput extends BaseElement {
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

      .container {
        display: flex;
        flex-direction: column;
        gap: var(--cf-theme-spacing-normal, 0.75rem);
      }

      input[type="file"] {
        display: none;
      }

      .previews {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: var(--cf-theme-spacing-normal, 0.75rem);
      }

      .preview-item {
        position: relative;
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        overflow: hidden;
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        background: var(
          --cf-theme-color-background,
          #f9fafb
        );
      }

      .preview-item img {
        width: 100%;
        height: 120px;
        object-fit: cover;
        display: block;
      }

      .preview-item.size-sm img,
      .preview-item.size-sm .file-preview {
        height: 80px;
      }

      .preview-item.size-lg img,
      .preview-item.size-lg .file-preview {
        height: 160px;
      }

      .file-preview {
        width: 100%;
        height: 120px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 1rem;
        background: var(
          --cf-theme-color-background,
          #f9fafb
        );
      }

      .file-icon {
        font-size: 2rem;
        line-height: 1;
      }

      .file-name {
        font-size: 0.75rem;
        text-align: center;
        word-break: break-word;
        color: var(
          --cf-theme-color-text-muted,
          #4b5563
        );
      }

      .remove-button {
        position: absolute;
        top: 4px;
        right: 4px;
        background: rgba(0, 0, 0, 0.6);
        color: white;
        border: none;
        border-radius: 50%;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0;
        transition: background 0.2s ease;
      }

      .remove-button:hover {
        background: rgba(0, 0, 0, 0.8);
      }

      .file-info {
        padding: 6px 8px;
        font-size: 0.75rem;
        color: var(
          --cf-theme-color-text-muted,
          #4b5563
        );
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        color: var(
          --cf-theme-color-text-muted,
          #4b5563
        );
        font-size: 0.875rem;
      }
    `,
  ];

  @property({ type: Boolean })
  accessor multiple = false;

  @property({ type: Number })
  accessor maxFiles: number | undefined = undefined;

  @property({ type: String })
  accessor accept = "*/*";

  @property({ type: String })
  accessor buttonText = "📎 Add File";

  @property({ type: String })
  accessor variant: ButtonVariant = "outline";

  @property({ type: String })
  accessor size: ButtonSize = "md";

  @property({ type: Boolean })
  accessor showPreview = true;

  @property({ type: String })
  accessor previewSize: "sm" | "md" | "lg" = "md";

  @property({ type: Boolean })
  accessor removable = true;

  @property({ type: Boolean })
  accessor disabled = false;

  @property({ type: Number })
  accessor maxSizeBytes: number | undefined = undefined;

  @property({ type: Boolean })
  accessor includeData = false;

  @property({ type: Boolean })
  protected accessor loading = false;

  @state()
  protected accessor storedFiles: StoredFile[] = [];

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  protected getFiles(): StoredFile[] {
    return [...this.storedFiles];
  }

  protected setFiles(newFiles: StoredFile[]): void {
    this.storedFiles = newFiles;
  }

  /**
   * Process a file and return a stored file descriptor link.
   * Subclasses can override this to add custom processing
   */
  protected async processFile(file: File): Promise<StoredFile> {
    return await this.storeFile(file);
  }

  protected async storeFile(
    file: File,
    metadata?: Partial<Pick<StoreFileOptions, "width" | "height" | "metadata">>,
  ): Promise<StoredFile> {
    if (!this.runtime) {
      throw new Error("Runtime is not available for file storage");
    }
    if (!this.space) {
      throw new Error("Space is not available for file storage");
    }
    return await uploadFile({
      file,
      runtime: this.runtime,
      space: this.space,
      includeDataUrl: this.includeData,
      ...metadata,
    });
  }

  /**
   * Determine if a file should be compressed
   * Base class: never compress (subclasses override)
   */
  protected shouldCompressFile(_file: File): boolean {
    return false;
  }

  /**
   * Compress a file
   * Subclasses override this for specific compression logic
   */
  protected compressFile(file: File): Promise<Blob> {
    return Promise.resolve(file);
  }

  /**
   * Render preview for a file
   * Subclasses can override for custom preview rendering
   */
  protected renderPreview(file: StoredFile): TemplateResult {
    // Smart default preview based on MIME type
    if (file.type.startsWith("image/")) {
      return html`
        <img src="${file.url}" alt="${file.name}" />
      `;
    }

    // Generic file preview with icon
    const icon = this._getFileIcon(file.type);
    return html`
      <div class="file-preview">
        <div class="file-icon">${icon}</div>
        <div class="file-name">${file.name}</div>
      </div>
    `;
  }

  /**
   * Render the file input element
   * Subclasses can override to add custom attributes (e.g., capture)
   */
  protected renderFileInput(): TemplateResult {
    return html`
      <input
        type="file"
        accept="${this.accept}"
        ?multiple="${this.multiple}"
        ?disabled="${this.disabled}"
        @change="${this._handleFileChange}"
      />
    `;
  }

  protected renderButton(): TemplateResult {
    return html`
      <cf-button
        variant="${this.variant}"
        size="${this.size}"
        ?disabled="${this.disabled || this.loading}"
        @click="${this._handleButtonClick}"
      >
        ${this.loading ? "Loading..." : this.buttonText}
      </cf-button>
    `;
  }

  protected renderPreviews(): TemplateResult {
    const currentFiles = this.getFiles();

    if (!this.showPreview || currentFiles.length === 0) {
      return html`
      `;
    }

    return html`
      <div class="previews">
        ${currentFiles.map(
          (file) =>
            html`
              <div class="preview-item size-${this.previewSize}">
                ${this.renderPreview(file)} ${this.removable
                  ? html`
                    <button
                      type="button"
                      class="remove-button"
                      @click="${() => this._handleRemove(file.id)}"
                      aria-label="Remove file"
                    >
                      ×
                    </button>
                  `
                  : ""}
                <div class="file-info" title="${file.name}">
                  ${file.name} (${formatFileSize(file.size)})
                </div>
              </div>
            `,
        )}
      </div>
    `;
  }

  private _getFileIcon(mimeType: string): string {
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType === "application/pdf") return "📄";
    if (mimeType.startsWith("video/")) return "🎬";
    if (mimeType.startsWith("audio/")) return "🎵";
    if (mimeType.startsWith("text/")) return "📝";
    if (
      mimeType.includes("word") ||
      mimeType.includes("document") ||
      mimeType.includes("openxmlformats")
    ) {
      return "📝";
    }
    if (mimeType.includes("sheet") || mimeType.includes("excel")) return "📊";
    if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) {
      return "📽️";
    }
    return "📎";
  }

  private _handleButtonClick() {
    this.emit("cf-click"); // Emit before opening file picker
    const input = this.shadowRoot?.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    input?.click();
  }

  protected async _handleFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;

    if (!files || files.length === 0) return;

    const currentFiles = this.getFiles();

    // Check max files limit (only for multiple mode)
    // Single-file mode replaces existing files, so no max check needed
    if (this.multiple && this.maxFiles) {
      const totalFiles = currentFiles.length + files.length;
      if (totalFiles > this.maxFiles) {
        this.emit("cf-error", {
          error: new Error("Max files exceeded"),
          message: `Maximum ${this.maxFiles} files allowed`,
        });
        return;
      }
    }

    this.loading = true;

    try {
      const newFiles: StoredFile[] = [];

      for (const file of Array.from(files)) {
        try {
          // Check if should compress (subclass decides)
          let fileToProcess: Blob = file;
          if (this.shouldCompressFile(file)) {
            fileToProcess = await this.compressFile(file);
          }

          // Check file size AFTER compression if maxSizeBytes is set
          if (this.maxSizeBytes && fileToProcess.size > this.maxSizeBytes) {
            console.warn(
              `File ${file.name} (${
                formatFileSize(fileToProcess.size)
              }) exceeds maxSizeBytes (${
                formatFileSize(this.maxSizeBytes)
              }) even after compression`,
            );
          }

          // Process file (subclass can override)
          const fileData = await this.processFile(
            new File([fileToProcess], file.name, { type: file.type }),
          );
          newFiles.push(fileData);
        } catch (error) {
          this.emit("cf-error", {
            error: error as Error,
            message: `Failed to process ${file.name}`,
          });
        }
      }

      if (newFiles.length === 0) return;

      // When multiple is false, replace existing files instead of appending
      const updatedFiles = this.multiple
        ? [...currentFiles, ...newFiles]
        : newFiles;
      this.setFiles(updatedFiles);
      this.emit("cf-change", { files: newFiles, allFiles: updatedFiles });
    } finally {
      this.loading = false;
      // Reset input so same file can be selected again
      input.value = "";
    }
  }

  private _handleRemove(id: string) {
    const currentFiles = this.getFiles();
    const updatedFiles = currentFiles.filter((file) => file.id !== id);
    this.setFiles(updatedFiles);
    this.emit("cf-remove", { id, files: updatedFiles, allFiles: updatedFiles });
    this.emit("cf-change", { files: updatedFiles, allFiles: updatedFiles });
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
    }
  }

  override render() {
    return html`
      <div class="container">
        ${this.renderFileInput()} ${this.renderButton()} ${this.loading
          ? html`
            <div class="loading">Processing files...</div>
          `
          : ""} ${this.renderPreviews()}
      </div>
    `;
  }
}
