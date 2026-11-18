import { encode } from "@commonfabric/text/utf8";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectOrArray } from "@commonfabric/js-values/types";

/**
 * Writes `value` to stdout followed by a newline, for TTY legibility and unix
 * file compatibility: a string as it is unless `json` asks for JSON, and any
 * other value as JSON.
 */
export function render(value: unknown, { json }: { json?: boolean } = {}) {
  const text = typeof value === "string" && !json
    ? value
    : safeStringify(value);
  Deno.stdout.writeSync(encode(`${text}\n`));
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
    const message = describeFailure(error);
    throw new Error(`Could not serialize JSON output: ${message}`);
  }
}
