import {
  compileAndRun,
  computed,
  Default,
  generateText,
  handler,
  hasError,
  ifElse,
  isPending,
  NAME,
  navigateTo,
  pattern,
  resultOf,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface Input {
  prompt: string | Default<"Create a simple counter">;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  prompt: string;
}

const updatePrompt = handler<
  { detail: { message: string } },
  { prompt: Writable<string> }
>((event, { prompt }) => {
  const newPrompt = event.detail?.message?.trim();
  if (newPrompt) {
    prompt.set(newPrompt);
  }
});

const visit = handler<unknown, { result: Writable<any> }>((_, { result }) => {
  return navigateTo(result);
});

export default pattern<Input, Output>(({ prompt }) => {
  // Template for the AI to reference
  const template =
    `import { computed, handler, Default, NAME, pattern, UI } from "commonfabric";

interface Input {
  value: number | Default<0>;
}

const increment = handler<unknown, { value: Writable<number> }>(
  (_, { value }) => value.increment(1)
);

const decrement = handler<unknown, { value: Writable<number> }>(
  (_, { value }) => value.increment(-1)
);

export default pattern<Input>(({ value }) => {
  return {
    [NAME]: computed(() => \`Counter: \${value}\`),
    [UI]: (
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <cf-button onClick={decrement({ value })}>-</cf-button>
        <span>{value}</span>
        <cf-button onClick={increment({ value })}>+</cf-button>
      </div>
    ),
    value,
  };
});`;

  const systemPrompt =
    `You are a Common Fabric pattern generator. Given a user request, generate a complete TypeScript pattern file.

IMPORTANT RULES:
1. CTS transforms always run; write the pattern as ordinary TypeScript
2. Import from "commonfabric": Writable, Default, computed, handler, NAME, pattern, UI, ifElse
3. Use the pattern<Input>() or pattern<Input, Output>() API
4. For arrays that need mutation, use Writable<T[]> in the interface
5. Use $checked, $value for bidirectional binding on cf-checkbox, cf-input
6. Use inline handlers for simple operations, handler() for complex ones
7. Always return [NAME] and [UI] from the pattern
8. Use computed() for derived values and data transformations

TEMPLATE FOR REFERENCE:
${template}

Generate ONLY the TypeScript code, no explanations or markdown.`;

  // Step 1: Generate pattern source code from prompt
  const generatedRequest = generateText({
    system: systemPrompt,
    prompt,
  });
  const generated = resultOf(generatedRequest);

  const processedResult = computed(() => {
    // Remove wrapping ```typescript``` if it exists
    return generated.replace(/^```typescript\n?/, "").replace(/\n?```$/, "");
  });

  // Step 2: Compile the generated code when ready
  const compileParams = computed(() => ({
    files: processedResult
      ? [{ name: "/main.tsx", contents: processedResult }]
      : [],
    main: processedResult ? "/main.tsx" : "",
  }));

  const compileRequest = compileAndRun(compileParams);
  const compiledPiece = resultOf(compileRequest);

  // Compute states
  const isGenerating = isPending(generatedRequest);
  const hasCode = computed(() => !!generated);
  const isCompiling = computed(() => isPending(compileRequest));
  const compileFailed = computed(() => hasError(compileRequest));
  const compileError = computed(() =>
    hasError(compileRequest) ? compileRequest.errorMessage : undefined
  );
  const isReady = computed(() =>
    !isPending(compileRequest) && !hasError(compileRequest)
  );

  return {
    [NAME]: "Write and Run",
    [UI]: (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "16px",
        }}
      >
        <h2>Write and Run</h2>
        <p style={{ color: "#666" }}>
          Describe a pattern and I'll generate, compile, and run it.
        </p>

        <cf-message-input
          placeholder="Describe the pattern you want..."
          oncf-send={updatePrompt({ prompt })}
        />

        <div
          style={{
            padding: "12px",
            backgroundColor: "#f5f5f5",
            borderRadius: "8px",
          }}
        >
          {ifElse(
            isGenerating,
            <span>Generating code...</span>,
            ifElse(
              isCompiling,
              <span>Compiling pattern...</span>,
              ifElse(
                compileFailed,
                <div style={{ color: "red" }}>
                  <b>Compile error:</b> {compileError}
                </div>,
                ifElse(
                  isReady,
                  <cf-button onClick={visit({ result: compiledPiece })}>
                    Open Generated Pattern
                  </cf-button>,
                  <span style={{ opacity: 0.6 }}>
                    Enter a prompt to generate a pattern
                  </span>,
                ),
              ),
            ),
          )}
        </div>

        {ifElse(
          isReady,
          <div>
            <h3>Generated Pattern</h3>
            <div
              style={{
                border: "1px solid #ccc",
                borderRadius: "8px",
                padding: "16px",
                backgroundColor: "#fff",
              }}
            >
              {compiledPiece}
            </div>
          </div>,
          <span />,
        )}

        {ifElse(
          hasCode,
          <div>
            <h3>Generated Code</h3>
            <cf-code-editor
              value={generated}
              language="text/x.typescript"
              readonly
            />
          </div>,
          <span />,
        )}
      </div>
    ),
    prompt,
    generatedCode: generated,
    compiledPiece,
    error: compileError,
  };
});
