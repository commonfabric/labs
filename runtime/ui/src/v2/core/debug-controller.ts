import { ReactiveController, type ReactiveControllerHost } from "lit";

const DEBUG_BORDER_WIDTH = 5;
const ANIMATION_DURATION_SECONDS = 1.5;
const ANIMATION_FALLOFF_PERCENT = 0.5;

const keyframes = [
  {
    outline: `rgba(255, 0, 0, 1) ${DEBUG_BORDER_WIDTH}px solid`,
  },
  {
    outline: `rgba(255, 0, 0, 1) ${DEBUG_BORDER_WIDTH}px solid`,
    offset: ANIMATION_FALLOFF_PERCENT,
  },
  {
    outline: `rgba(255, 0, 0, 0) ${DEBUG_BORDER_WIDTH}px solid`,
  },
];

// Renders an outline on host LitElement on every render.
export class DebugController implements ReactiveController {
  #host: ReactiveControllerHost & HTMLElement;
  #connected = false;

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this.#host = host;
    this.#host.addController(this);
  }

  hostConnected(): void {
    this.#connected = true;
  }
  hostDisconnected(): void {
    this.#connected = false;
  }

  hostUpdated() {
    if (!this.#connected) {
      return;
    }
    this.#host.animate(keyframes, ANIMATION_DURATION_SECONDS * 1000);
  }
}
