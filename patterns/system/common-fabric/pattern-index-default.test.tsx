/**
 * Test Pattern: `listPatternIndex` with no favorite naming an index
 *
 * With no favorite tagged `#patternIndex`, the tool reads the server's own
 * pattern index, served here through `fetchMocks`. `common-fabric.test.tsx`
 * reads the index a favorite names. They are separate runs because each needs
 * the favorites as they are before the index is first read (that file says
 * why).
 */
import { assert, pattern, TESTS } from "commonfabric";
import { listPatternIndex } from "./common-fabric.tsx";

export const fetchMocks = [
  {
    urlIncludes: "/api/patterns/index.md",
    contentType: "text/markdown",
    body: "# Pattern index\n- counter",
  },
];

export default pattern(() => {
  const index = listPatternIndex({});
  return {
    [TESTS]: [
      {
        assertion: assert(() => index?.result === "# Pattern index\n- counter"),
      },
    ],
  };
});
