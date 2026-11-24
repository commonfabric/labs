/**
 * Asks a language model for an ASCII diagram of a topic and shows it in a
 * monospace block. It uses `generateText` and makes no request until a topic
 * is given.
 */

import {
  type AsyncResult,
  computed,
  Default,
  generateText,
  hasError,
  hasSchemaMismatch,
  ifElse,
  isObsolete,
  isPending,
  isSyncing,
  NAME,
  pattern,
  resultOf,
  UI,
  type VNode,
} from "commonfabric";
import { promptAbout } from "./suggestion.ts";

// ===== Types =====

type DiagramInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};

export type DiagramOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  diagram: string;
  pending: boolean;
  availability: string;
  error: string;
};

// ===== Pattern =====

/** Presents a diagram's loading, terminal guidance, and usable content. */
export const DiagramPresentation = pattern<
  { topic: string; responseRequest: AsyncResult<string> },
  DiagramOutput
>(({ topic, responseRequest }) => {
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
        error: responseRequest.message,
      };
    }
    if (isObsolete(responseRequest)) {
      return {
        response: "",
        pending: false,
        availability: "obsolete",
        error: responseRequest.message ||
          "This diagram output has been retired.",
      };
    }
    if (isSyncing(responseRequest)) {
      return {
        response: "",
        pending: true,
        availability: "syncing",
        error: "",
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
    [NAME]: computed(() => (topic ? `Diagram: ${topic}` : "Diagram")),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-heading level={4}>
            {computed(() => topic || "Diagram")}
          </cf-heading>
        </cf-vstack>

        <cf-vstack gap="3" style="padding: 1.5rem;">
          {ifElse(
            responseState.pending,
            <div style="color: var(--cf-theme-color-text-secondary);">
              <cf-loader showElapsed /> Generating diagram...
            </div>,
            ifElse(
              responseState.error,
              <div role="alert" style="color: var(--cf-theme-color-error);">
                {responseState.error}
              </div>,
              <pre style="font-family: monospace; font-size: 0.85rem; line-height: 1.4; overflow-x: auto; white-space: pre; background: var(--cf-theme-color-surface, #f5f5f5); padding: 1rem; border-radius: 0.5rem;">
                {responseState.response}
              </pre>,
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
});

/** Generates an ASCII diagram for the supplied subject. */
const Diagram = pattern<DiagramInput, DiagramOutput>(({ topic, context }) => {
  const prompt = computed(() =>
    promptAbout(topic, "Create a clear ASCII diagram illustrating: ")
  );
  const responseRequest = generateText({
    system:
      "You create clear, well-structured ASCII diagrams using box-drawing characters, arrows, and text art. Use ┌─┐│└─┘ for boxes, ──▶ for arrows, and keep diagrams compact but readable. Output ONLY the diagram with no surrounding explanation.",
    prompt,
    context,
  });
  return DiagramPresentation({ topic, responseRequest });
});

export default Diagram;
