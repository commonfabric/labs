/**
 * A pattern catalog over a fixed list of entries, for tests and for building
 * callers without a host. It answers `page` by filtering its entries by
 * substring, and answers each get request that names its `host` once: placed
 * for an id it holds, failed for one it does not.
 */
import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type CatalogEntry,
  type CatalogPageRequest,
  type CatalogStatus,
  type GetItAnswer,
  type GetItRequests,
} from "./pattern-catalog.tsx";

/** What `FakeCatalog` takes; every input has a default. */
export interface FakeCatalogInput {
  entries?: Writable<CatalogEntry[] | Default<[]>>;
  status?: Writable<CatalogStatus | Default<{ state: "ready" }>>;
  getItRequests?: Writable<GetItRequests | Default<[]>>;
  getItAnswers?: Writable<
    Record<string, GetItAnswer> | Default<Record<string, never>>
  >;
  host?: Writable<string | Default<"fake-host">>;
}

/** The catalog, plus the stream that stands in for a host acting. */
export interface FakeCatalogOutput {
  [NAME]: string;
  [UI]: VNode;
  status: CatalogStatus;
  entries: CatalogEntry[];
  page: Stream<CatalogPageRequest>;
  getItRequests: GetItRequests;
  getItAnswers: Record<string, GetItAnswer>;
  host: string;
  /** Answers every get request naming `host` that has no answer yet. */
  answerGetItRequests: Stream<void>;
}

const matches = (entry: CatalogEntry, needle: string): boolean =>
  [entry.title, entry.blurb, ...(entry.tags ?? [])].some((field) =>
    typeof field === "string" && field.toLowerCase().includes(needle)
  );

/** A catalog that answers from `entries`, for tests. */
export const FakeCatalog = pattern<FakeCatalogInput, FakeCatalogOutput>(
  ({ entries, status, getItRequests, getItAnswers, host }) => {
    const page = action(({ text, standalone, result }: CatalogPageRequest) => {
      const current = status.get();
      if (current.state !== "ready") {
        result.set({ status: current, entries: [] });
        return;
      }
      const needle = (text ?? "").trim().toLowerCase();
      const all = [...(entries.get() ?? [])].filter((entry) =>
        standalone !== true || entry.standalone === true
      );
      result.set({
        status: current,
        entries: needle ? all.filter((entry) => matches(entry, needle)) : all,
      });
    });

    const answerGetItRequests = action(() => {
      const held = new Set((entries.get() ?? []).map((e) => e.patternId));
      const answers = { ...(getItAnswers.get() ?? {}) };
      const self = host.get();
      for (const request of getItRequests.get() ?? []) {
        if (request.host !== self || answers[request.requestId]) continue;
        answers[request.requestId] = held.has(request.patternId)
          ? {
            state: "placed",
            placed: `${request.destination}/${request.patternId}`,
          }
          : { state: "failed", reason: "no such pattern" };
      }
      getItAnswers.set(answers);
    });

    return {
      [NAME]: computed(() => "Pattern catalog (fake)"),
      [UI]: (
        <cf-vstack gap="2" padding="4">
          <span>
            {computed(() => `${(entries.get() ?? []).length} patterns`)}
          </span>
        </cf-vstack>
      ),
      status,
      entries,
      page,
      getItRequests,
      getItAnswers,
      host,
      answerGetItRequests,
    };
  },
);

export default FakeCatalog;
