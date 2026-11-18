/// <cts-enable />
/**
 * A value handed to a pattern along with one of its members is forwarded whole,
 * so the handle covers all of it rather than the member alone.
 */
import { handler, pattern, type ReadonlyCell, Writable } from "commonfabric";

interface Box {
  first: string;
  second: string;
}

interface ChildInput {
  box: ReadonlyCell<Box>;
  first: ReadonlyCell<string>;
}

const Child = pattern<ChildInput, Record<string, never>>(() => ({}));

export const addChild = handler<
  Record<string, never>,
  { box: { first: string; second: string }; made: Writable<unknown[]> }
>((_, { box, made }) => {
  made.push(Child({ box, first: box.first } as any));
});
