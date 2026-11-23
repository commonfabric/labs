/// <cts-enable />
/**
 * A handler that makes an instance of a pattern and adds it to a list, and
 * a `lift` over the whole list that writes a document for each row of its
 * result. `add` instantiates `Member`, whose output `shout` is computed in
 * the instance's first derivation, and `rowsOf` reads the `shout` of each
 * member through its handle and writes, with `Writable.for(member).set(...)`,
 * a row addressed by the member.
 */
import {
  computed,
  type Default,
  handler,
  lift,
  pattern,
  type ReadonlyCell,
  type Stream,
  Writable,
} from "commonfabric";

interface MemberResult {
  title: string;
  shout: string;
}

const Member = pattern<{ title: string }, MemberResult>(({ title }) => ({
  title,
  shout: computed(() => title + "!"),
}));

interface Row {
  title: string;
}

const rowsOf = lift(
  (
    { members }: { members: ReadonlyCell<MemberResult>[] | Default<[]> },
  ): Row[] => {
    const made: unknown[] = [];
    for (const member of Array.from(members)) {
      const shout = member.key("shout").get();
      made.push(
        Writable.for<Row>(member).set({
          title: typeof shout === "string" ? shout : "",
        }),
      );
    }
    return made as Row[];
  },
);

const add = handler<
  { title: string },
  { members: Writable<MemberResult[]> }
>((event, { members }) => {
  members.push(Member({ title: event.title }));
});

interface Input {
  members: Writable<MemberResult[]>;
}

interface Output {
  rows: Row[];
  add: Stream<{ title: string }>;
}

export default pattern<Input, Output>(({ members }) => ({
  rows: rowsOf({ members }),
  add: add({ members }),
}));
