// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * Test pattern to validate generateObject error handling snippet for LLM.md
 *
 * This pattern tests the correct way to handle pending/error/result states
 * with generateObject. The corrected doc example should look like this:
 *
 * {ifElse(isPending(ideaRequest),
 *   <span>Generating...</span>,
 *   ifElse(hasError(ideaRequest),
 *     <span>Error: {ideaRequest.errorMessage}</span>,
 *     <div>
 *       <h3>{idea.name}</h3>
 *       <p>{idea.description}</p>
 *       <p>${idea.price}</p>
 *     </div>
 *   )
 * )}
 *
 * `resultOf()` provides the success-only value while the guards expose the
 * pending and error variants.
 */
import {
  Default,
  generateObject,
  hasError,
  ifElse,
  isPending,
  NAME,
  pattern,
  resultOf,
  UI,
} from "commonfabric";

interface ProductIdea {
  name: string;
  description: string;
  price: number;
}

export interface Input {
  userInput: string | Default<"a self-watering plant pot">;
}

export default pattern<Input, Input>(({ userInput }) => {
  const ideaRequest = generateObject<ProductIdea>({
    prompt: userInput,
    system:
      "Generate a creative product idea based on the user's input. Be concise.",
  });
  const idea = resultOf(ideaRequest);

  // Error message as string for display
  const errorMessage = hasError(ideaRequest) ? ideaRequest.errorMessage : null;

  return {
    [NAME]: "GenerateObject Error Handling Test",
    [UI]: (
      <div style={{ padding: "1rem", fontFamily: "sans-serif" }}>
        <h2>generateObject Error Handling Test</h2>
        <p>
          This pattern validates the correct error handling snippet for LLM.md
        </p>

        <div style={{ marginBottom: "1rem" }}>
          <label>Product idea prompt:</label>
          <cf-input $value={userInput} placeholder="Enter a product idea..." />
        </div>

        <h3>Result (with proper error handling):</h3>
        <div
          style={{
            padding: "1rem",
            background: "#f5f5f5",
            borderRadius: "8px",
          }}
        >
          {/* Nested ifElse exercises explicit pending/error handling. */}
          {ifElse(
            isPending(ideaRequest),
            <span>
              <cf-loader size="sm" /> Generating...
            </span>,
            ifElse(
              hasError(ideaRequest),
              <span style={{ color: "red" }}>Error: {errorMessage}</span>,
              <div>
                <h3 style={{ marginTop: 0 }}>{idea.name}</h3>
                <p>{idea.description}</p>
                <p>
                  <strong>Price:</strong> ${idea.price}
                </p>
              </div>,
            ),
          )}
        </div>

        <div style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#666" }}>
          <strong>Debug info:</strong>
          <ul>
            <li>pending: {String(isPending(ideaRequest))}</li>
            <li>error: {errorMessage}</li>
            <li>result: {idea ? "present" : "null"}</li>
          </ul>
        </div>
      </div>
    ),
    userInput,
  };
});
