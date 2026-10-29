import { encode } from "@commonfabric/utils/encoding";
import { isObjectOrArray } from "@commonfabric/utils/types";

function stringify(value: unknown): string {
  switch (typeof value) {
    case "object": {
      if (!value) return "null";
      if (
        value instanceof ArrayBuffer ||
        ("buffer" in value && value.buffer instanceof ArrayBuffer)
      ) {
        // All commands operate over text rather than binary
        throw new Error("Binary data could not be stringified");
      }
      try {
        return JSON.stringify(value, null, 2);
        // deno-lint-ignore no-empty
      } catch (_) {}
      return value.toString();
    }
    case "function":
      throw new Error("Function could not be stringified");
    case "symbol":
      return value.toString();
    case "undefined":
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    default:
      return `${value}`;
  }
}

export function render(value: unknown, { json }: { json?: boolean } = {}) {
  if (json) {
    // For JSON mode, output raw JSON without additional formatting
    const jsonValue = `${safeStringify(value)}\n`;
    Deno.stdout.writeSync(encode(jsonValue));
    return;
  }
  // Append a `\n` to the stdout for TTY legibility and
  // unix file compatibility.
  const stringValue = `${stringify(value)}\n`;
  Deno.stdout.writeSync(encode(stringValue));
}

// Helper function to safely stringify objects with circular references
export function safeStringify(obj: unknown, maxDepth = 8): string {
  const ancestors: object[] = [];
  const seen = new WeakSet<object>();

  // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
  // `.get()`-path today, but will in the not-too-distant future. Neither type
  // has a JSON representation yet, so `JSON.stringify` renders its private
  // state as an empty object. Add an explicit representation when schemas
  // begin admitting them here.
  const replacer = function (this: unknown, _key: string, value: unknown) {
    while (
      ancestors.length > 0 && ancestors[ancestors.length - 1] !== this
    ) {
      ancestors.pop();
    }

    if (ancestors.length > maxDepth) {
      return "<max depth reached>";
    }

    if (typeof value === "bigint") {
      return { $bigint: value.toString() };
    }

    if (isObjectOrArray(value)) {
      if (seen.has(value)) {
        return "<circular reference>";
      }
      seen.add(value);
      ancestors.push(value);
    }

    return value;
  };

  try {
    return JSON.stringify(obj, replacer, 2) ?? "null";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not serialize JSON output: ${message}`);
  }
}
