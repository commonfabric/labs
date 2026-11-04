import { type CellHandle } from "@commonfabric/runtime-client";
import { css, html, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";

import "../cf-button/index.ts";

/**
 * File System Access API types
 * These are not yet in all TypeScript lib versions
 */
interface FileSystemWritableFileStream extends WritableStream {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle {
  name: string;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>;
}

declare global {
  var showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
}

/**
 * Check if File System Access API is available
 */
const hasFileSystemAccess = (): boolean => {
  return "showDirectoryPicker" in globalThis;
};

/**
 * MIME type to file extension mapping
 */
const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/html": "html",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "application/xml": "xml",
  "application/octet-stream": "bin",
};

/**
 * CFFileDownload - File download button with automatic visual feedback
 *
 * Triggers a file download from string data. The component encapsulates
 * the blob/ObjectURL/anchor download pattern, allowing patterns to trigger
 * downloads without directly accessing globalThis or browser DOM APIs.
 *
 * @element cf-file-download
 *
 * @property {string|CellHandle<string>} data - Content to download (required)
 * @property {string|CellHandle<string>} filename - Download filename (auto-generated if not provided)
 * @attr {string} mime-type - MIME type for the file (default: "application/octet-stream")
 * @attr {boolean} base64 - If true, decode data as base64 before downloading (default: false)
 * @attr {string} variant - Button style variant (default: "secondary")
 *   Options: "primary" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "pill"
 * @attr {string} size - Button size (default: "md")
 *   Options: "xs" | "sm" | "md" | "lg" | "xl" | "icon"
 * @attr {boolean} disabled - Disable the button
 * @attr {number} feedback-duration - Success feedback duration in ms (default: 2000)
 * @attr {boolean} icon-only - Only show icon, no text (default: false)
 * @attr {boolean} allow-autosave - Enable Option+click to activate auto-save mode (default: false)
 *
 * @fires cf-download-success - Fired when download succeeds
 *   Detail: { filename: string, size: number, mimeType: string }
 * @fires cf-download-error - Fired when download fails
 *   Detail: { error: Error, filename: string }
 * @fires cf-autosave-enabled - Fired when auto-save mode is activated
 *   Detail: { directoryName: string }
 * @fires cf-autosave-disabled - Fired when auto-save mode is deactivated
 * @fires cf-autosave-success - Fired when auto-save completes successfully
 *   Detail: { filename: string, size: number }
 * @fires cf-autosave-error - Fired when auto-save fails
 *   Detail: { error: Error }
 *
 * @slot - Button label text (optional, defaults based on state)
 *
 * @example
 * // Basic usage
 * <cf-file-download data="Hello World" filename="hello.txt">Download</cf-file-download>
 *
 * // With Cell binding (in pattern)
 * <cf-file-download
 *   $data={exportData}
 *   $filename={exportFilename}
 *   mime-type="application/json"
 * >Export</cf-file-download>
 *
 * // Icon only
 * <cf-file-download data="data" filename="file.txt" icon-only></cf-file-download>
 *
 * // Base64 binary data
 * <cf-file-download
 *   data={imageBase64}
 *   filename="image.png"
 *   mime-type="image/png"
 *   base64
 * >Download Image</cf-file-download>
 */
export class CFFileDownload extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        position: relative;
        display: inline-block;
      }

      /* Ensure icon-only buttons maintain square aspect ratio */
      :host([icon-only]) cf-button {
        min-width: 2.25rem;
        display: inline-flex;
      }

      /* Adjust for different sizes when icon-only */
      :host([icon-only]) cf-button::part(button) {
        aspect-ratio: 1;
        min-width: fit-content;
      }

      /* Autosave indicator dot */
      .autosave-indicator {
        position: absolute;
        top: -2px;
        right: -2px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        pointer-events: none;
        z-index: 1;
      }

      .autosave-indicator.saved {
        background-color: var(
          --cf-theme-color-success,
          var(--cf-colors-success, #22c55e)
        );
      }

      .autosave-indicator.pending {
        background-color: var(
          --cf-theme-color-warning,
          var(--cf-colors-warning, #f59e0b)
        );
        animation: gentle-pulse 2s ease-in-out infinite;
      }

      .autosave-indicator.saving {
        background-color: var(
          --cf-theme-color-primary,
          var(--cf-colors-info, #3b82f6)
        );
      }

      @keyframes gentle-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.5;
        }
      }

      /* Shake animation for "not available" feedback */
      @keyframes shake {
        0%,
        100% {
          transform: translateX(0);
        }
        20%,
        60% {
          transform: translateX(-4px);
        }
        40%,
        80% {
          transform: translateX(4px);
        }
      }

      :host(.shake) {
        animation: shake 0.4s ease-in-out;
      }

      /* Tooltip for autosave status */
      .autosave-tooltip {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        padding: 4px 8px;
        background: var(
          --cf-theme-color-text,
          var(--cf-colors-gray-900, #16181d)
        );
        color: var(--cf-theme-color-background, var(--cf-colors-gray-50, #ffffff));
        font-size: 12px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.2s;
        margin-bottom: 4px;
        z-index: 10;
      }

      :host(:hover) .autosave-tooltip {
        opacity: 1;
      }
    `,
  ];

  static override properties = {
    data: { attribute: false },
    filename: { attribute: false },
    mimeType: { type: String, attribute: "mime-type" },
    base64: { type: Boolean },
    variant: { type: String },
    size: { type: String },
    disabled: { type: Boolean, reflect: true },
    feedbackDuration: { type: Number, attribute: "feedback-duration" },
    iconOnly: { type: Boolean, attribute: "icon-only", reflect: true },
    allowAutosave: {
      type: Boolean,
      attribute: "allow-autosave",
      reflect: true,
    },
  };

  declare data: CellHandle<string> | string;
  declare filename: CellHandle<string> | string;
  declare mimeType: string;
  declare base64: boolean;
  declare variant?:
    | "primary"
    | "secondary"
    | "destructive"
    | "outline"
    | "ghost"
    | "link"
    | "pill";
  declare size?: "xs" | "sm" | "md" | "lg" | "xl" | "icon";
  declare disabled: boolean;
  declare feedbackDuration: number;
  declare iconOnly: boolean;
  declare allowAutosave: boolean;

  @state()
  private accessor _downloaded = false;

  @state()
  private accessor _downloading = false;

  private _resetTimeout?: ReturnType<typeof setTimeout>;

  // Autosave state
  @state()
  private accessor _autosaveEnabled = false;

  private _autosaveDirHandle: FileSystemDirectoryHandle | null = null;
  private _autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  @state()
  private accessor _isDirty = false;

  private _lastSavedData: string | null = null;

  @state()
  private accessor _isSavingAutosave = false;

  @state()
  private accessor _showNotAvailableTooltip = false;

  @state()
  private accessor _notAvailableMessage = "";

  private _notAvailableTooltipTimeout?: ReturnType<typeof setTimeout>;

  /** Maximum file size in bytes (100MB) */
  private static readonly MAX_FILE_SIZE = 100 * 1024 * 1024;

  /** Delay before revoking object URL to ensure download starts (ms) */
  private static readonly URL_REVOKE_DELAY = 100;

  /** Auto-save interval in milliseconds (60 seconds) */
  private static readonly AUTOSAVE_INTERVAL = 60_000;

  /** CellController for data property */
  private _dataController = createStringCellController(this, {
    timing: { strategy: "immediate" },
  });

  /** CellController for filename property */
  private _filenameController = createStringCellController(this, {
    timing: { strategy: "immediate" },
  });

  constructor() {
    super();
    this.data = "";
    this.filename = "";
    this.mimeType = "application/octet-stream";
    this.base64 = false;
    this.variant = "secondary";
    this.size = "md";
    this.disabled = false;
    this.feedbackDuration = 2000;
    this.iconOnly = false;
    this.allowAutosave = false;
  }

  /**
   * Get the data value (string content to download)
   */
  private _getDataValue(): string {
    return this._dataController.getValue() ?? "";
  }

  /**
   * Sanitize filename to remove potentially problematic characters
   */
  private _sanitizeFilename(filename: string): string {
    // Remove path traversal attempts and problematic characters
    return filename
      .replace(/\.\./g, "_") // No path traversal
      // deno-lint-ignore no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") // No special chars
      .slice(0, 255); // Max filename length
  }

  /**
   * Get the filename, auto-generating if not provided
   */
  private _getFilename(): string {
    const fn = this._filenameController.getValue();
    if (fn) return this._sanitizeFilename(fn);

    // Auto-generate filename with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const ext = MIME_EXTENSIONS[this.mimeType] || "bin";
    return `download-${timestamp}.${ext}`;
  }

  /**
   * Create a Blob from the data, optionally decoding base64
   */
  private _createBlob(data: string): Blob {
    if (this.base64) {
      try {
        // Trim whitespace that may be present in base64 data from various sources
        const binaryString = atob(data.trim());
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new Blob([bytes], { type: this.mimeType });
      } catch (e) {
        throw new Error(`Invalid base64 data: ${(e as Error).message}`);
      }
    }
    return new Blob([data], { type: this.mimeType });
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    // Bind CellControllers when properties change
    if (changedProperties.has("data")) {
      this._dataController.bind(this.data);
    }
    if (changedProperties.has("filename")) {
      this._filenameController.bind(this.filename);
    }
  }

  override updated(_changedProperties: PropertyValues) {
    // Track data changes for autosave (side effect belongs in updated)
    if (this._autosaveEnabled) {
      const currentData = this._getDataValue();
      if (currentData !== this._lastSavedData) {
        this._isDirty = true;
        this._scheduleAutosave();
      }
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    // Add visibility change listener for auto-save on tab switch
    document.addEventListener("visibilitychange", this._handleVisibilityChange);
    globalThis.addEventListener("beforeunload", this._handleBeforeUnload);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resetTimeout) {
      clearTimeout(this._resetTimeout);
    }
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
    }
    if (this._notAvailableTooltipTimeout) {
      clearTimeout(this._notAvailableTooltipTimeout);
    }
    // Remove event listeners
    document.removeEventListener(
      "visibilitychange",
      this._handleVisibilityChange,
    );
    globalThis.removeEventListener("beforeunload", this._handleBeforeUnload);
  }

  /**
   * Handle visibility change - save immediately when tab becomes hidden
   */
  private _handleVisibilityChange = () => {
    if (document.hidden && this._autosaveEnabled && this._isDirty) {
      this._performAutosave();
    }
  };

  /**
   * Handle beforeunload - warn user if there are unsaved changes
   */
  private _handleBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this._autosaveEnabled && this._isDirty) {
      // Attempt to save (may not complete)
      this._performAutosave();
      // Show browser's default "unsaved changes" dialog
      e.preventDefault();
      e.returnValue = "";
    }
  };

  /**
   * Enable autosave mode by prompting user for folder
   */
  private async _enableAutosave(): Promise<boolean> {
    if (!hasFileSystemAccess()) {
      this._showNotAvailableFeedback("Auto-save requires Chrome or Edge");
      return false;
    }

    try {
      // Prompt user to select a folder
      const dirHandle = await globalThis.showDirectoryPicker();

      this._autosaveDirHandle = dirHandle;
      this._autosaveEnabled = true;
      this._lastSavedData = this._getDataValue();
      this._isDirty = false;

      this.emit("cf-autosave-enabled", {
        directoryName: dirHandle.name,
      });

      return true;
    } catch (error) {
      // User cancelled or permission denied
      if ((error as Error).name !== "AbortError") {
        this._showNotAvailableFeedback("Could not access folder");
      }
      return false;
    }
  }

  /**
   * Disable autosave mode
   */
  private _disableAutosave() {
    this._autosaveEnabled = false;
    this._autosaveDirHandle = null;
    this._isDirty = false;
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    this.emit("cf-autosave-disabled", {});
  }

  /**
   * Perform the actual autosave to the selected folder
   */
  private async _performAutosave(): Promise<void> {
    if (!this._autosaveDirHandle || this._isSavingAutosave) return;

    const data = this._getDataValue();
    if (!data) return;

    this._isSavingAutosave = true;

    try {
      const blob = this._createBlob(data);

      // Check file size limit to prevent hanging on huge files
      if (blob.size > CFFileDownload.MAX_FILE_SIZE) {
        throw new Error(
          `File size (${
            Math.round(blob.size / 1024 / 1024)
          }MB) exceeds maximum allowed (${
            Math.round(CFFileDownload.MAX_FILE_SIZE / 1024 / 1024)
          }MB)`,
        );
      }

      // Generate timestamped filename
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const baseName = this._filenameController.getValue() || "backup";
      const ext = MIME_EXTENSIONS[this.mimeType] || "bin";
      const sanitizedBase = this._sanitizeFilename(
        baseName.replace(/\.[^.]+$/, ""),
      );
      const filename = `${sanitizedBase}-${timestamp}.${ext}`;

      // Write to file
      const fileHandle = await this._autosaveDirHandle.getFileHandle(filename, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      // Update state - check if data changed during save (race condition)
      const currentData = this._getDataValue();
      this._lastSavedData = data;
      this._isSavingAutosave = false;

      if (currentData !== data) {
        // Data changed during save, keep dirty and reschedule
        this._isDirty = true;
        this._scheduleAutosave();
      } else {
        this._isDirty = false;
        // Clear timer since we just saved and data is current
        if (this._autosaveTimer) {
          clearTimeout(this._autosaveTimer);
          this._autosaveTimer = null;
        }
      }

      this.emit("cf-autosave-success", {
        filename,
        size: blob.size,
      });
    } catch (error) {
      this._isSavingAutosave = false;

      // Check if permission was revoked
      if ((error as Error).name === "NotAllowedError") {
        this._disableAutosave();
        this._showNotAvailableFeedback("Folder access revoked");
      }

      this.emit("cf-autosave-error", {
        error: error as Error,
      });
    }
  }

  /**
   * Start or reset the autosave timer
   */
  private _scheduleAutosave() {
    if (!this._autosaveEnabled) return;

    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
    }

    this._autosaveTimer = setTimeout(() => {
      this._performAutosave();
    }, CFFileDownload.AUTOSAVE_INTERVAL);
  }

  /**
   * Show "not available" feedback with shake animation and tooltip
   */
  private _showNotAvailableFeedback(message: string) {
    this._showNotAvailableTooltip = true;
    this._notAvailableMessage = message;
    this.classList.add("shake");

    if (this._notAvailableTooltipTimeout) {
      clearTimeout(this._notAvailableTooltipTimeout);
    }

    this._notAvailableTooltipTimeout = setTimeout(() => {
      this._showNotAvailableTooltip = false;
      this.classList.remove("shake");
    }, 2000);
  }

  private _handleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    // Guard against rapid clicks and disabled state
    if (this.disabled || this._downloading) return;

    const mouseEvent = e as MouseEvent;
    const isOptionClick = mouseEvent.altKey;

    // Handle Option+click for autosave toggle
    if (isOptionClick) {
      if (!this.allowAutosave) {
        // Show feedback that autosave is not available for this button
        this._showNotAvailableFeedback(
          "Auto-save not available for this download",
        );
        // Continue with normal download
      } else if (this._autosaveEnabled) {
        // Toggle off
        this._disableAutosave();
        return;
      } else {
        // Toggle on - prompt for folder
        this._enableAutosave();
        return;
      }
    }

    // If autosave is enabled, save to folder instead of browser download
    if (this._autosaveEnabled) {
      this._performAutosave();
      return;
    }

    const data = this._getDataValue();
    const filename = this._getFilename();

    // Check for empty data
    if (!data) {
      this.emit("cf-download-error", {
        error: new Error("No data to download"),
        filename,
      });
      return;
    }

    // Set downloading state to prevent rapid clicks
    this._downloading = true;

    try {
      // Create blob from data
      const blob = this._createBlob(data);

      // Check file size limit
      if (blob.size > CFFileDownload.MAX_FILE_SIZE) {
        throw new Error(
          `File size (${
            Math.round(blob.size / 1024 / 1024)
          }MB) exceeds maximum allowed (${
            Math.round(CFFileDownload.MAX_FILE_SIZE / 1024 / 1024)
          }MB)`,
        );
      }

      const url = URL.createObjectURL(blob);

      // Create and trigger download via anchor element
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Delay URL revocation to ensure download starts in all browsers
      setTimeout(
        () => URL.revokeObjectURL(url),
        CFFileDownload.URL_REVOKE_DELAY,
      );

      // Update state for visual feedback
      this._downloaded = true;
      this._downloading = false;

      this.emit("cf-download-success", {
        filename,
        size: blob.size,
        mimeType: this.mimeType,
      });

      // Reset downloaded state after duration
      if (this._resetTimeout) {
        clearTimeout(this._resetTimeout);
      }
      this._resetTimeout = setTimeout(() => {
        this._downloaded = false;
      }, this.feedbackDuration);
    } catch (error) {
      this._downloading = false;
      this.emit("cf-download-error", {
        error: error as Error,
        filename,
      });
    }
  }

  /**
   * Get the autosave indicator state class
   */
  private _getAutosaveIndicatorClass(): string {
    if (!this._autosaveEnabled) return "";
    if (this._isSavingAutosave) return "saving";
    if (this._isDirty) return "pending";
    return "saved";
  }

  /**
   * Get the tooltip text for autosave state
   */
  private _getAutosaveTooltip(): string {
    if (this._showNotAvailableTooltip) {
      return this._notAvailableMessage;
    }
    if (!this._autosaveEnabled) return "";
    if (this._isSavingAutosave) return "Saving...";
    if (this._isDirty) return "Auto-save on · Saving soon...";
    return "Auto-save on · All changes saved";
  }

  override render() {
    const hasData = !!this._getDataValue();

    // Determine title and aria-label based on state
    let title: string;
    let ariaLabel: string;

    if (this._autosaveEnabled) {
      title = this._getAutosaveTooltip();
      ariaLabel = title;
    } else if (this._downloading) {
      title = "Downloading...";
      ariaLabel = "Downloading file";
    } else if (this._downloaded) {
      title = "Downloaded!";
      ariaLabel = "File downloaded";
    } else if (this.allowAutosave) {
      title = "Download file · Option+click for auto-save";
      ariaLabel = "Download file, option click to enable auto-save";
    } else {
      title = "Download file";
      ariaLabel = "Download file";
    }

    // Determine icon
    const icon = this._autosaveEnabled
      ? "\uD83D\uDD04" // 🔄
      : this._downloading
      ? "\u23F3" // ⏳
      : this._downloaded
      ? "\u2713" // ✓
      : "\u2B07"; // ⬇

    // Determine button text
    const buttonText = this._autosaveEnabled
      ? this._isSavingAutosave
        ? "\uD83D\uDD04 Saving..."
        : "\uD83D\uDD04 Auto-save"
      : this._downloading
      ? "\u23F3 Downloading..."
      : this._downloaded
      ? "\u2713 Downloaded!"
      : "\u2B07 Download";

    const indicatorClass = this._getAutosaveIndicatorClass();
    const tooltipText = this._showNotAvailableTooltip || this._autosaveEnabled
      ? this._getAutosaveTooltip()
      : "";

    return html`
      ${indicatorClass
        ? html`
          <span class="autosave-indicator ${indicatorClass}"></span>
        `
        : null} ${tooltipText
        ? html`
          <span class="autosave-tooltip">${tooltipText}</span>
        `
        : null}
      <cf-button
        variant="${this.variant || "secondary"}"
        size="${this.size || "md"}"
        ?disabled="${this.disabled || !hasData || this._downloading}"
        @click="${this._handleClick}"
        title="${title}"
        aria-label="${ariaLabel}"
      >
        ${this.iconOnly
          ? html`
            ${icon}
          `
          : html`
            <slot>${buttonText}</slot>
          `}
      </cf-button>
    `;
  }
}
