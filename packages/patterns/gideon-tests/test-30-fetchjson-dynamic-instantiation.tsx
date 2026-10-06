// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * Test Pattern for Superstition #30
 *
 * Tests whether fetchJson() can be dynamically instantiated inside .map()
 *
 * Claim:
 * - fetchJson() calls cannot be created dynamically inside .map() or reactive callbacks
 * - Framework requires fetchJson to be statically defined at pattern evaluation time
 * - Dynamic instantiation causes "Frame mismatch" errors or undefined results
 *
 * This pattern tests:
 * 1. Static fetchJson at top level (control - should work)
 * 2. fetchJson inside .map() with expression callback (claimed to fail)
 */
import {
  computed,
  Default,
  fetchJson,
  hasError,
  isPending,
  NAME,
  pattern,
  resultOf,
  UI,
} from "commonfabric";

interface Repo {
  id: string;
  name: string;
}

interface GitHubRepoStats {
  stargazers_count?: number;
}

interface InputSchema {
  repos:
    | Repo[]
    | Default<[
      { id: "1"; name: "react" },
      { id: "2"; name: "vue" },
      { id: "3"; name: "angular" },
    ]>;
}

export interface Input {
  repos: Repo[];
}

export default pattern<InputSchema, Input>(({ repos }) => {
  // Approach 1: Static fetchJson at top level (control - should work)
  // Uses computed URL that changes based on first repo
  const staticUrl = computed(() =>
    repos[0] ? `https://api.github.com/repos/facebook/${repos[0].name}` : ""
  );
  const staticFetch = fetchJson<{ stargazers_count?: number }>({
    url: staticUrl,
  });
  const staticValue = resultOf(staticFetch);

  // Approach 2: fetchJson inside .map() - expression callback (no block syntax)
  // This is claimed to fail with frame mismatch or return undefined
  const dynamicFetches = repos.map((repo) =>
    fetchJson<{ stargazers_count?: number }>({
      url: computed(() => `https://api.github.com/repos/facebook/${repo.name}`),
    })
  );

  // Display results
  const staticResult = computed(() =>
    isPending(staticFetch)
      ? "Loading..."
      : hasError(staticFetch)
      ? `Error: ${staticFetch.errorMessage}`
      : `Stars: ${staticValue.stargazers_count ?? "N/A"}`
  );

  return {
    [NAME]: "Test #30: fetchJson Dynamic Instantiation",
    [UI]: (
      <div
        style={{ fontFamily: "system-ui", padding: "20px", maxWidth: "800px" }}
      >
        <h2>Superstition #30 Test: fetchJson Dynamic Instantiation</h2>

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
              <code>fetchJson()</code> cannot be created inside{" "}
              <code>.map()</code>
            </li>
            <li>
              Framework requires static allocation at pattern body top level
            </li>
            <li>
              Dynamic instantiation causes frame mismatch or undefined results
            </li>
          </ul>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {/* Static fetchJson (Control) */}
          <div
            style={{
              border: "2px solid #27ae60",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#27ae60" }}>1. Static fetchJson (Control)</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              fetchJson at top level with computed URL
            </code>
            <div style={{ marginBottom: "10px" }}>
              <strong>URL:</strong> {staticUrl}
            </div>
            <div style={{ marginBottom: "10px" }}>
              <strong>Result:</strong> {staticResult}
            </div>
            <div style={{ fontSize: "12px", color: "#666" }}>
              <strong>Pending:</strong>{" "}
              {computed(() => String(isPending(staticFetch)))}
            </div>
          </div>

          {/* Dynamic fetchJson */}
          <div
            style={{
              border: "2px solid #e74c3c",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3 style={{ color: "#e74c3c" }}>2. Dynamic fetchJson (Test)</h3>
            <code
              style={{
                fontSize: "11px",
                display: "block",
                marginBottom: "10px",
              }}
            >
              fetchJson inside .map() callback
            </code>
            <div>
              {dynamicFetches.map((request, index) => {
                const result = resultOf(request);
                return (
                  <div
                    key={index}
                    style={{
                      marginBottom: "10px",
                      padding: "8px",
                      backgroundColor: "#f9f9f9",
                      borderRadius: "4px",
                    }}
                  >
                    <strong>Repo {index + 1}:</strong>
                    <div style={{ fontSize: "12px" }}>
                      Pending: {computed(() => String(isPending(request)))}
                      {" | "}
                      Error:{" "}
                      {computed(() =>
                        hasError(request) ? request.errorMessage : "none"
                      )}
                      {" | "}
                      Result:{" "}
                      {computed(() =>
                        `Stars: ${result.stargazers_count ?? "N/A"}`
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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
              <strong style={{ color: "#27ae60" }}>Static:</strong>{" "}
              Should work - shows star count
            </li>
            <li>
              <strong style={{ color: "#e74c3c" }}>Dynamic:</strong>{" "}
              Should FAIL - undefined, error, or frame mismatch
            </li>
          </ul>
          <p>
            <strong>If superstition is FALSE:</strong>{" "}
            Both should show star counts.
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
          <h3>Test Repos:</h3>
          <ul>
            {repos.map((repo, index) => (
              <li key={index}>{repo.name} (id: {repo.id})</li>
            ))}
          </ul>
        </div>
      </div>
    ),
    repos,
  };
});
