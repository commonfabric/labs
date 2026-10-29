import { findJsonUnfaithfulValues } from "@commonfabric/pure-json";

/**
 * Throw if `value` holds anything ordinary JSON serialization would not carry
 * faithfully. `label` names what is being checked (e.g. `The generateObject
 * schema`), and the message lists each offending value by JSON Pointer and
 * reason, so the author can see what to change rather than discovering a
 * mangled value downstream in the provider's behavior.
 *
 * This guards the one lossy step between the runner and an external LLM
 * provider: the request is sent as ordinary JSON (`JSON.stringify`), so any
 * value it carries that plain JSON cannot represent faithfully reaches the
 * provider altered, dropped, or not at all -- or crashes the serialization.
 * The `FabricValue` model is a superset of JSON, so a generated schema
 * (a `generateObject` schema, or a tool's `inputSchema`) may legitimately hold
 * values JSON cannot carry. Those are fine internally. Crossing to a provider,
 * they are not. The generic detection of JSON-unfaithful values lives in
 * `@commonfabric/pure-json`; what is added here is only the provider-framed
 * assertion that refuses such a value at the transport boundary.
 *
 * A minor diagnostic point: the thrown message renders the root pointer as
 * `/`. Under RFC 6901 the root is `""` and `/` names a property whose key is
 * the empty string; the message trades that strict accuracy for legibility.
 */
export function assertJsonTransportSafe(value: unknown, label: string): void {
  const problems = findJsonUnfaithfulValues(value);
  if (problems.length === 0) return;

  const lines = problems.map(({ pointer, reason }) =>
    `  ${pointer || "/"}: ${reason}`
  );
  throw new Error(
    `${label} holds ${problems.length} value(s) that ordinary JSON ` +
      `serialization would not carry faithfully:\n${lines.join("\n")}\n` +
      `These are valid \`FabricValue\`s, but the request reaches the ` +
      `provider as ordinary JSON. Remove or replace the value(s) above.`,
  );
}
