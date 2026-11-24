import { pattern } from "commonfabric";

export const counter = pattern(() => {
  const count = 2;
  return <div>Count: {count}</div>;
});
