import {
  computed,
  Default,
  generateText,
  hasError,
  hasSchemaMismatch,
  ifElse,
  isPending,
  isSyncing,
  NAME,
  pattern,
  resultOf,
  UI,
  type VNode,
} from "commonfabric";

// ===== Types =====

type SvgDiagramInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};

export type SvgDiagramOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  diagram: string;
  pending: boolean;
  availability: string;
  error: string;
};

// ===== Pattern =====

/**
 * Generates an SVG diagram illustrating relationships, flows, or structures.
 * Designed as "suggestion fuel" - a lightweight utility pattern for visual
 * representation of concepts using scalable vector graphics.
 */
const SvgDiagram = pattern<SvgDiagramInput, SvgDiagramOutput>(
  ({ topic, context }) => {
    // An empty prompt holds the request back: `generateText` clears its
    // state and makes no call until one arrives. A diagram with no topic has
    // nothing to draw, so the model is asked only once a caller names the
    // subject.
    const prompt = computed(() => {
      if (!topic) return "";
      return `Create a clear SVG diagram illustrating: ${topic}`;
    });

    const responseRequest = generateText({
      system:
        "You create clear, well-structured SVG diagrams. Output a single <svg> element with an appropriate viewBox. Use shapes (rect, circle, ellipse), paths, lines, text, and arrows to illustrate concepts. Use readable fonts and clear colors. Output ONLY the SVG element with no surrounding explanation or markdown.",
      prompt,
      context,
    });
    const responseState = computed(() => {
      if (!topic) {
        return {
          response: "",
          pending: false,
          availability: "ready",
          error: "",
        };
      }
      if (isPending(responseRequest)) {
        return {
          response: "",
          pending: true,
          availability: "pending",
          error: "",
        };
      }
      if (hasSchemaMismatch(responseRequest)) {
        return {
          response: "",
          pending: false,
          availability: "schemaMismatch",
          error: "The generated diagram did not match the expected format.",
        };
      }
      if (hasError(responseRequest)) {
        return {
          response: "",
          pending: false,
          availability: "error",
          error: responseRequest.errorMessage,
        };
      }
      if (isSyncing(responseRequest)) {
        return {
          response: "",
          pending: false,
          availability: "syncing",
          error: "Waiting for synchronized data.",
        };
      }
      return {
        response: resultOf(responseRequest),
        pending: false,
        availability: "ready",
        error: "",
      };
    });

    return {
      [NAME]: computed(() => (topic ? `SVG Diagram: ${topic}` : "SVG Diagram")),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>
              {computed(() => topic || "SVG Diagram")}
            </cf-heading>
          </cf-vstack>

          <cf-vstack gap="3" style="padding: 1.5rem;">
            {ifElse(
              responseState.pending,
              <div style="color: var(--cf-theme-color-text-secondary);">
                <cf-loader show-elapsed /> Generating diagram...
              </div>,
              ifElse(
                responseState.error,
                <div role="alert" style="color: var(--cf-theme-color-error);">
                  {responseState.error}
                </div>,
                <cf-svg content={responseState.response} />,
              ),
            )}
          </cf-vstack>
        </cf-screen>
      ),
      topic,
      diagram: responseState.response,
      pending: responseState.pending,
      availability: responseState.availability,
      error: responseState.error,
    };
  },
);

export default SvgDiagram;
