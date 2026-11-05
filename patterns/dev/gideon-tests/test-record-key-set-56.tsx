// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: Superstition #56 - Record .key().set() in handlers
 *
 * Claim: .key(key).set(value) on Record<string, T> may fail when:
 * 1. Creating NEW keys (vs updating existing)
 * 2. On an initially empty Record
 * 3. With keys containing hyphens (interpreted as path separators?)
 *
 * Error observed: "Value at path value/argument/corrections/0-Technical_Expertise is not an object"
 */
import {
  Cell,
  Default,
  handler,
  NAME,
  pattern,
  toCompactDebugString,
  UI,
} from "commonfabric";

interface Item {
  value: string;
  count: number;
}

interface Input {
  // Empty record to test creating new keys
  emptyRecord: Record<string, Item> | Default<Record<PropertyKey, never>>;
  // Pre-populated record to test updating existing keys
  populatedRecord:
    | Record<string, Item>
    | Default<{ existing: { value: "preset"; count: 0 } }>;
  logs: string[] | Default<[]>;
}

// ============================================================
// TEST A: .key().set() on EMPTY record with SIMPLE key
// ============================================================
const testEmptySimpleKey = handler<
  unknown,
  { record: Cell<Record<string, Item>>; logs: Cell<string[]> }
>(
  (_, { record, logs }) => {
    try {
      const key = "simplekey";
      record.key(key).set({ value: "test-a", count: 1 });
      const msg = `A: SUCCESS - .key("${key}").set() on empty record`;
      console.log(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    } catch (e) {
      const msg = `A: FAILED - ${e}`;
      console.error(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    }
  },
);

// ============================================================
// TEST B: .key().set() on EMPTY record with HYPHENATED key
// ============================================================
const testEmptyHyphenKey = handler<
  unknown,
  { record: Cell<Record<string, Item>>; logs: Cell<string[]> }
>(
  (_, { record, logs }) => {
    try {
      const key = "0-Technical_Expertise"; // The exact key from the superstition
      record.key(key).set({ value: "test-b", count: 2 });
      const msg = `B: SUCCESS - .key("${key}").set() on empty record`;
      console.log(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    } catch (e) {
      const msg = `B: FAILED - ${e}`;
      console.error(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    }
  },
);

// ============================================================
// TEST C: .key().set() on POPULATED record (update existing)
// ============================================================
const testPopulatedUpdate = handler<
  unknown,
  { record: Cell<Record<string, Item>>; logs: Cell<string[]> }
>(
  (_, { record, logs }) => {
    try {
      const key = "existing"; // This key already exists
      record.key(key).set({ value: "updated", count: 99 });
      const msg = `C: SUCCESS - .key("${key}").set() update existing key`;
      console.log(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    } catch (e) {
      const msg = `C: FAILED - ${e}`;
      console.error(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    }
  },
);

// ============================================================
// TEST D: .key().set() on POPULATED record (create new)
// ============================================================
const testPopulatedNew = handler<
  unknown,
  { record: Cell<Record<string, Item>>; logs: Cell<string[]> }
>(
  (_, { record, logs }) => {
    try {
      const key = "new-hyphen-key"; // New key with hyphen
      record.key(key).set({ value: "test-d", count: 4 });
      const msg =
        `D: SUCCESS - .key("${key}").set() new key on populated record`;
      console.log(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    } catch (e) {
      const msg = `D: FAILED - ${e}`;
      console.error(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    }
  },
);

// ============================================================
// TEST E: Spread workaround (should always work)
// ============================================================
const testSpreadWorkaround = handler<
  unknown,
  { record: Cell<Record<string, Item>>; logs: Cell<string[]> }
>(
  (_, { record, logs }) => {
    try {
      const key = "spread-key";
      const current = record.get() ?? {};
      record.set({ ...current, [key]: { value: "test-e", count: 5 } });
      const msg = `E: SUCCESS - spread workaround with key "${key}"`;
      console.log(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    } catch (e) {
      const msg = `E: FAILED - ${e}`;
      console.error(`[#56] ${msg}`);
      logs.set([...logs.get(), msg]);
    }
  },
);

// Clear logs handler
const clearLogs = handler<unknown, { logs: Cell<string[]> }>(
  (_, { logs }) => {
    logs.set([]);
  },
);

export default pattern<Input>(({ emptyRecord, populatedRecord, logs }) => {
  return {
    [NAME]: "TEST: Record .key().set() #56",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "700px" }}>
        <h2>Record .key().set() Test (#56)</h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          Testing if .key(k).set(v) fails on empty Records or with hyphenated
          keys
        </p>

        {/* Current state display */}
        <div
          style={{
            background: "#f0f0f0",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <strong>Current State:</strong>
          <div style={{ fontSize: "0.8rem", fontFamily: "monospace" }}>
            <div>emptyRecord: {toCompactDebugString(emptyRecord)}</div>
            <div>populatedRecord: {toCompactDebugString(populatedRecord)}</div>
          </div>
        </div>

        {/* Test buttons */}
        <div
          style={{
            border: "2px solid blue",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "blue" }}>Tests on Empty Record</h3>

          <div style={{ marginBottom: "0.5rem" }}>
            <cf-button
              onClick={testEmptySimpleKey({ record: emptyRecord, logs })}
            >
              A: Simple key on empty
            </cf-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <cf-button
              onClick={testEmptyHyphenKey({ record: emptyRecord, logs })}
            >
              B: Hyphen key on empty (the problematic case)
            </cf-button>
          </div>
        </div>

        <div
          style={{
            border: "2px solid green",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "green" }}>Tests on Populated Record</h3>

          <div style={{ marginBottom: "0.5rem" }}>
            <cf-button
              onClick={testPopulatedUpdate({ record: populatedRecord, logs })}
            >
              C: Update existing key
            </cf-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <cf-button
              onClick={testPopulatedNew({ record: populatedRecord, logs })}
            >
              D: New hyphen key on populated
            </cf-button>
          </div>
        </div>

        <div
          style={{
            border: "2px solid purple",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "purple" }}>Workaround</h3>

          <div style={{ marginBottom: "0.5rem" }}>
            <cf-button
              onClick={testSpreadWorkaround({ record: emptyRecord, logs })}
            >
              E: Spread workaround on empty
            </cf-button>
          </div>
        </div>

        {/* Logs */}
        <div
          style={{
            border: "2px solid #333",
            padding: "1rem",
            borderRadius: "8px",
            background: "#f9f9f9",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h3>Test Results</h3>
            <cf-button onClick={clearLogs({ logs })}>Clear</cf-button>
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
            }}
          >
            {logs.map((log) => (
              <div
                style={{
                  color: log.includes("SUCCESS")
                    ? "green"
                    : log.includes("FAILED")
                    ? "red"
                    : "#333",
                  marginBottom: "0.25rem",
                }}
              >
                {log}
              </div>
            ))}
          </div>
        </div>

        {/* Expected results */}
        <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#666" }}>
          <strong>Superstition claims:</strong>
          <ul>
            <li>A & B should FAIL (empty record)</li>
            <li>B especially should FAIL (hyphenated key)</li>
            <li>C should PASS (update existing)</li>
            <li>D might PASS (populated record)</li>
            <li>E should always PASS (workaround)</li>
          </ul>
        </div>
      </div>
    ),
    emptyRecord,
    populatedRecord,
    logs,
  };
});
