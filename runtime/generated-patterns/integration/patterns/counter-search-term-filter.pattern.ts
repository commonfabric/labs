import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface NamedCounter {
  id: string;
  label: string;
  value: number;
}

interface SearchFilterArgs {
  counters: Default<NamedCounter[], []>;
  search: Default<string, "">;
}

interface CounterUpdateEvent {
  id?: string;
  delta?: number;
  value?: number;
  label?: string;
}

const sanitizeCounterList = (
  entries: readonly NamedCounter[] | undefined,
): NamedCounter[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const safeId = typeof entry?.id === "string" && entry.id.trim()
      ? entry.id
      : `counter-${index}`;
    const safeLabel = typeof entry?.label === "string" && entry.label.trim()
      ? entry.label
      : `Counter ${index + 1}`;
    const rawValue = entry?.value;
    const safeValue = typeof rawValue === "number" && Number.isFinite(rawValue)
      ? rawValue
      : 0;
    return { id: safeId, label: safeLabel, value: safeValue };
  });
};

const sanitizeSearchTerm = (input: string | undefined): string => {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(0, 64);
};

const setSearchTerm = handler(
  (
    event: { term?: string; query?: string } | string | undefined,
    context: { search: Cell<string> },
  ) => {
    const raw = typeof event === "string" ? event : event?.term ?? event?.query;
    const sanitized = sanitizeSearchTerm(raw);
    context.search.set(sanitized);
  },
);

const resetSearchTerm = handler(
  (_event: unknown, context: { search: Cell<string> }) => {
    context.search.set("");
  },
);

const liftSearchDisplay = lift((term: string) =>
  term.length > 0 ? term : "(all)"
);

const liftFilteredCounters = lift(
  (input: { values: NamedCounter[]; term: string }): NamedCounter[] => {
    const query = input.term.toLowerCase();
    if (!query) return input.values;
    return input.values.filter((item) =>
      item.label.toLowerCase().includes(query)
    );
  },
);

const liftFilteredLabels = lift((entries: NamedCounter[]) =>
  entries.map((entry) => `${entry.label} (${entry.value})`)
);

const liftSanitizeCounterList = lift(sanitizeCounterList);
const liftSanitizeSearchTerm = lift(sanitizeSearchTerm);

const updateCounterValue = handler(
  (
    event: CounterUpdateEvent | undefined,
    context: { counters: Cell<NamedCounter[]> },
  ) => {
    const list = sanitizeCounterList(context.counters.get());
    if (list.length === 0) return;

    const fallbackId = list[0]?.id;
    const targetId = typeof event?.id === "string" && event.id.trim()
      ? event.id
      : fallbackId;
    if (!targetId) return;

    const hasValue = typeof event?.value === "number" &&
      Number.isFinite(event.value);
    const delta = typeof event?.delta === "number" &&
        Number.isFinite(event.delta)
      ? event.delta
      : 0;
    const nextLabel = typeof event?.label === "string" &&
        event.label.trim()
      ? event.label
      : undefined;

    const updated = list.map((item) => {
      if (item.id !== targetId) return item;
      const base = hasValue ? event.value! : item.value + delta;
      const safeValue = Number.isFinite(base) ? base : item.value;
      return {
        id: item.id,
        label: nextLabel ?? item.label,
        value: safeValue,
      };
    });

    context.counters.set(updated);
  },
);

export const counterWithSearchTermFilter = pattern<SearchFilterArgs>(
  ({ counters, search }) => {
    const sanitizedCounters = liftSanitizeCounterList(counters);
    const searchTerm = liftSanitizeSearchTerm(search);
    const searchDisplay = liftSearchDisplay(searchTerm);

    const filteringInputs = {
      values: sanitizedCounters,
      term: searchTerm,
    };

    const filtered = liftFilteredCounters(filteringInputs);

    const totalCount = sanitizedCounters.length;
    const filteredCount = filtered.length;
    const hasMatches = filteredCount > 0;

    const filteredLabels = liftFilteredLabels(filtered);

    const summary =
      str`Matches ${filteredCount}/${totalCount} for ${searchDisplay}`;

    return {
      counters,
      search,
      sanitizedCounters,
      searchTerm,
      searchDisplay,
      totalCount,
      filtered,
      filteredCount,
      filteredLabels,
      summary,
      hasMatches,
      setSearch: setSearchTerm({ search }),
      resetSearch: resetSearchTerm({ search }),
      updateCounter: updateCounterValue({ counters }),
    };
  },
);

export default counterWithSearchTermFilter;
