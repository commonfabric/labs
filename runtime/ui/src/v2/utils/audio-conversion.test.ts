/**
 * Tests for audio conversion utilities
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  createWavFile,
  floatTo16BitPCM,
  resample,
} from "./audio-conversion.ts";

describe("audio-conversion", () => {
  // These cover the exported helper functions directly, plus two format
  // details asserted in place. `convertToWav` itself
  // requires a browser AudioContext, which Deno's test runner does not
  // provide.

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

      const mono = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        mono[i] = (left[i] + right[i]) / 2;
      }

      expect(mono[0]).toBeCloseTo(0.5, 2); // (0.8 + 0.2) / 2
      expect(mono[1]).toBeCloseTo(-0.5, 2); // (-0.6 + -0.4) / 2
      expect(mono[2]).toBeCloseTo(0.5, 2); // (0.4 + 0.6) / 2
    });
  });

  describe("DataView string writing", () => {
    it("should write ASCII strings correctly", () => {
      const buffer = new ArrayBuffer(10);
      const view = new DataView(buffer);

      const testStrings = ["RIFF", "WAVE", "fmt ", "data"];

      for (const str of testStrings) {
        const offset = 0;
        for (let i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i));
        }

        // Read back
        let result = "";
        for (let i = 0; i < str.length; i++) {
          result += String.fromCharCode(view.getUint8(i));
        }

        expect(result).toBe(str);
      }
    });
  });
});
