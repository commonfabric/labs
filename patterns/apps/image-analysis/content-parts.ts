import type { ImageData } from "commonfabric";

/** One part of the prompt the image chat sends to the model. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string };

/**
 * The prompt for `question` about `images`: the question when there is one,
 * then each image by its data, or by its URL when it carries no data. An image
 * with neither is left out.
 */
export function contentParts(
  question: string,
  images: readonly ImageData[],
): ContentPart[] {
  const parts: ContentPart[] = question
    ? [{ type: "text", text: question }]
    : [];
  for (const img of images) {
    const image = img.data || img.url;
    if (image) parts.push({ type: "image", image });
  }
  return parts;
}
