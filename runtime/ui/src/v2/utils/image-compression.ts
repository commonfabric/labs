/**
 * Image compression utilities using Canvas API with binary search optimization
 */

export interface CompressionResult {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
  originalSize: number;
  compressedSize: number;
}

export interface CompressionOptions {
  /**
   * Maximum file size in bytes
   */
  maxSizeBytes: number;

  /**
   * Dimensions to try in descending order
   * Default: [2048, 1600, 1200, 800]
   */
  dimensions?: number[];

  /**
   * Minimum quality to try (0.0 - 1.0)
   * Default: 0.5
   */
  minQuality?: number;

  /**
   * Maximum quality to try (0.0 - 1.0)
   * Default: 0.95
   */
  maxQuality?: number;

  /**
   * Quality tolerance for binary search
   * Default: 0.05
   */
  qualityTolerance?: number;
}

/**
 * Compress an image file to meet size requirements using Canvas API
 * Uses binary search to efficiently find optimal quality setting
 *
 * @param file - The image file to compress
 * @param options - Compression options
 * @returns Compressed blob and metadata, or original file if already small enough
 *
 * @example
 * ```ts
 * const result = await compressImage(file, { maxSizeBytes: 5_000_000 });
 * console.log(`Compressed from ${result.originalSize} to ${result.compressedSize}`);
 * ```
 */
export async function compressImage(
  file: File,
  options: CompressionOptions,
): Promise<CompressionResult> {
  const {
    maxSizeBytes,
    dimensions = [2048, 1600, 1200, 800],
    minQuality = 0.5,
    maxQuality = 0.95,
    qualityTolerance = 0.05,
  } = options;

  const imageBitmap = await createImageBitmap(file);

  // The file as given, unchanged, which is what a file already small enough
  // and a file that fails to compress both come back as.
  const original: CompressionResult = {
    blob: file,
    width: imageBitmap.width,
    height: imageBitmap.height,
    quality: 1.0,
    originalSize: file.size,
    compressedSize: file.size,
  };

  try {
    if (file.size <= maxSizeBytes) return original;

    // The size the image is drawn at for a longest side of `maxDim`, never
    // larger than the image itself.
    const sizeAt = (maxDim: number) => {
      const scale = Math.min(
        1,
        maxDim / Math.max(imageBitmap.width, imageBitmap.height),
      );
      return {
        width: Math.floor(imageBitmap.width * scale),
        height: Math.floor(imageBitmap.height * scale),
      };
    };

    // Helper function to compress at given dimensions and quality
    const compressAtSettings = async (
      maxDim: number,
      quality: number,
    ): Promise<Blob> => {
      const { width, height } = sizeAt(maxDim);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        throw new Error("Failed to get canvas context");
      }

      ctx.drawImage(imageBitmap, 0, 0, width, height);

      return await canvas.convertToBlob({
        type: "image/jpeg",
        quality,
      });
    };

    // The highest quality whose encoding at dimension `maxDim` fits: the
    // maximum, or else one found by binary search. Where not even the minimum
    // quality fits, that is what it returns, too large.
    const findOptimalQuality = async (
      maxDim: number,
    ): Promise<{ blob: Blob; quality: number }> => {
      let best = {
        blob: await compressAtSettings(maxDim, minQuality),
        quality: minQuality,
      };
      if (best.blob.size > maxSizeBytes) return best;

      const top = await compressAtSettings(maxDim, maxQuality);
      if (top.size <= maxSizeBytes) return { blob: top, quality: maxQuality };

      let low = minQuality;
      let high = maxQuality;
      while (high - low > qualityTolerance) {
        const mid = (low + high) / 2;
        const blob = await compressAtSettings(maxDim, mid);

        if (blob.size <= maxSizeBytes) {
          best = { blob, quality: mid };
          low = mid;
        } else {
          high = mid;
        }
      }
      return best;
    };

    // Try progressively smaller dimensions, settling for the smallest at the
    // minimum quality where nothing fits.
    let result = original;
    for (const maxDim of dimensions) {
      const { blob, quality } = await findOptimalQuality(maxDim);
      result = {
        blob,
        ...sizeAt(maxDim),
        quality,
        originalSize: file.size,
        compressedSize: blob.size,
      };
      if (blob.size <= maxSizeBytes) break;
    }
    return result;
  } catch (error) {
    console.error("Compression failed, using original:", error);
    return original;
  } finally {
    imageBitmap.close();
  }
}

/**
 * Format file size for display
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
