// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Test Pattern for Superstition #33
 *
 * Tests whether computed() creates read-only projections vs property access maintaining writability.
 *
 * Claim:
 * - computed(() => obj.property) creates a read-only projection (writes are ineffective)
 * - obj.property maintains live Cell reference (writes work)
 *
 * This pattern creates a "source" object with an auth-like structure, then tests
 * updating it via both approaches.
 */
import {
  Cell,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  toIndentedDebugString,
  UI,
} from "commonfabric";

interface AuthData {
  token: string;
  expiresAt: number;
  refreshCount: number;
}

interface Source {
  auth: AuthData;
  name: string;
}

// Schema definition for default value
interface InputSchema {
  source:
    | Source
    | Default<{
      auth: { token: "initial-token"; expiresAt: 0; refreshCount: 0 };
      name: "Test Source";
    }>;
}

// Pattern output type - describes the inner value, not the cell wrapper
// The pattern returns OpaqueCell<Source>, so output type is `Source`
export interface Output {
  source: Source;
}

// Handler to update via computed projection
const updateViaComputed = handler<
  unknown,
  { computedAuth: Cell<AuthData> }
>((_, { computedAuth }) => {
  // Try to update the token via the computed projection
  const current = computedAuth.get();
  computedAuth.set({
    ...current,
    token: "updated-via-computed-" + Date.now(),
    refreshCount: current.refreshCount + 1,
  });
});

// Handler to update via .key() property access
const updateViaKey = handler<
  unknown,
  { authViaKey: Cell<AuthData> }
>((_, { authViaKey }) => {
  // Try to update the token via .key() access
  const current = authViaKey.get();
  authViaKey.set({
    ...current,
    token: "updated-via-key-" + Date.now(),
    refreshCount: current.refreshCount + 1,
  });
});

// Handler to update source directly (control)
const updateDirect = handler<
  unknown,
  { source: Cell<Source> }
>((_, { source }) => {
  const current = source.get() ||
    { auth: { token: "", expiresAt: 0, refreshCount: 0 }, name: "" };
  source.set({
    ...current,
    auth: {
      ...current.auth,
      token: "updated-direct-" + Date.now(),
      refreshCount: current.auth.refreshCount + 1,
    },
  });
});

export default pattern<InputSchema, Output>(({ source }) => {
  // Approach 1: computed() projection - claims to be read-only
  // Inside computed(), use direct property access (not .get())
  const computedAuth = computed(() => source.auth);

  // Approach 2: .key() method - claims to maintain writability
  // Note: .key() returns OpaqueCell which is used in handlers for writes
  const authViaKey = (source as any).key("auth");

  // For display - all use direct property access on source
  // (both computedAuth and source.auth should show the same values)
  const computedToken = computed(() => computedAuth.token);
  const directToken = computed(() => source.auth.token);

  const computedRefreshCount = computed(() => computedAuth.refreshCount);
  const directRefreshCount = computed(() => source.auth.refreshCount);

  return {
    [NAME]: "Test #33: Computed Projection vs Property Access",
    [UI]: (
      <div
        style={{ fontFamily: "system-ui", padding: "20px", maxWidth: "800px" }}
      >
        <h2>Superstition #33 Test: Computed Projection Writability</h2>

        <div
          style={{
            backgroundColor: "#f0f0f0",
            padding: "15px",
            borderRadius: "8px",
            marginBottom: "20px",
          }}
        >
          <h3>Claim Being Tested:</h3>
          <ul>
            <li>
              <code>computed(() =&gt; obj.property)</code> creates a{" "}
              <strong>read-only projection</strong>{" "}
              - writes do not update the source
            </li>
            <li>
              <code>obj.key("property")</code> maintains{" "}
              <strong>live Cell reference</strong> - writes work
            </li>
          </ul>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {/* Computed Projection */}
          <div
            style={{
              border: "2px solid #e74c3c",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#e74c3c" }}>1. Computed Projection</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              computed(() =&gt; source.get().auth)
            </code>
            <div style={{ marginBottom: "10px" }}>
              <strong>Token:</strong>
              <br />
              <span style={{ fontSize: "12px", wordBreak: "break-all" }}>
                {computedToken}
              </span>
            </div>
            <div style={{ marginBottom: "10px" }}>
              <strong>Refresh Count:</strong> {computedRefreshCount}
            </div>
            <cf-button onClick={updateViaComputed({ computedAuth })}>
              Update via Computed
            </cf-button>
          </div>

          {/* .key() Access */}
          <div
            style={{
              border: "2px solid #27ae60",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#27ae60" }}>2. .key() Access</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              source.key("auth")
            </code>
            <div style={{ marginBottom: "10px" }}>
              <strong>Token:</strong>
              <br />
              <span style={{ fontSize: "12px", wordBreak: "break-all" }}>
                {directToken}
              </span>
            </div>
            <div style={{ marginBottom: "10px" }}>
              <strong>Refresh Count:</strong> {directRefreshCount}
            </div>
            <cf-button onClick={updateViaKey({ authViaKey })}>
              Update via .key()
            </cf-button>
          </div>

          {/* Direct Source (Control) */}
          <div
            style={{
              border: "2px solid #3498db",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#3498db" }}>3. Direct Source (Control)</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              source.set(...)
            </code>
            <div style={{ marginBottom: "10px" }}>
              <strong>Token:</strong>
              <br />
              <span style={{ fontSize: "12px", wordBreak: "break-all" }}>
                {directToken}
              </span>
            </div>
            <div style={{ marginBottom: "10px" }}>
              <strong>Refresh Count:</strong> {directRefreshCount}
            </div>
            <cf-button onClick={updateDirect({ source })}>
              Update Direct
            </cf-button>
          </div>
        </div>

        <div
          style={{
            backgroundColor: "#fff3cd",
            padding: "15px",
            borderRadius: "8px",
            border: "1px solid #ffc107",
          }}
        >
          <h3>Expected Behavior (if superstition is TRUE):</h3>
          <ul>
            <li>
              <strong style={{ color: "#e74c3c" }}>Computed:</strong>{" "}
              Click should NOT update token
            </li>
            <li>
              <strong style={{ color: "#27ae60" }}>.key():</strong>{" "}
              Click SHOULD update token
            </li>
            <li>
              <strong style={{ color: "#3498db" }}>Direct:</strong>{" "}
              Click SHOULD update token (control)
            </li>
          </ul>
          <p>
            <strong>Test:</strong>{" "}
            Click each button, then reload the page. Check if changes persisted.
          </p>
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "15px",
            backgroundColor: "#f8f9fa",
            borderRadius: "8px",
          }}
        >
          <h3>Raw Source State:</h3>
          <pre style={{ fontSize: "12px", overflow: "auto" }}>
            {computed(() => toIndentedDebugString({ auth: source.auth, name: source.name }))}
          </pre>
        </div>
      </div>
    ),
    source,
  };
});
