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

const setPayload = handler<
  { id: number },
  { payload: Writable<{ id: number }> }
>(
  (event, { payload }) => {
    payload.set({ id: event.id });
  },
);

// Fails for an address that begins with `bad:`.
const guard = lift((address: string) => {
  if (address.startsWith("bad:")) throw new Error("a bad address");
  return address;
});

// Fails for a result whose title is empty.
const strict = lift((item: Item | undefined) => {
  if (item !== undefined && item.title === "") throw new Error("no title");
  return item === undefined ? "nothing" : `titled ${item.title}`;
});

// An effect written in the reactive tier (`scheduler-and-serving-loop.md`
// §6). The request of `fetched` holds `address`, which a cone computes
// from `site`, and `payload`, a cell that it passes on by reference.
// `title`, `status`, `checked` and `inBody` read the result, and the body
// of `checked` throws for one result. Nothing reads the result of `_unread`.
// The request of `guarded` holds a value whose cone fails for one
// address. No per-element construct is here.
export default pattern<{ note: string }>(({ note }) => {
  const site = Writable.of("https://Example.test/a");
  const payload = Writable.of({ id: 1 });
  const address = computed(() => site.get().toLowerCase());
  const fetched = fetchJson<Item>({
    url: address,
    options: { method: "POST", body: payload },
  });
  const _unread = fetchJson<Item>({ url: address });
  const title = computed(() => fetched.result?.title ?? "none");
  const status = computed(() =>
    fetched.pending ? "pending" : fetched.error ? "failed" : "settled"
  );
  const checked = strict(fetched.result);
  // A function body that names the record of the result.
  const inBody = computed(() => {
    let text = "nothing yet";
    if (fetched.result) text = `got ${fetched.result.title}`;
    return text;
  });
  const guarded = fetchJson<Item>({ url: guard(address) });
  const guardedStatus = computed(() =>
    guarded.pending ? "pending" : "not pending"
  );
  return {
    note,
    title,
    status,
    checked,
    inBody,
    guardedStatus,
    setSite: setSite({ site }),
    setPayload: setPayload({ payload }),
  };
});
