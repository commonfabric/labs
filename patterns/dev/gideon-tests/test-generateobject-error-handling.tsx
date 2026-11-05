// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Test pattern to validate generateObject error handling snippet for LLM.md
 *
 * This pattern tests the correct way to handle pending/error/result states
 * with generateObject. The corrected doc example should look like this:
 *
 * {ifElse(idea.pending,
 *   <span>Generating...</span>,
 *   ifElse(idea.error,
 *     <span>Error: {idea.error}</span>,
 *     <div>
 *       <h3>{idea.result?.name}</h3>
 *       <p>{idea.result?.description}</p>
 *       <p>${idea.result?.price}</p>
 *     </div>
 *   )
 * )}
 *
 * Note: Use optional chaining (?.) because TypeScript doesn't narrow through ifElse.
 * At runtime, if we reach the inner else branch, result IS defined (pending=false, error=false).
 */
import {
  Default,
  generateObject,
  ifElse,
  NAME,
  pattern,
  toIndentedDebugString,
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
  const idea = generateObject<ProductIdea>({
    prompt: userInput,
    system:
      "Generate a creative product idea based on the user's input. Be concise.",
  });

  // Error message as string for display
  const errorMessage = idea.error
    ? (typeof idea.error === "string"
      ? idea.error
      : toIndentedDebugString(idea.error))
    : null;

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
          {/* This is the CORRECT pattern - nested ifElse for error handling */}
          {/* Note: Use optional chaining (?.property) since TypeScript doesn't narrow through ifElse */}
          {ifElse(
            idea.pending,
            <span>
              <cf-loader size="sm" /> Generating...
            </span>,
            ifElse(
              idea.error,
              <span style={{ color: "red" }}>Error: {errorMessage}</span>,
              <div>
                <h3 style={{ marginTop: 0 }}>{idea.result?.name}</h3>
                <p>{idea.result?.description}</p>
                <p>
                  <strong>Price:</strong> ${idea.result?.price}
                </p>
              </div>,
            ),
          )}
        </div>

        <div style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#666" }}>
          <strong>Debug info:</strong>
          <ul>
            <li>pending: {String(idea.pending)}</li>
            <li>error: {errorMessage}</li>
            <li>result: {idea.result ? "present" : "null"}</li>
          </ul>
        </div>
      </div>
    ),
    userInput,
  };
});
