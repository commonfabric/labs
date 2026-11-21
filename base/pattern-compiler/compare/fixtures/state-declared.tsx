/// <cts-enable />
import { type Confidential, pattern, Writable } from "commonfabric";

type Pinned = Confidential<string, ["alice"]>;

interface Input {
  note: string;
}

interface Output {
  pinned: Pinned;
}

// A state cell whose own type declares a clause, returned by reference
// (the form of `pinned` in `patterns/dev/test/cfc-trusted-write/main.tsx`).
export default pattern<Input, Output>((_input) => {
  const pinned = new Writable<Pinned>("");
  return { pinned };
});
