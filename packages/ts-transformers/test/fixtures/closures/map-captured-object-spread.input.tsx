import { handler, pattern, UI, type Writable } from "commonfabric";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "cf-button": any;
    }
  }
}

interface Item {
  id: string;
}

interface State {
  items: Item[];
  log: Writable<string[]>;
  prefix: Writable<string>;
}

const record = handler<
  unknown,
  { log: Writable<string[]>; prefix: Writable<string>; id: string }
>((_, state) => {
  state.log.push(`${state.prefix.get()}:${state.id}`);
});

const moduleStyle = { color: "red" };

// FIXTURE: map-captured-object-spread
// Verifies: a spread of a captured `const` object literal with static keys, in
//   a reactive `.map()` callback, is written out as the properties it copies
//   { ...records, id: item.id } → { log: records.key("log"), prefix: records.key("prefix"), id: ... }
//   { ...moduleStyle }          → unchanged (a module binding is not captured)
// Context: the capture reaches the callback as an opaque reference, which has
//   no keys to spread
export default pattern<State>(({ items, log, prefix }) => {
  const records = { log, prefix };
  return {
    [UI]: (
      <div>
        {items.map((item) => (
          <cf-button
            style={{ ...moduleStyle }}
            onClick={record({ ...records, id: item.id })}
          >
            {item.id}
          </cf-button>
        ))}
      </div>
    ),
  };
});
