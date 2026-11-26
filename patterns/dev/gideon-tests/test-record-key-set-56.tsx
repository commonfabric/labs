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
 * Error once reported: "Value at path
 * value/argument/corrections/0-Technical_Expertise is not an object"
 *
 * The claim is false: every case below writes its entry, and a hyphenated
 * key is stored whole as one entry. test-record-key-set-56.test.tsx asserts
 * this.
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

// Writes `item` under `key` with `.key(key).set()`, which works on an empty
// or populated record, for a new or existing key, hyphenated or not.
const setKey = handler<
  unknown,
  {
    record: Cell<Record<string, Item>>;
    logs: Cell<string[]>;
    key: string;
    item: Item;
    label: string;
  }
>((_, { record, logs, key, item, label }) => {
  record.key(key).set(item);
  logs.push(`${label}: SUCCESS - .key("${key}").set() wrote "${item.value}"`);
});

// Writes the same kind of entry by spreading the current record.
const spreadKey = handler<
  unknown,
  { record: Cell<Record<string, Item>>; logs: Cell<string[]> }
>((_, { record, logs }) => {
  const key = "spread-key";
  record.set({ ...record.get(), [key]: { value: "test-e", count: 5 } });
  logs.push(`E: SUCCESS - spread workaround with key "${key}"`);
});

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
              onClick={setKey({
                record: emptyRecord,
                logs,
                key: "simplekey",
                item: { value: "test-a", count: 1 },
                label: "A",
              })}
            >
              A: Simple key on empty
            </cf-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <cf-button
              onClick={setKey({
                record: emptyRecord,
                logs,
                key: "0-Technical_Expertise",
                item: { value: "test-b", count: 2 },
                label: "B",
              })}
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
              onClick={setKey({
                record: populatedRecord,
                logs,
                key: "existing",
                item: { value: "updated", count: 99 },
                label: "C",
              })}
            >
              C: Update existing key
            </cf-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <cf-button
              onClick={setKey({
                record: populatedRecord,
                logs,
                key: "new-hyphen-key",
                item: { value: "test-d", count: 4 },
                label: "D",
              })}
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
              onClick={spreadKey({ record: emptyRecord, logs })}
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
              <div style={{ color: "green", marginBottom: "0.25rem" }}>
                {log}
              </div>
            ))}
          </div>
        </div>

        {/* Observed results */}
        <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#666" }}>
          <strong>Superstition claims:</strong>
          <ul>
            <li>A & B fail (empty record)</li>
            <li>B especially fails (hyphenated key)</li>
          </ul>
          <strong>Observed:</strong>{" "}
          all five succeed, and a hyphenated key is stored whole as one entry.
        </div>
      </div>
    ),
    emptyRecord,
    populatedRecord,
    logs,
  };
});
