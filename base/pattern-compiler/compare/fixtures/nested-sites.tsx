import { pattern, Writable } from "commonfabric";
const P0 = pattern<{ n: number }>(({ n }) => {
  const c = Writable.of(0);
  return { v: n + c.get() };
});
const P1 = pattern<{ n: number }>(({ n }) => {
  const a = P0({ n });
  const b = P0({ n: n + 1 });
  return { v: a.v + b.v };
});
const P2 = pattern<{ n: number }>(({ n }) => {
  const a = P1({ n });
  const b = P1({ n: n + 1 });
  return { v: a.v + b.v };
});
const P3 = pattern<{ n: number }>(({ n }) => {
  const a = P2({ n });
  const b = P2({ n: n + 1 });
  return { v: a.v + b.v };
});
export const Top = pattern<{ n: number }>(({ n }) => {
  const top = P3({ n });
  return { v: top.v };
});
