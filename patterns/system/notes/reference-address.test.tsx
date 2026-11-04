/** Exercises mention address rendering through the pattern runtime's API binding. */

import { assert, pattern, TESTS } from "commonfabric";
import { linkAddress } from "./reference-address.ts";

export default pattern(() => {
  const complete = assert(() =>
    linkAddress({
      id: "of:fid1:donut",
      space: "did:key:bakery",
      scope: "user",
      path: ["..", "", "a#argument", "a/b", "~"],
    }, undefined) ===
      "//did:key:bakery/of:fid1:donut@user/..//a#argument/a~1b/~0"
  );
  const local = assert(() =>
    linkAddress({
      id: "of:fid1:donut",
      space: "did:key:bakery",
      path: [""],
    }, "did:key:bakery") === "/of:fid1:donut/"
  );
  const crossSpace = assert(() =>
    linkAddress({
      id: "of:fid1:donut",
      space: "did:key:bakery",
      path: [".."],
    }, "did:key:other") === "//did:key:bakery/of:fid1:donut/.."
  );
  const incomplete = assert(() => linkAddress({}, undefined) === undefined);

  return {
    [TESTS]: [
      { assertion: complete },
      { assertion: local },
      { assertion: crossSpace },
      { assertion: incomplete },
    ],
  };
});
