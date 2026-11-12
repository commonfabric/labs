/**
 * Test utility: a stand-in for the Web Audio `AudioContext`, which Deno does
 * not have, covering what the waveform visualizer and the conversion to WAV
 * use. A test installs it as `globalThis.AudioContext` and resets it before
 * each test.
 */

/** Audio as a stand-in context decodes it. */
export interface DecodedAudio {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
}

/** A media source a stand-in context made for a stream. */
export interface StandInMediaSource {
  readonly stream: unknown;
  disconnected: boolean;
}

/** One 16 kHz channel holding a silent sample per byte of `bytes`. */
function samplePerByte(bytes: Uint8Array): DecodedAudio {
  return { channels: [new Float32Array(bytes.length)], sampleRate: 16000 };
}

export class StandInAudioContext {
  /** Every context made since the last reset, newest last. */
  static made: StandInAudioContext[] = [];

  /** Every media source any context made since the last reset. */
  static sources: StandInMediaSource[] = [];

  /**
   * What the bytes given to `decodeAudioData()` decode to. Decoding fails with
   * whatever this throws, as a browser fails on audio it cannot read.
   */
  static decode: (bytes: Uint8Array) => DecodedAudio = samplePerByte;

  /** Forgets every context and source, and decodes a sample per byte again. */
  static reset() {
    StandInAudioContext.made = [];
    StandInAudioContext.sources = [];
    StandInAudioContext.decode = samplePerByte;
  }

  readonly sampleRate: number | undefined;
  state: "running" | "closed" = "running";
  /** The bytes `decodeAudioData()` was last given. */
  decodedBytes?: Uint8Array;

  constructor(options: { sampleRate?: number } = {}) {
    this.sampleRate = options.sampleRate;
    StandInAudioContext.made.push(this);
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 16,
      getByteFrequencyData(data: Uint8Array) {
        data.fill(128);
      },
    };
  }

  createMediaStreamSource(stream: unknown) {
    const source: StandInMediaSource = { stream, disconnected: false };
    StandInAudioContext.sources.push(source);
    return {
      connect() {},
      disconnect() {
        source.disconnected = true;
      },
    };
  }

  decodeAudioData(data: ArrayBuffer) {
    this.decodedBytes = new Uint8Array(data);
    try {
      const { channels, sampleRate } = StandInAudioContext.decode(
        this.decodedBytes,
      );
      return Promise.resolve({
        numberOfChannels: channels.length,
        sampleRate,
        length: channels[0].length,
        getChannelData: (channel: number) => channels[channel],
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}
