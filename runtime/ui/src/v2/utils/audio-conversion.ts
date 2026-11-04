/**
 * Audio conversion utilities for voice input components
 */

/**
 * Convert a Blob (WebM, MP3, etc.) to WAV format using Web Audio API
 * @param blob - The audio blob to convert
 * @param sampleRate - Target sample rate (default: 16000)
 * @returns WAV formatted blob
 */
export async function convertToWav(
  blob: Blob,
  sampleRate = 16000,
): Promise<Blob> {
  // Read the blob as ArrayBuffer
  const arrayBuffer = await blob.arrayBuffer();

  // Create audio context with target sample rate
  const audioContext = new AudioContext({ sampleRate });

  try {
    // Decode the audio data
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Convert to WAV
    const wavBlob = audioBufferToWav(audioBuffer, sampleRate);

    return wavBlob;
  } finally {
    // Clean up audio context
    await audioContext.close();
  }
}

/**
 * Convert an AudioBuffer to WAV format
 * @param audioBuffer - The audio buffer to convert
 * @param targetSampleRate - Target sample rate for resampling (optional)
 * @returns WAV formatted blob
 */
function audioBufferToWav(
  audioBuffer: AudioBuffer,
  targetSampleRate?: number,
): Blob {
  const sampleRate = targetSampleRate || audioBuffer.sampleRate;
  const numberOfChannels = 1; // Force mono
  let channelData: Float32Array;

  // If source is stereo, mix down to mono with clipping protection
  if (audioBuffer.numberOfChannels === 2) {
    channelData = mixStereoToMono(
      audioBuffer.getChannelData(0),
      audioBuffer.getChannelData(1),
    );
  } else {
    channelData = audioBuffer.getChannelData(0);
  }

  // Resample if needed
  if (targetSampleRate && targetSampleRate !== audioBuffer.sampleRate) {
    channelData = resampleWithAntiAliasing(
      channelData,
      audioBuffer.sampleRate,
      targetSampleRate,
    );
  }

  // Convert float samples to 16-bit PCM
  const pcmData = floatTo16BitPCM(channelData);

  // Create WAV file
  const wavBuffer = createWavFile(pcmData, numberOfChannels, sampleRate);

  return new Blob([wavBuffer], { type: "audio/wav" });
}

/**
 * Mix stereo channels to mono with clipping protection
 * Uses peak detection and soft limiting to prevent distortion
 * @internal Exported for testing
 */
export function mixStereoToMono(
  left: Float32Array,
  right: Float32Array,
): Float32Array {
  const result = new Float32Array(left.length);

  // First pass: find the peak level after mixing
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const mixed = (left[i] + right[i]) * 0.5;
    const abs = Math.abs(mixed);
    if (abs > peak) peak = abs;
  }

  // Calculate gain reduction needed to prevent clipping
  // Leave some headroom (0.95) to avoid edge cases
  const gainReduction = peak > 0.95 ? 0.95 / peak : 1.0;

  // Second pass: mix with gain reduction applied
  for (let i = 0; i < left.length; i++) {
    result[i] = (left[i] + right[i]) * 0.5 * gainReduction;
  }

  return result;
}

/**
 * Resample audio data with anti-aliasing filter
 * Applies a low-pass filter before downsampling to prevent aliasing artifacts
 * @internal Exported for testing
 */
export function resampleWithAntiAliasing(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return samples;
  }

  let filtered = samples;

  // Apply low-pass filter when downsampling to prevent aliasing
  if (targetSampleRate < sourceSampleRate) {
    // Simple moving average filter - window size based on decimation ratio
    // This acts as a crude low-pass filter
    const ratio = sourceSampleRate / targetSampleRate;
    const filterSize = Math.max(2, Math.ceil(ratio));
    filtered = applyMovingAverageFilter(samples, filterSize);
  }

  // Now resample with linear interpolation
  return resample(filtered, sourceSampleRate, targetSampleRate);
}

/**
 * Apply a simple moving average low-pass filter
 * @internal Exported for testing
 */
export function applyMovingAverageFilter(
  samples: Float32Array,
  windowSize: number,
): Float32Array {
  if (windowSize <= 1) return samples;

  const result = new Float32Array(samples.length);
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    let count = 0;

    // Average samples within the window
    for (
      let j = Math.max(0, i - halfWindow);
      j <= Math.min(samples.length - 1, i + halfWindow);
      j++
    ) {
      sum += samples[j];
      count++;
    }

    result[i] = sum / count;
  }

  return result;
}

/**
 * Resample audio data to a different sample rate
 * Uses linear interpolation for simplicity
 * @internal Exported for testing
 */
export function resample(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return samples;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;

    if (index + 1 < samples.length) {
      // Linear interpolation
      result[i] = samples[index] * (1 - fraction) +
        samples[index + 1] * fraction;
    } else {
      result[i] = samples[index];
    }
  }

  return result;
}

/**
 * Convert float samples (-1.0 to 1.0) to 16-bit PCM
 * @internal Exported for testing
 */
export function floatTo16BitPCM(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Clamp to -1.0 to 1.0 range
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Convert to 16-bit integer
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm;
}

/**
 * Create a WAV file from PCM data
 * @internal Exported for testing
 */
export function createWavFile(
  pcmData: Int16Array,
  numberOfChannels: number,
  sampleRate: number,
): ArrayBuffer {
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.length * bytesPerSample;
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // WAV header
  let offset = 0;

  // "RIFF" chunk descriptor
  writeString(view, offset, "RIFF");
  offset += 4;
  view.setUint32(offset, bufferSize - 8, true); // File size - 8
  offset += 4;
  writeString(view, offset, "WAVE");
  offset += 4;

  // "fmt " sub-chunk
  writeString(view, offset, "fmt ");
  offset += 4;
  view.setUint32(offset, 16, true); // Subchunk size (16 for PCM)
  offset += 4;
  view.setUint16(offset, 1, true); // Audio format (1 = PCM)
  offset += 2;
  view.setUint16(offset, numberOfChannels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true); // Bits per sample
  offset += 2;

  // "data" sub-chunk
  writeString(view, offset, "data");
  offset += 4;
  view.setUint32(offset, dataSize, true);
  offset += 4;

  // Write PCM data
  for (let i = 0; i < pcmData.length; i++) {
    view.setInt16(offset, pcmData[i], true);
    offset += 2;
  }

  return buffer;
}

/**
 * Write a string to a DataView
 */
function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
