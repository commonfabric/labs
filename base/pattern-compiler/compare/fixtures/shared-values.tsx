/// <cts-enable />
import { pattern } from "commonfabric";

// A chain of values, each of which reads the two before it: the last
// value depends on the first by 55 ways.
export default pattern<{ seed: number }>(({ seed }) => {
  const v0 = seed + 1;
  const v1 = seed + 2;
  const v2 = v1 + v0;
  const v3 = v2 + v1;
  const v4 = v3 + v2;
  const v5 = v4 + v3;
  const v6 = v5 + v4;
  const v7 = v6 + v5;
  const v8 = v7 + v6;
  const v9 = v8 + v7;
  const v10 = v9 + v8;
  return { v10 };
});
