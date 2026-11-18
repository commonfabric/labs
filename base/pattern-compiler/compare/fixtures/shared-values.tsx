/// <cts-enable />
import { pattern } from "commonfabric";

// A chain of values, each of which reads the two before it: the last
// value depends on the first by 75,025 ways.
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
  const v11 = v10 + v9;
  const v12 = v11 + v10;
  const v13 = v12 + v11;
  const v14 = v13 + v12;
  const v15 = v14 + v13;
  const v16 = v15 + v14;
  const v17 = v16 + v15;
  const v18 = v17 + v16;
  const v19 = v18 + v17;
  const v20 = v19 + v18;
  const v21 = v20 + v19;
  const v22 = v21 + v20;
  const v23 = v22 + v21;
  const v24 = v23 + v22;
  return { v24 };
});
