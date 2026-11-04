import {
  type AsyncResult,
  computed,
  Default,
  generateText,
  hasError,
  ifElse,
  isPending,
  isSyncing,
  NAME,
  pattern,
  resultOf,
  UI,
  type UnavailableErrorKind,
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
  errorKind: UnavailableErrorKind | undefined;
};

// ===== Pattern =====

/**
 * Presents generated SVG content with explicit waiting and error states.
 */
export const SvgDiagramPresentation = pattern<
  { topic: string; responseRequest: AsyncResult<string> },
  SvgDiagramOutput
>(
  ({ topic, responseRequest }) => {
    const responseState = computed(() => {
      if (!topic) {
        return {
          response: "",
          pending: false,
          availability: "ready",
          error: "",
          errorKind: undefined,
        };
      }
      if (isPending(responseRequest)) {
        return {
          response: "",
          pending: true,
          availability: "pending",
          error: "",
          errorKind: undefined,
        };
      }
      if (hasError(responseRequest)) {
        return {
          response: "",
          pending: false,
          availability: "error",
          error: responseRequest.errorMessage,
          errorKind: responseRequest.errorKind,
        };
      }
      if (isSyncing(responseRequest)) {
        return {
          response: "",
          pending: true,
          availability: "syncing",
          error: "",
          errorKind: undefined,
        };
      }
      return {
        response: resultOf(responseRequest),
        pending: false,
        availability: "ready",
        error: "",
        errorKind: undefined,
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
              responseState.availability === "syncing",
              <div role="status">Waiting for synchronized data.</div>,
              ifElse(
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
      errorKind: responseState.errorKind,
    };
  },
);

/** Generates the request displayed by the SVG diagram presentation. */
const SvgDiagram = pattern<SvgDiagramInput, SvgDiagramOutput>(
  ({ topic, context }) => {
    // An empty prompt holds the request back: no provider call starts until
    // the caller names a subject.
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
    return SvgDiagramPresentation({ topic, responseRequest });
  },
);

export default SvgDiagram;
