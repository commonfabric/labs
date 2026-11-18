/// <cts-enable />
import {
  fetchJson,
  handler,
  navigateTo,
  pattern,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

// Requests an effect and keeps the link to its result.
const load = handler<
  { url: string },
  { body: Writable<{ id: number }>; loaded: Writable<unknown[]> }
>((event, { body, loaded }) => {
  loaded.push(fetchJson<Item>({ url: event.url, options: { body } }));
});

// Requests an effect and then throws.
const loadAndFail = handler<{ url: string }, { loaded: Writable<unknown[]> }>(
  (event, { loaded }) => {
    loaded.push(fetchJson<Item>({ url: event.url }));
    throw new Error("the handler fails");
  },
);

const setBody = handler<{ id: number }, { body: Writable<{ id: number }> }>(
  (event, { body }) => {
    body.set({ id: event.id });
  },
);

// A request of an effect that a handler makes
// (`scheduler-and-serving-loop.md` §6.2, "In a handler"), and a
// `navigateTo` of the reactive tier, whose result nothing reads. `loaded`
// is an array that the handler pushes the links to the results onto, and
// no per-element construct is over it.
export default pattern<{ target: { name: string } }>(({ target }) => {
  const body = Writable.of({ id: 1 });
  const loaded = Writable.of<unknown[]>([]);
  const _went = navigateTo(target);
  return {
    loaded,
    load: load({ body, loaded }),
    loadAndFail: loadAndFail({ loaded }),
    setBody: setBody({ body }),
  };
});
