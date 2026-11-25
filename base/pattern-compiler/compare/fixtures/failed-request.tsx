/// <cts-enable />
import {
  computed,
  fetchJson,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

const setSite = handler<{ to: string }, { site: Writable<string> }>(
  (event, { site }) => {
    site.set(event.to);
  },
);

// Fails for an address that begins with `bad:`.
const guard = lift((address: string) => {
  if (address.startsWith("bad:")) throw new Error("a bad address");
  return address;
});

// Copies whether the request is pending, read through the handle of its
// result, into `seen`.
const look = handler<
  void,
  { fetched: { pending: boolean }; seen: Writable<unknown> }
>((_event, { fetched, seen }) => {
  seen.set(fetched.pending);
});

// An effect whose request holds a value whose cone fails for one address.
// `status` reads a member of its result, `held` passes the result on by
// reference, the result holds it at `passed`, and the handler `look` reads
// it through a handle. No per-element construct is here.
export default pattern<{ note: string }>(({ note }) => {
  const site = Writable.of("https://example.test/a");
  const seen = Writable.of<unknown>("nothing");
  const fetched = fetchJson<Item>({ url: guard(site) });
  const status = computed(() => fetched.pending ? "pending" : "not pending");
  const held = computed(() => ({ request: fetched }));
  return {
    note,
    status,
    held,
    passed: fetched,
    seen,
    setSite: setSite({ site }),
    look: look({ fetched, seen }),
  };
});
