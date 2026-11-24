// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Test Pattern: Cross-Piece Stream Client
 *
 * CLAIMS:
 *
 * 1. Cross-Piece Stream Invocation via wish()
 *    - A stream on a wished piece is reached as a plain projection of the
 *      wish result, and a handler sends to it with .send().
 *
 * 2. <cf-render> renders the wished piece inside this one.
 *
 * PREREQUISITES:
 *    - Wish tags must be in JSDoc on Output type (not file-level comments)
 *    - wish({ query: "#tag" }) searches FAVORITES only - piece must be favorited first
 *
 * TESTING:
 *    1. Deploy server piece first, favorite it
 *    2. Deploy this client piece
 *    3. Toggle to Mode B (<cf-render> active)
 *    4. Click "Invoke Server Stream" - server counter should increment
 */
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  toIndentedDebugString,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

interface Input {
  // Toggle between Mode A (wish only) and Mode B (wish + <cf-render>)
  useCfRender: boolean | Default<false>;

  // Track last invocation result
  lastInvocationStatus: string | Default<"Not invoked yet">;

  // Track invocation count
  invocationCount: number | Default<0>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  useCfRender: boolean;
  lastInvocationStatus: string;
  invocationCount: number;
}

// The part of the server piece's output this client uses
interface ServerPiece {
  counter: number;
  invocationLog: string[];
  incrementCounter: Stream<void>;
}

// Handler that invokes a stream from the wished piece
const invokeServerStream = handler<
  unknown,
  {
    server: ServerPiece | undefined;
    lastInvocationStatus: Writable<string>;
    invocationCount: Writable<number>;
  }
>((_event, { server, lastInvocationStatus, invocationCount }) => {
  if (!server) {
    lastInvocationStatus.set(
      "Stream not found: no favorite is tagged #crossPieceTestServer",
    );
    return;
  }
  server.incrementCounter.send();
  const count = invocationCount.get() + 1;
  invocationCount.set(count);
  lastInvocationStatus.set(`Success! Invoked the server stream ${count} times`);
});

// Handler for toggling the render mode
const toggleMode = handler<unknown, { useCfRender: Writable<boolean> }>(
  (_event, { useCfRender }) => {
    useCfRender.set(!useCfRender.get());
  },
);

export default pattern<Input, Output>(
  ({ useCfRender, lastInvocationStatus, invocationCount }) => {
    // Wish for the server piece by tag
    const wishResult = wish<ServerPiece>({
      query: "#crossPieceTestServer",
    });

    // Access the result from the wish (WishState has a result property)
    const serverPiece = wishResult.result;

    return {
      [NAME]: "Cross-Piece Test Client",
      [UI]: (
        <div
          style={{
            padding: "16px",
            border: "2px solid #2196F3",
            borderRadius: "8px",
          }}
        >
          <h2>Cross-Piece Test Client</h2>

          {/* Mode Toggle Section */}
          <div
            style={{
              marginTop: "16px",
              padding: "12px",
              backgroundColor: "#E3F2FD",
              borderRadius: "4px",
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              Claim 2 Test: {"<cf-render>"} Forces Execution
            </h3>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span>Current Mode:</span>
              <strong style={{ color: useCfRender ? "#4CAF50" : "#FF9800" }}>
                {useCfRender
                  ? "Mode B: Wish + <cf-render>"
                  : "Mode A: Wish Only (no <cf-render>)"}
              </strong>
            </div>
            <cf-button
              onClick={toggleMode({ useCfRender })}
              style="margin-top: 8px;"
            >
              Toggle Mode
            </cf-button>
            <p style={{ fontSize: "12px", marginTop: "8px", marginBottom: 0 }}>
              In Mode A, server piece should NOT execute. In Mode B, it should
              execute.
            </p>
          </div>

          {/* Server Piece Rendering Section */}
          <div
            style={{
              marginTop: "16px",
              padding: "12px",
              backgroundColor: "#FFF3E0",
              borderRadius: "4px",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Server Piece Status</h3>
            {useCfRender
              ? (
                <div>
                  <p style={{ color: "#4CAF50", fontWeight: "bold" }}>
                    Mode B Active: Rendering server piece with {"<cf-render>"}
                  </p>
                  {/* Use <cf-render> to force execution, even when hidden. */}
                  <div
                    style={{
                      border: "1px dashed #999",
                      padding: "8px",
                      marginTop: "8px",
                    }}
                  >
                    <cf-render $cell={wishResult.result} />
                  </div>
                </div>
              )
              : (
                <p style={{ color: "#FF9800", fontWeight: "bold" }}>
                  Mode A Active: Server piece wished for but NOT rendered
                  (should not execute)
                </p>
              )}
          </div>

          {/* Stream Invocation Section */}
          <div
            style={{
              marginTop: "16px",
              padding: "12px",
              backgroundColor: "#F3E5F5",
              borderRadius: "4px",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Claim 1 Test: Stream Invocation</h3>
            <div style={{ marginBottom: "8px" }}>
              <strong>Last Invocation Status:</strong> {lastInvocationStatus}
            </div>
            <cf-button
              onClick={invokeServerStream({
                server: serverPiece,
                lastInvocationStatus,
                invocationCount,
              })}
              style="margin-top: 8px;"
            >
              Invoke Server Stream
            </cf-button>
            <p style={{ fontSize: "12px", marginTop: "8px", marginBottom: 0 }}>
              Click to invoke the incrementCounter stream from the server piece.
              Check the server piece to see if the counter incremented.
            </p>
          </div>

          {/* Debug Info */}
          <div
            style={{
              marginTop: "16px",
              padding: "8px",
              backgroundColor: "#f5f5f5",
              borderRadius: "4px",
            }}
          >
            <details>
              <summary style={{ cursor: "pointer", fontWeight: "bold" }}>
                Debug Info
              </summary>
              <pre style={{ fontSize: "10px", overflow: "auto" }}>
                {computed(() =>
                  toIndentedDebugString({
                    useCfRender,
                    invocationCount,
                    lastInvocationStatus,
                    serverFound: serverPiece !== undefined,
                  })
                )}
              </pre>
            </details>
          </div>
        </div>
      ),
      useCfRender,
      lastInvocationStatus,
      invocationCount,
    };
  },
);
