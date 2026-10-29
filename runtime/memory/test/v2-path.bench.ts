/**
 * JSON Pointer encoding followed by lookup in a prebuilt logical-path Map.
 * Each batch encodes 256 distinct paths; path depth and segment length vary
 * independently of that count. The escaped arm exercises both RFC 6901
 * substitutions in every segment. These are synthetic path workloads, not
 * measurements of a deployed pane's path distribution.
 *
 * Lookup consumes the string as a key, including hashing or flattening that
 * an encoder may defer. Fixture construction and result checks are untimed.
 */

import { encodePointer } from "../v2/path.ts";

const PATH_COUNT = 256;

for (
  const { name, depth, segment } of [
    { name: "plain depth 1", depth: 1, segment: "subject" },
    { name: "plain depth 4", depth: 4, segment: "subject" },
    { name: "plain depth 12", depth: 12, segment: "subject" },
    { name: "long depth 4", depth: 4, segment: "subject".repeat(16) },
    { name: "escaped depth 4", depth: 4, segment: "subject~/" },
  ]
) {
  const paths = Array.from(
    { length: PATH_COUNT },
    (_, index) =>
      Array.from(
        { length: depth },
        (_, level) => `${segment}${level}-${index}`,
      ),
  );
  const expected = new Map(paths.map((path, index) => [
    "/" + path.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
      .join("/"),
    index + 1,
  ]));
  const expectedSum = PATH_COUNT * (PATH_COUNT + 1) / 2;

  Deno.bench({
    name,
    group: "encodePointer + Map lookup (256 paths)",
    fn(b) {
      let sum = 0;
      b.start();
      for (const path of paths) {
        sum += expected.get(encodePointer(path)) ?? 0;
      }
      b.end();
      if (sum !== expectedSum) throw new Error("Pointer lookup mismatch");
    },
  });
}
