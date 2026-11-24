import { pattern } from "commonfabric";

export const counter = pattern(() => {
  const count = 1;
  return <div>Count: {count}</div>;
});
