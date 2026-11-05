/**
 * Measures string-tuple encoding and Map lookup over 256 distinct identities.
 * Tuple width and field contents are the axes: document identities have two
 * fields, cache slots three, and consumed CFC sources five. The lookup includes
 * string hashing and flattening. Fixture construction and checks stay untimed.
 */

import { stringTupleKey } from "../src/string-tuple-key.ts";

const id = "of:baedreibf6x6imr3pdfln2fmp4iqdlscyr3zq3szk3t3hfxtafgl6hn5vq4";
const space = "did:key:z6MksfGfeHSx2McRjDUCJjMtbn22VDpsBNCRLHqRwsRyHnz4";
const fixtures: [string, (index: number) => string[]][] = [
  ["document", (index) => [space, `${id}-${index}`]],
  ["cache slot", (index) => [space, "runtime-version", `${id}-${index}`]],
  [
    "source",
    (index) => [id, space, "space", `/rows/${index}/profile/name`, ""],
  ],
  ["escaped", (index) => [id, space, "space", `/rows/${index}/~\"\\\0`, ""]],
  ["unicode", (index) => [id, space, "space", `/rows/${index}/名字😀`, ""]],
];

for (const [name, fixture] of fixtures) {
  const tuples = Array.from({ length: 256 }, (_, index) => fixture(index));
  const values = new Map(
    tuples.map((parts, index) => [stringTupleKey(parts), index + 1]),
  );
  if (values.size !== tuples.length) throw new Error("Tuple fixture collision");
  Deno.bench({
    name,
    group: "string tuple key + Map lookup (256 keys)",
    fn(b) {
      let checksum = 0;
      b.start();
      for (const parts of tuples) {
        checksum += values.get(stringTupleKey(parts))!;
      }
      b.end();
      if (checksum !== 32896) throw new Error("Unexpected tuple lookup result");
    },
  });
}
