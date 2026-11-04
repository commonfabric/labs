import { CFAudioVisualizer } from "./cf-audio-visualizer.ts";

if (!customElements.get("cf-audio-visualizer")) {
  customElements.define("cf-audio-visualizer", CFAudioVisualizer);
}

export type { CFAudioVisualizer as CFAudioVisualizerElement } from "./cf-audio-visualizer.ts";

export { CFAudioVisualizer };
