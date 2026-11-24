import { fetchJson, pattern, UI } from "commonfabric";

interface Item {
  name: string;
}

export default pattern<Record<string, never>>(() => {
  const { result: items } = fetchJson<Item[]>({
    url: "https://example.com",
    result: [],
  });

  return {
    [UI]: <div>{items.map((item) => <span>{item.name}</span>)}</div>,
  };
});
