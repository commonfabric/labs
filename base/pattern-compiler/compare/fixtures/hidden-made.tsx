/// <cts-enable />
import {
  computed,
  type Confidential,
  type CurrentPrincipal,
  handler,
  lift,
  NAME,
  pattern,
  type PerUser,
  type ReadonlyCell,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// The Topics board's topics reduced to what reads a value of each viewer: a
// handler makes an instance of `Item`, as the board's `addTopic` makes a
// topic, and adds it to a list of the space, an array of references. Each
// item's view reads `nickname`, a value of the scope `user` handed to it as
// a topic reads its viewer's profile; the board's view shows each item's
// byline, as the board's cards show what each topic derived, so that the
// board's derivation for each principal brings the item up to date for that
// principal; and the board derives a table over the items, read as cells,
// as the board's `crossrefTable` derives its rows, each row written at the
// address of its item (`Writable.for`).

/** A value readable only by the principal whose instance holds it. */
type Own = Confidential<
  string,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

interface ItemResult {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  byline: string;
}

const Item = pattern<
  { title: string; nickname: ReadonlyCell<string> },
  ItemResult
>(({ title, nickname }) => {
  const byline = computed(() => `${title}, seen by ${nickname.get()}`);
  return {
    [NAME]: title,
    [UI]: (
      <div>
        <b>{title}</b>
        <i>{byline}</i>
      </div>
    ),
    title,
    byline,
  };
});

const add = handler<
  { title: string },
  { items: Writable<ItemResult[]>; nickname: ReadonlyCell<string> }
>((event, { items, nickname }) => {
  items.push(Item({ title: event.title, nickname }));
});

interface TableRow {
  item: unknown;
  title: string;
}

const tableOf = lift(
  ({ sources }: { sources: ReadonlyCell<{ title: string }>[] }): TableRow[] =>
    Array.from(sources).map((source) =>
      Writable.for<TableRow>(source).set({
        item: source,
        title: source.key("title").get(),
      })
    ),
);

interface Output {
  items: ItemResult[];
  table: TableRow[];
  nickname?: PerUser<Writable<string>>;
  add: Stream<{ title: string }>;
}

export default pattern<{ items: Writable<ItemResult[]> }, Output>(
  ({ items }) => {
    const nickname = new Writable.perUser<Own>("");
    return {
      [NAME]: "Items",
      [UI]: (
        <div>
          {items.map((item) => (
            <p>
              <b>{item.title}</b>
              <i>{item.byline}</i>
            </p>
          ))}
        </div>
      ),
      items,
      table: tableOf({ sources: items }),
      nickname,
      add: add({ items, nickname }),
    };
  },
);
