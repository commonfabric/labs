import { css, html, svg } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFAudioVisualizer - Real-time audio waveform visualization
 *
 * @element cf-audio-visualizer
 *
 * @attr {number} bars - Number of frequency bars to display (default: 8)
 * @attr {string} color - Bar color (default: 'white')
 * @attr {number} height - Visualizer height in pixels (default: 40)
 *
 * @example
 * <cf-audio-visualizer bars={12} color="#5865F2" height={48}></cf-audio-visualizer>
 */
export class CFAudioVisualizer extends BaseElement {
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

      .visualizer {
        width: 100%;
        height: 100%;
      }

      svg {
        display: block;
        width: 100%;
        height: 100%;
      }
    `,
  ];

  @property({ type: Number })
  accessor bars = 8;

  @property({ type: String })
  accessor color = "white";

  @property({ type: Number })
  accessor height = 40;

  @property({ type: Array })
  private accessor waveformData: number[] = [];

  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private animationFrameId?: number;
  private _stream?: MediaStream;
  private sourceNode?: MediaStreamAudioSourceNode;

  /** Pre-allocated array for frequency data to avoid GC pressure */
  private _frequencyData?: Uint8Array<ArrayBuffer>;

  /** Pre-allocated array for normalized waveform values */
  private _waveformBuffer: number[] = [];

  /**
   * Start visualization with an audio stream
   */
  startVisualization(stream: MediaStream) {
    this.stopVisualization();

    this._stream = stream;

    // Reuse AudioContext if it exists and is not closed
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContext();
    }

    this.analyser = this.audioContext.createAnalyser();
    this.sourceNode = this.audioContext.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);

    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    // Pre-allocate frequency data buffer (reused every frame)
    this._frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

    // Pre-allocate waveform buffer for the bar count
    const barCount = this.bars;
    if (this._waveformBuffer.length !== barCount) {
      this._waveformBuffer = new Array(barCount).fill(0);
    }

    const update = () => {
      if (!this._stream || !this.analyser || !this._frequencyData) return;

      this.analyser.getByteFrequencyData(this._frequencyData);

      // Sample data at regular intervals to match bar count
      // Skip the first few bins (low frequencies that contain ambient noise)
      const skipBins = 2;
      const usableLength = this._frequencyData.length - skipBins;
      const step = Math.floor(usableLength / barCount);

      // Update buffer in place instead of creating new array
      for (let i = 0; i < barCount; i++) {
        const index = Math.min(
          skipBins + i * step,
          this._frequencyData.length - 1,
        );
        this._waveformBuffer[i] = this._frequencyData[index] / 255;
      }

      // Trigger update by assigning the same reference
      // Lit will detect the change via the @property decorator
      this.waveformData = this._waveformBuffer;

      this.requestUpdate();
      this.animationFrameId = requestAnimationFrame(update);
    };

    update();
  }

  /**
   * Stop visualization and clean up resources
   */
  stopVisualization() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }

    // Disconnect source node but keep AudioContext for reuse
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined;
    }

    this.analyser = undefined;
    this._stream = undefined;
    this._frequencyData = undefined;
    this.waveformData = [];
    // Keep _waveformBuffer allocated for potential reuse
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopVisualization();

    // Close AudioContext when element is removed from DOM
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = undefined;
    }
  }

  override render() {
    const barCount = this.waveformData.length || this.bars;
    const barWidth = 100 / barCount; // Percentage
    const heightPx = this.height;

    // Default to minimal bars if no data
    const data = this.waveformData.length > 0
      ? this.waveformData
      : Array(barCount).fill(0.1);

    return html`
      <div class="visualizer">
        <svg
          width="100%"
          height="${heightPx}px"
          preserveAspectRatio="none"
          viewBox="0 0 100 ${heightPx}"
        >
          ${data.map((value, i) => {
            const x = i * barWidth;
            const barHeight = Math.max(value * heightPx, 2); // Min height of 2px
            const y = heightPx - barHeight;

            return svg`
              <rect
                x="${x}%"
                y="${y}"
                width="${barWidth * 0.7}%"
                height="${barHeight}"
                fill="${this.color}"
                rx="1"
              />
            `;
          })}
        </svg>
      </div>
    `;
  }
}
