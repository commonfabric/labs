import { fetchJson, fetchJsonUnchecked } from "commonfabric";

interface Repo {
  name: string;
  stars: number;
}

// FIXTURE: fetch-json-schema
// Verifies: fetchJson<T> lowers the T type argument to an injected `schema`
//   property, which the runtime verifies the fetched JSON against. An
//   explicit `schema` parameter wins over injection. fetchJson without a type
//   argument is a compile error; fetchJsonUnchecked is the untyped escape
//   hatch and injects nothing.
export default function TestFetchJsonSchema() {
  const typed = fetchJson<Repo>({ url: "https://example.com/repo.json" });
  const explicit = fetchJson<Repo>({
    url: "https://example.com/repo.json",
    schema: { type: "object" },
  });
  const untyped = fetchJsonUnchecked({
    url: "https://example.com/free-form.json",
  });
  return { typed, explicit, untyped };
}
