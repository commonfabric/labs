import {
  type AsyncResult,
  computed,
  generateText,
  handler,
  hasError,
  ifElse,
  ImageData,
  isPending,
  isSyncing,
  NAME,
  observeAvailability,
  pattern,
  resultOf,
  UI,
  VNode,
  Writable,
} from "commonfabric";

/**
 * Image Chat - Simple image upload with LLM analysis
 */

type ImageChatInput = {
  systemPrompt?: string;
  model?: string;
};

export type ImageChatOutput = {
  [NAME]: string;
  [UI]: VNode;
  images: Writable<ImageData[]>;
  prompt: Writable<string>;
  response: string | undefined;
  pending: boolean | undefined;
  ui: VNode;
};

type ImageUploadEvent = {
  detail?: {
    images?: ImageData[];
    allImages?: ImageData[];
    files?: ImageData[];
    allFiles?: ImageData[];
  };
};

/** Presents an image-analysis response and its waiting state. */
export const ImageAnalysisPresentation = pattern<
  { responseRequest: AsyncResult<string> },
  { response: string | undefined; pending: boolean; [UI]: VNode }
>(({ responseRequest }) => {
  const observedResponse = observeAvailability(responseRequest);
  const responseState = computed(() => {
    if (isPending(observedResponse) || isSyncing(observedResponse)) {
      return { response: undefined, pending: true };
    }
    if (hasError(observedResponse)) {
      return { response: undefined, pending: false };
    }
    return { response: resultOf(observedResponse), pending: false };
  });
  const result = responseState.response;
  return {
    response: result,
    pending: responseState.pending,
    [UI]: (
      <div style="display: contents;">
        {ifElse(
          responseState.pending,
          <cf-card>
            <div>Analyzing...</div>
          </cf-card>,
          ifElse(
            result,
            <cf-card>
              <cf-vstack gap="2">
                <cf-heading level={5}>Response</cf-heading>
                <div style="white-space: pre-wrap;">{result}</div>
              </cf-vstack>
            </cf-card>,
            null,
          ),
        )}
      </div>
    ),
  };
});

const syncUploadedImages = handler<
  ImageUploadEvent,
  { images: Writable<ImageData[]> }
>(({ detail }, { images }) => {
  const uploaded = detail?.allImages ?? detail?.allFiles ?? detail?.images ??
    detail?.files ?? [];
  images.set(uploaded);
});

export default pattern<ImageChatInput, ImageChatOutput>(
  ({ systemPrompt }) => {
    const images = new Writable<ImageData[]>([]);
    const prompt = new Writable<string>("");

    // Build content parts array with text and images
    const contentParts = computed(() => {
      const parts: Array<
        { type: "text"; text: string } | { type: "image"; image: string }
      > = [];

      if (prompt.get()) {
        parts.push({ type: "text", text: prompt.get() });
      }

      for (const img of images.get() || []) {
        const image = img.data || img.url;
        if (image) {
          parts.push({ type: "image", image });
        }
      }

      return parts;
    });

    // Generate text from the content parts
    const responseRequest = generateText({
      system: computed(() =>
        systemPrompt ||
        "You are a helpful assistant that can analyze images. Describe what you see."
      ),
      prompt: contentParts,
    });
    const presentation = ImageAnalysisPresentation({ responseRequest });

    const ui = (
      <cf-screen>
        <cf-vstack slot="header" gap="2">
          <cf-heading level={4}>Image Chat</cf-heading>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="3" style="padding: 1rem;">
            {/* Image Upload */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-heading level={5}>Upload Images</cf-heading>
                <cf-image-input
                  multiple
                  maxImages={5}
                  includeData
                  showPreview
                  previewSize="md"
                  removable
                  oncf-change={syncUploadedImages({ images })}
                  oncf-remove={syncUploadedImages({ images })}
                />
              </cf-vstack>
            </cf-card>

            {/* Prompt Input */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-heading level={5}>Your Question</cf-heading>
                <cf-input
                  $value={prompt}
                  placeholder="Ask about the images..."
                />
              </cf-vstack>
            </cf-card>

            {/* Response */}
            {presentation[UI]}
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
    );

    return {
      [NAME]: "Image Chat",
      [UI]: ui,
      images,
      prompt,
      response: presentation.response,
      pending: presentation.pending,
      ui,
    };
  },
);
