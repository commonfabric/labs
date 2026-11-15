/**
 * The pattern catalog: the interface every caller uses to see published
 * patterns and to get one.
 *
 * A caller reaches the catalog only by wishing for `#patternCatalog`
 * (`patternCatalog()` below), which resolves to a piece in the viewer's own
 * home. What stands behind that piece is the host's business: today a host
 * that fronts the cloud pattern index; later the index as a pattern. A caller
 * that uses this module and nothing else does not change when that moves.
 *
 * The catalog exposes data cells (`status`, `entries`) and two request
 * streams. A request carries a cell the caller owns, and the catalog answers
 * by writing it, so nothing is shared between callers. Getting a pattern is
 * not a stream any pattern may send to: it goes through `GetItButton`, a
 * trusted surface whose tap appends the request.
 */
import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

/** The wish tag a host favorites its catalog under. */
export const PATTERN_CATALOG_TAG = "#patternCatalog";

/** How well a pattern's recorded runs went, as the index judges it. */
export type CatalogQuality = "penalized" | "unproven" | "proven";

/**
 * One published pattern, as the catalog describes it. Every field but
 * `patternId` and `title` may be absent; a caller shows what is there.
 */
export interface CatalogEntry {
  /** The published version's content hash. */
  patternId: string;
  /** A short heading: the published name, else the start of the blurb. */
  title: string;
  /** What the pattern does, in its author's words (untrusted text). */
  blurb?: string;
  tags?: string[];
  quality?: CatalogQuality;
  /** Whether a person chose to publish it, or an agent did as a side effect. */
  published?: "chosen" | "automatic";
  /** The keys credited for it; empty when no person is credited. */
  authorKeys?: string[];
  /** When the version was published (ISO 8601). */
  createdAt?: string;
}

/**
 * Whether the catalog can answer. `unavailable` carries a reason a person
 * can read and, when one exists, the remedy (such as enrolling).
 */
export interface CatalogStatus {
  state: "ready" | "unavailable";
  reason?: string;
  remedy?: string;
  /** When the catalog last heard from its source (ISO 8601). */
  asOf?: string;
}

/** An answer to a `page` request. */
export interface CatalogPage {
  status: CatalogStatus;
  entries: CatalogEntry[];
}

/** Ask for entries matching `text`; blank text asks for the default listing. */
export interface CatalogPageRequest {
  text: string;
  result: Writable<CatalogPage | null>;
}

/**
 * Where a request to get a pattern stands. `started` means the host has begun
 * placing it; `placed` and `failed` are final.
 */
export interface GetItAnswer {
  state: "started" | "placed" | "failed";
  reason?: string;
}

/**
 * A person's request to get a pattern. `target` is a destination the host
 * defines (a host that places patterns on boards takes the board's id).
 */
export interface GetItRequest {
  patternId: string;
  target: string;
  result: Writable<GetItAnswer | null>;
}

/** What `#patternCatalog` resolves to. */
export interface PatternCatalog {
  status: CatalogStatus;
  /** A bounded window of the catalog's top entries. */
  entries: CatalogEntry[];
  page: Stream<CatalogPageRequest>;
  /** Appended only by `GetItButton`; a host acts on nothing else. */
  getRequests: Writable<GetItRequest[]>;
}

/** The viewer's catalog, or undefined when their home has none. */
export const patternCatalog = () =>
  wish<PatternCatalog>({ query: PATTERN_CATALOG_TAG }).result;

/** The entry with `patternId` among `entries`, if the window holds it. */
export const entryOf = pattern<
  { entries: CatalogEntry[]; patternId: string },
  CatalogEntry | undefined
>(({ entries, patternId }) =>
  computed(() =>
    (Array.isArray(entries) ? entries : []).find((entry) =>
      entry?.patternId === patternId
    )
  )
);

/** Entries whose title, blurb or tags contain `text`, ignoring case. */
export const searchEntries = pattern<
  { entries: CatalogEntry[]; text: string },
  CatalogEntry[]
>(({ entries, text }) =>
  computed(() => {
    const all = Array.isArray(entries) ? entries : [];
    const needle = typeof text === "string" ? text.trim().toLowerCase() : "";
    if (!needle) return all;
    return all.filter((entry) =>
      [entry?.title, entry?.blurb, ...(entry?.tags ?? [])].some((field) =>
        typeof field === "string" && field.toLowerCase().includes(needle)
      )
    );
  })
);

export const GET_IT_SURFACE = "PatternCatalogGetIt";
const GET_IT_ACTION = "PatternCatalogRequestGetIt";

/** Appends one request to get `patternId`, answered in `answer`. */
export const requestGetIt = handler<
  void,
  {
    getRequests: Writable<GetItRequest[]>;
    patternId: string;
    target: string;
    answer: Writable<GetItAnswer | null>;
  }
>((_, { getRequests, patternId, target, answer }) => {
  if (!patternId || !target) return;
  answer.set(null);
  getRequests.push({ patternId, target, result: answer });
});

export interface GetItButtonInput {
  catalog: PatternCatalog;
  patternId: string;
  target: string;
  /** The button's label; "Get it" by default. */
  label?: string;
}

export interface GetItButtonOutput {
  [NAME]: string;
  [UI]: VNode;
  getRequests: TrustedActionWrite<
    GetItRequest[],
    typeof requestGetIt,
    typeof GET_IT_ACTION,
    typeof GET_IT_SURFACE
  >;
  answer: GetItAnswer | null;
  getIt: Stream<void>;
}

/**
 * The one way to get a pattern: a person's tap on this button. It shows the
 * request's answer once the host writes one.
 */
export const GetItButton = pattern<GetItButtonInput, GetItButtonOutput>(
  ({ catalog, patternId, target, label }) => {
    const answer = new Writable<GetItAnswer | null>(null);
    const getRequests = catalog.getRequests;
    const getIt = requestGetIt({ getRequests, patternId, target, answer });
    const unavailable = computed(() => catalog.status?.state !== "ready");
    const note = computed(() => {
      const current = answer.get();
      if (current?.state === "started") return "Adding…";
      if (current?.state === "placed") return "Added";
      if (current?.state === "failed") {
        return current.reason
          ? `Couldn't add: ${current.reason}`
          : "Couldn't add";
      }
      return catalog.status?.state === "ready"
        ? ""
        : catalog.status?.reason ?? "The pattern catalog is unavailable";
    });
    return {
      [NAME]: computed(() => "Get it"),
      [UI]: (
        <cf-hstack
          gap="2"
          style={{ alignItems: "center" }}
          data-ui-pattern={GET_IT_SURFACE}
          data-ui-event-integrity={GET_IT_SURFACE}
        >
          <cf-button
            data-ui-action={GET_IT_ACTION}
            disabled={unavailable}
            onClick={getIt}
          >
            {computed(() => label || "Get it")}
          </cf-button>
          <span
            style={{
              fontSize: "13px",
              color: "var(--cf-theme-color-text-secondary)",
            }}
          >
            {note}
          </span>
        </cf-hstack>
      ),
      getRequests,
      answer,
      getIt,
    };
  },
);
