/**
 * A pattern catalog over a fixed list of entries, for tests and for building
 * callers without a host. It answers `page` by filtering its entries and
 * answers every get request by marking it placed (or failed, for an id it
 * does not hold). A host's catalog must pass the same conformance tests.
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
  type GetItRequest,
} from "./pattern-catalog.tsx";

export interface FakeCatalogInput {
  entries?: Writable<CatalogEntry[] | Default<[]>>;
  status?: Writable<CatalogStatus | Default<{ state: "ready" }>>;
  getRequests?: Writable<GetItRequest[] | Default<[]>>;
}

export interface FakeCatalogOutput {
  [NAME]: string;
  [UI]: VNode;
  status: CatalogStatus;
  entries: CatalogEntry[];
  page: Stream<CatalogPageRequest>;
  getRequests: Writable<GetItRequest[]>;
  /** Answers every get request not yet answered. */
  answerGetRequests: Stream<void>;
}

const matches = (entry: CatalogEntry, needle: string): boolean =>
  [entry.title, entry.blurb, ...(entry.tags ?? [])].some((field) =>
    typeof field === "string" && field.toLowerCase().includes(needle)
  );

export const FakeCatalog = pattern<FakeCatalogInput, FakeCatalogOutput>(
  ({ entries, status, getRequests }) => {
    const page = action(({ text, result }: CatalogPageRequest) => {
      const current = status.get();
      if (current.state !== "ready") {
        result.set({ status: current, entries: [] });
        return;
      }
      const needle = (text ?? "").trim().toLowerCase();
      const all = [...(entries.get() ?? [])];
      result.set({
        status: current,
        entries: needle ? all.filter((entry) => matches(entry, needle)) : all,
      });
    });

    const answerGetRequests = action(() => {
      const held = new Set((entries.get() ?? []).map((e) => e.patternId));
      for (const request of getRequests.get() ?? []) {
        const result = request.result;
        if (result.get() !== null) continue;
        result.set(
          held.has(request.patternId)
            ? { state: "placed" }
            : { state: "failed", reason: "no such pattern" },
        );
      }
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
      getRequests,
      answerGetRequests,
    };
  },
);

export default FakeCatalog;
