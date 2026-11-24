/**
 * Tests for audio conversion utilities
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  applyMovingAverageFilter,
  convertToWav,
  createWavFile,
  floatTo16BitPCM,
  mixStereoToMono,
  resample,
  resampleWithAntiAliasing,
} from "./audio-conversion.ts";
import { StandInAudioContext } from "../test-utils/audio-context.ts";

/** The PCM samples of a WAV file `createWavFile()` wrote. */
function samplesOf(wav: ArrayBuffer): number[] {
  return Array.from(new Int16Array(wav.slice(44)));
}

describe("audio-conversion", () => {
  describe("WAV file format", () => {
    it("should create valid WAV header structure", () => {
      // Create a simple PCM data array
      const pcmData = new Int16Array(100);
      for (let i = 0; i < pcmData.length; i++) {
        pcmData[i] = Math.floor(Math.sin(i / 10) * 0x7FFF);
      }

      const numberOfChannels = 1;
      const sampleRate = 16000;

      // Use the actual createWavFile function
      const buffer = createWavFile(pcmData, numberOfChannels, sampleRate);

      const bytesPerSample = 2;
      const dataSize = pcmData.length * bytesPerSample;
      const bufferSize = 44 + dataSize;

      // Verify buffer size
      expect(buffer.byteLength).toBe(bufferSize);

      // Verify header structure
      const headerView = new DataView(buffer);

      // Check RIFF signature
      const riff = String.fromCharCode(
        headerView.getUint8(0),
        headerView.getUint8(1),
        headerView.getUint8(2),
        headerView.getUint8(3),
      );
      expect(riff).toBe("RIFF");

      // Check file size
      expect(headerView.getUint32(4, true)).toBe(bufferSize - 8);

      // Check WAVE signature
      const wave = String.fromCharCode(
        headerView.getUint8(8),
        headerView.getUint8(9),
        headerView.getUint8(10),
        headerView.getUint8(11),
      );
      expect(wave).toBe("WAVE");

      // Check fmt signature
      const fmt = String.fromCharCode(
        headerView.getUint8(12),
        headerView.getUint8(13),
        headerView.getUint8(14),
        headerView.getUint8(15),
      );
      expect(fmt).toBe("fmt ");

      // Check audio format (PCM = 1)
      expect(headerView.getUint16(20, true)).toBe(1);

      // Check number of channels
      expect(headerView.getUint16(22, true)).toBe(numberOfChannels);

      // Check sample rate
      expect(headerView.getUint32(24, true)).toBe(sampleRate);

      // Check data signature
      const data = String.fromCharCode(
        headerView.getUint8(36),
        headerView.getUint8(37),
        headerView.getUint8(38),
        headerView.getUint8(39),
      );
      expect(data).toBe("data");

      // Check data size
      expect(headerView.getUint32(40, true)).toBe(dataSize);
    });
  });

  describe("Float to PCM conversion", () => {
    it("should convert float samples to 16-bit PCM correctly", () => {
      const samples = new Float32Array([
        -1.0, // Should map to -32768 (0x8000)
        0.0, // Should map to 0
        1.0, // Should map to 32767 (0x7FFF)
        0.5, // Should map to ~16383
        -0.5, // Should map to ~-16384
      ]);

      // Use the actual floatTo16BitPCM function
      const pcm = floatTo16BitPCM(samples);

      expect(pcm[0]).toBe(-32768);
      expect(pcm[1]).toBe(0);
      expect(pcm[2]).toBe(32767);
      expect(pcm[3]).toBeCloseTo(16383, 0);
      expect(pcm[4]).toBeCloseTo(-16384, 0);
    });

    it("should clamp values outside -1.0 to 1.0 range", () => {
      const samples = new Float32Array([
        -2.0, // Should clamp to -1.0
        2.0, // Should clamp to 1.0
        -1.5, // Should clamp to -1.0
        1.5, // Should clamp to 1.0
      ]);

      // Use the actual floatTo16BitPCM function
      const pcm = floatTo16BitPCM(samples);

      expect(pcm[0]).toBe(-32768);
      expect(pcm[1]).toBe(32767);
      expect(pcm[2]).toBe(-32768);
      expect(pcm[3]).toBe(32767);
    });
  });

  describe("Resampling", () => {
    it("should resample audio data correctly", () => {
      // Create a simple sine wave at 44100 Hz
      const sourceSampleRate = 44100;
      const targetSampleRate = 16000;
      const samples = new Float32Array(100);

      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin(i / 10);
      }

      // Use the actual resample function
      const result = resample(samples, sourceSampleRate, targetSampleRate);

      // Verify resampled length
      const expectedLength = Math.round(
        samples.length / (sourceSampleRate / targetSampleRate),
      );
      expect(result.length).toBe(expectedLength);
      expect(result.length).toBeCloseTo(36, 0); // ~100 / (44100/16000)

      // Verify values are interpolated (first value should be close to original)
      expect(result[0]).toBeCloseTo(samples[0], 2);

      // Verify it's a new array, not the original
      expect(result).not.toBe(samples);
    });

    it("should return original samples when sample rates match", () => {
      const sampleRate = 16000;
      const samples = new Float32Array([1, 2, 3, 4, 5]);

      // Use the actual resample function
      const result = resample(samples, sampleRate, sampleRate);

      // Should return the same array since no resampling is needed
      expect(result).toBe(samples);
      expect(result.length).toBe(samples.length);

      // Values should be unchanged
      for (let i = 0; i < samples.length; i++) {
        expect(result[i]).toBe(samples[i]);
      }
    });
  });

  describe("Stereo to mono conversion", () => {
    it("should mix stereo channels to mono correctly", () => {
      const left = new Float32Array([0.8, -0.6, 0.4]);
      const right = new Float32Array([0.2, -0.4, 0.6]);

      const mono = mixStereoToMono(left, right);

      expect(mono[0]).toBeCloseTo(0.5, 2); // (0.8 + 0.2) / 2
      expect(mono[1]).toBeCloseTo(-0.5, 2); // (-0.6 + -0.4) / 2
      expect(mono[2]).toBeCloseTo(0.5, 2); // (0.4 + 0.6) / 2
    });
  });

  describe("convertToWav()", () => {
    beforeEach(() => {
      StandInAudioContext.reset();
      Object.defineProperty(globalThis, "AudioContext", {
        configurable: true,
        value: StandInAudioContext,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(globalThis, "AudioContext");
    });

    it("returns a mono 16-bit WAV of the decoded audio at 16 kHz by default", async () => {
      StandInAudioContext.decode = () => ({
        channels: [new Float32Array([0, 0.5, -0.5, 1])],
        sampleRate: 16000,
      });
      const wav = await convertToWav(new Blob([new Uint8Array([1, 2, 3])]));

      expect(wav.type).toBe("audio/wav");
      const bytes = await wav.arrayBuffer();
      const view = new DataView(bytes);
      expect(view.getUint16(22, true)).toBe(1);
      expect(view.getUint32(24, true)).toBe(16000);
      expect(samplesOf(bytes)).toEqual([0, 16383, -16384, 32767]);
      const { made } = StandInAudioContext;
      expect(made.map((c) => c.sampleRate)).toEqual([16000]);
      expect(made[0].decodedBytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(made[0].state).toBe("closed");
    });

    it("returns stereo audio mixed down to mono", async () => {
      StandInAudioContext.decode = () => ({
        channels: [
          new Float32Array([0.5, -0.25]),
          new Float32Array([0.5, 0.25]),
        ],
        sampleRate: 8000,
      });
      const wav = await convertToWav(new Blob([new Uint8Array([1])]), 8000);

      const bytes = await wav.arrayBuffer();
      expect(new DataView(bytes).getUint16(22, true)).toBe(1);
      expect(new DataView(bytes).getUint32(24, true)).toBe(8000);
      expect(samplesOf(bytes)).toEqual([16383, 0]);
    });

    it("returns audio decoded at another rate resampled to the rate asked for", async () => {
      StandInAudioContext.decode = () => ({
        channels: [new Float32Array(48).fill(0.5)],
        sampleRate: 48000,
      });
      const wav = await convertToWav(new Blob([new Uint8Array([1])]), 16000);

      const bytes = await wav.arrayBuffer();
      expect(new DataView(bytes).getUint32(24, true)).toBe(16000);
      expect(samplesOf(bytes)).toEqual(new Array(16).fill(16383));
    });

    it("rejects with the decoding error, and closes the context, when the audio does not decode", async () => {
      const failure = new Error("Unable to decode audio data");
      StandInAudioContext.decode = () => {
        throw failure;
      };
      const reason = await convertToWav(new Blob([])).catch((e: unknown) => e);
      expect(reason).toBe(failure);
      expect(StandInAudioContext.made.map((c) => c.state)).toEqual(["closed"]);
    });
  });

  describe("mixStereoToMono()", () => {
    it("returns the average of the two channels where it stays within 0.95", () => {
      const mono = mixStereoToMono(
        new Float32Array([0.9, -0.9, 0.2]),
        new Float32Array([1, -1, 0]),
      );
      expect(Array.from(mono)).toEqual(
        Array.from(new Float32Array([0.95, -0.95, 0.1])),
      );
    });

    it("returns the average scaled so that its peak is 0.95 where it would exceed that", () => {
      const mono = mixStereoToMono(
        new Float32Array([1, 0.5]),
        new Float32Array([1, 0.5]),
      );
      expect(mono[0]).toBeCloseTo(0.95, 6);
      expect(mono[1]).toBeCloseTo(0.475, 6);
    });
  });

  describe("applyMovingAverageFilter()", () => {
    it("returns the samples themselves for a window of one", () => {
      const samples = new Float32Array([1, 2, 3]);
      expect(applyMovingAverageFilter(samples, 1)).toBe(samples);
    });

    it("returns each sample averaged with its neighbors in the window, fewer at the edges", () => {
      const filtered = applyMovingAverageFilter(
        new Float32Array([3, 6, 9, 0]),
        3,
      );
      expect(Array.from(filtered)).toEqual([4.5, 6, 5, 4.5]);
    });
  });

  describe("resampleWithAntiAliasing()", () => {
    it("returns the samples themselves at the same rate", () => {
      const samples = new Float32Array([1, -1]);
      expect(resampleWithAntiAliasing(samples, 16000, 16000)).toBe(samples);
    });

    it("returns downsampled audio with content above the new rate's band smoothed away", () => {
      // A tone at the source's Nyquist frequency alternates sign every sample.
      // Taken one sample in two it would come through as a constant 1.
      const samples = new Float32Array(16).map((_, i) => (i % 2 ? -1 : 1));
      const result = resampleWithAntiAliasing(samples, 32000, 16000);
      expect(result.length).toBe(8);
      expect(Array.from(resample(samples, 32000, 16000))).toEqual(
        new Array(8).fill(1),
      );
      for (const sample of result) {
        expect(Math.abs(sample)).toBeLessThan(0.5);
      }
    });

    it("returns upsampled audio interpolated without smoothing", () => {
      const samples = new Float32Array([0, 1]);
      expect(Array.from(resampleWithAntiAliasing(samples, 8000, 16000)))
        .toEqual([0, 0.5, 1, 1]);
    });
  });
});
