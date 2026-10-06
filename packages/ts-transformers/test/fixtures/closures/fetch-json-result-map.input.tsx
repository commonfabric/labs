import { fetchJson, pattern, resultOf, UI } from "commonfabric";

interface Item {
  name: string;
}

export default pattern<Record<string, never>>(() => {
  const items = resultOf(fetchJson<Item[]>({
    url: "https://example.com",
  }));

  return {
    [UI]: <div>{items.map((item) => <span>{item.name}</span>)}</div>,
  };
});
