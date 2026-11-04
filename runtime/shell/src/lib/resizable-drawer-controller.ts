import { ReactiveController, ReactiveControllerHost } from "lit";

export interface ResizableDrawerConfig {
  initialHeight?: number;
  minHeight?: number;
  maxHeightFactor?: number;
  resizeDirection?: "up" | "down";
  storageKey?: string;
}

/**
 * Controller for managing resizable drawer behavior.
 *
 * Provides:
 * - Mouse and touch-based resize handling
 * - Height constraints and persistence
 * - Overlay during resize for smooth interaction
 * - Configurable resize direction
 */
export class ResizableDrawerController implements ReactiveController {
  #host: ReactiveControllerHost;
  #config: Required<ResizableDrawerConfig>;

  #drawerHeight: number;
  #isResizing = false;
  #resizeStartY: number | null = null;
  #startHeight: number | null = null;
  #overlayElement: HTMLDivElement | null = null;

  constructor(
    host: ReactiveControllerHost,
    config: ResizableDrawerConfig = {},
  ) {
    this.#host = host;
    this.#host.addController(this);

    this.#config = {
      initialHeight: config.initialHeight ?? 240,
      minHeight: config.minHeight ?? 150,
      maxHeightFactor: config.maxHeightFactor ?? 0.8,
      resizeDirection: config.resizeDirection ?? "up",
      storageKey: config.storageKey ?? "drawerHeight",
    };

    this.#drawerHeight = this.#config.initialHeight;
  }

  hostConnected() {
    // Load saved height from localStorage
    const savedHeight = localStorage.getItem(this.#config.storageKey);
    if (savedHeight) {
      const height = parseInt(savedHeight, 10);
      if (!isNaN(height) && height >= this.#config.minHeight) {
        this.#drawerHeight = height;
      }
    }
  }

  hostDisconnected() {
    this.#cleanup();
  }

  get drawerHeight(): number {
    return this.#drawerHeight;
  }

  get isResizing(): boolean {
    return this.#isResizing;
  }

  handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    this.#startResize(e.clientY);

    document.addEventListener("mousemove", this.#handleResizeMove);
    document.addEventListener("mouseup", this.#handleResizeEnd);
  };

  handleTouchResizeStart = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      this.#startResize(e.touches[0].clientY);

      document.addEventListener("touchmove", this.#handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", this.#handleTouchEnd);
    }
  };

  #startResize(clientY: number) {
    this.#resizeStartY = clientY;
    this.#startHeight = this.#drawerHeight;
    this.#isResizing = true;

    // Create overlay to capture all mouse events
    this.#overlayElement = document.createElement("div");
    this.#overlayElement.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 9999;
      cursor: ns-resize;
    `;
    document.body.appendChild(this.#overlayElement);

    this.#host.requestUpdate();
  }

  #handleResizeMove = (e: MouseEvent) => {
    this.#updateHeight(e.clientY);
  };

  #handleTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      this.#updateHeight(e.touches[0].clientY);
    }
  };

  #updateHeight(clientY: number) {
    if (this.#resizeStartY !== null && this.#startHeight !== null) {
      // Calculate the difference based on resize direction
      const diff = this.#config.resizeDirection === "up"
        ? this.#resizeStartY - clientY // Moving up increases height
        : clientY - this.#resizeStartY; // Moving down increases height

      const newHeight = Math.max(
        this.#config.minHeight,
        Math.min(
          globalThis.innerHeight * this.#config.maxHeightFactor,
          this.#startHeight + diff,
        ),
      );

      this.#drawerHeight = newHeight;

      // Save to localStorage
      localStorage.setItem(this.#config.storageKey, String(newHeight));

      this.#host.requestUpdate();
    }
  }

  #handleResizeEnd = () => {
    this.#cleanup();
  };

  #handleTouchEnd = () => {
    this.#cleanup();
  };

  #cleanup() {
    this.#resizeStartY = null;
    this.#startHeight = null;
    this.#isResizing = false;

    // Remove overlay
    if (this.#overlayElement) {
      document.body.removeChild(this.#overlayElement);
      this.#overlayElement = null;
    }

    // Remove event listeners
    document.removeEventListener("mousemove", this.#handleResizeMove);
    document.removeEventListener("mouseup", this.#handleResizeEnd);
    document.removeEventListener("touchmove", this.#handleTouchMove);
    document.removeEventListener("touchend", this.#handleTouchEnd);

    this.#host.requestUpdate();
  }
}
