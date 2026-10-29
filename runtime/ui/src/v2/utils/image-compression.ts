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

  // If file is already small enough, return as-is
  if (file.size <= maxSizeBytes) {
    const imageBitmap = await createImageBitmap(file);
    return {
      blob: file,
      width: imageBitmap.width,
      height: imageBitmap.height,
      quality: 1.0,
      originalSize: file.size,
      compressedSize: file.size,
    };
  }

  try {
    // Create image bitmap for processing
    const imageBitmap = await createImageBitmap(file);

    // Helper function to compress at given dimensions and quality
    const compressAtSettings = async (
      maxDim: number,
      quality: number,
    ): Promise<Blob> => {
      const scale = Math.min(
        1,
        maxDim / Math.max(imageBitmap.width, imageBitmap.height),
      );
      const width = Math.floor(imageBitmap.width * scale);
      const height = Math.floor(imageBitmap.height * scale);

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

    // Binary search for optimal quality at given dimension
    const findOptimalQuality = async (
      maxDim: number,
    ): Promise<{ blob: Blob; quality: number } | null> => {
      let bestBlob: Blob | null = null;
      let bestQuality = minQuality;

      // First check if even min quality is too large at this dimension
      const minQualityBlob = await compressAtSettings(maxDim, minQuality);
      if (minQualityBlob.size > maxSizeBytes) {
        // Even minimum quality is too large, need to reduce dimension
        return null;
      }

      // Binary search for HIGHEST quality (best visual quality) that still meets size requirement
      let low = minQuality;
      let high = maxQuality;

      while (high - low > qualityTolerance) {
        const mid = (low + high) / 2;
        const blob = await compressAtSettings(maxDim, mid);

        if (blob.size <= maxSizeBytes) {
          // File fits! Try HIGHER quality to maximize image quality
          bestBlob = blob;
          bestQuality = mid;
          low = mid; // Move lower bound UP to search higher quality range
        } else {
          // File too large, need LOWER quality (more compression)
          high = mid; // Move upper bound DOWN to search lower quality range
        }
      }

      // If we found a solution during binary search, return it
      if (bestBlob) {
        return { blob: bestBlob, quality: bestQuality };
      }

      // Edge case: tolerance is large or range is small, so loop exited without finding solution
      // Try both boundaries to find the highest quality that works
      const highBlob = await compressAtSettings(maxDim, high);
      if (highBlob.size <= maxSizeBytes) {
        return { blob: highBlob, quality: high };
      }

      const lowBlob = await compressAtSettings(maxDim, low);
      if (lowBlob.size <= maxSizeBytes) {
        return { blob: lowBlob, quality: low };
      }

      return null;
    };

    // Try progressively smaller dimensions using binary search for quality
    for (const maxDim of dimensions) {
      const result = await findOptimalQuality(maxDim);
      if (result) {
        const scale = Math.min(
          1,
          maxDim / Math.max(imageBitmap.width, imageBitmap.height),
        );
        const width = Math.floor(imageBitmap.width * scale);
        const height = Math.floor(imageBitmap.height * scale);

        return {
          blob: result.blob,
          width,
          height,
          quality: result.quality,
          originalSize: file.size,
          compressedSize: result.blob.size,
        };
      }
    }

    // If all attempts failed, return smallest possible attempt
    const minDim = dimensions[dimensions.length - 1];
    const minScale = Math.min(
      1,
      minDim / Math.max(imageBitmap.width, imageBitmap.height),
    );
    const width = Math.floor(imageBitmap.width * minScale);
    const height = Math.floor(imageBitmap.height * minScale);
    const finalBlob = await compressAtSettings(minDim, minQuality);

    return {
      blob: finalBlob,
      width,
      height,
      quality: minQuality,
      originalSize: file.size,
      compressedSize: finalBlob.size,
    };
  } catch (error) {
    console.error("Compression failed, using original:", error);
    // Return original file as fallback
    const imageBitmap = await createImageBitmap(file);
    return {
      blob: file,
      width: imageBitmap.width,
      height: imageBitmap.height,
      quality: 1.0,
      originalSize: file.size,
      compressedSize: file.size,
    };
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
