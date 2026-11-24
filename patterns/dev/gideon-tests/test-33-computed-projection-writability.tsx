// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Test Pattern for Superstition #33
 *
 * Tests whether computed() creates read-only projections vs property access
 * maintaining writability.
 *
 * Claim:
 * - computed(() => obj.property) creates a read-only projection (writes are
 *   ineffective)
 * - obj.property maintains live Cell reference (writes work)
 *
 * This pattern creates a "source" object with an auth-like structure, then
 * updates it via both approaches and directly.
 *
 * The claim is false: the result of computed(() => obj.property) links to
 * the property, so a write through it updates the source just as a write
 * through obj.property does. test-33-computed-projection-writability.test.tsx asserts
 * this.
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
  type VNode,
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

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  source: Source;
}

// Handler to update via computed projection
const updateViaComputed = handler<
  unknown,
  { computedAuth: Cell<AuthData> }
>((_, { computedAuth }) => {
  const current = computedAuth.get();
  computedAuth.set({
    ...current,
    token: "updated-via-computed-" + Date.now(),
    refreshCount: current.refreshCount + 1,
  });
});

// Handler to update via property access
const updateViaProperty = handler<
  unknown,
  { authViaProperty: Cell<AuthData> }
>((_, { authViaProperty }) => {
  const current = authViaProperty.get();
  authViaProperty.set({
    ...current,
    token: "updated-via-property-" + Date.now(),
    refreshCount: current.refreshCount + 1,
  });
});

// Handler to update source directly (control)
const updateDirect = handler<
  unknown,
  { source: Cell<Source> }
>((_, { source }) => {
  const current = source.get();
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
  // Approach 1: a computed() projection, claimed to be read-only
  const computedAuth = computed(() => source.auth);

  // Approach 2: property access, claimed to stay writable
  const authViaProperty = source.auth;

  // Both approaches name the same cell, so these show the same values
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
              <code>obj.property</code> maintains{" "}
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
              computed(() =&gt; source.auth)
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

          {/* Property Access */}
          <div
            style={{
              border: "2px solid #27ae60",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#27ae60" }}>2. Property Access</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              source.auth
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
            <cf-button onClick={updateViaProperty({ authViaProperty })}>
              Update via Property
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
          <h3>Observed Behavior (the superstition is FALSE):</h3>
          <ul>
            <li>
              <strong style={{ color: "#e74c3c" }}>Computed:</strong>{" "}
              Click updates the token
            </li>
            <li>
              <strong style={{ color: "#27ae60" }}>Property:</strong>{" "}
              Click updates the token
            </li>
            <li>
              <strong style={{ color: "#3498db" }}>Direct:</strong>{" "}
              Click updates the token (control)
            </li>
          </ul>
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
