import {
  computed,
  Default,
  generateText,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

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
};

// ===== Pattern =====

/**
 * Generates an ASCII diagram illustrating relationships, flows, or structures.
 * Designed as "suggestion fuel" - a lightweight utility pattern for visual
 * representation of concepts using plain text art.
 */
const Diagram = pattern<DiagramInput, DiagramOutput>(({ topic, context }) => {
  // An empty prompt holds the request back: `generateText` clears its state
  // and makes no call until one arrives. A diagram with no topic has nothing
  // to draw, so the model is asked only once a caller names the subject.
  const prompt = computed(() => {
    if (!topic) return "";
    return `Create a clear ASCII diagram illustrating: ${topic}`;
  });

  const response = generateText({
    system:
      "You create clear, well-structured ASCII diagrams using box-drawing characters, arrows, and text art. Use ┌─┐│└─┘ for boxes, ──▶ for arrows, and keep diagrams compact but readable. Output ONLY the diagram with no surrounding explanation.",
    prompt,
    context,
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
            response.pending,
            <div style="color: var(--cf-theme-color-text-secondary);">
              <cf-loader show-elapsed /> Generating diagram...
            </div>,
            <pre style="font-family: monospace; font-size: 0.85rem; line-height: 1.4; overflow-x: auto; white-space: pre; background: var(--cf-theme-color-surface, #f5f5f5); padding: 1rem; border-radius: 0.5rem;">
              {response.result}
            </pre>,
          )}
        </cf-vstack>
      </cf-screen>
    ),
    topic,
    diagram: computed(() => response.result || ""),
    pending: response.pending,
  };
});

export default Diagram;
