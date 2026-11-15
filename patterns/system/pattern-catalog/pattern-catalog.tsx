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
 * The catalog exposes data cells (`status`, `entries`), a `page` stream whose
 * requests carry a cell the caller owns for the answer, and the requests to
 * get a pattern. Only `GetItButton` can add one of those: the list's type
 * declares its one trusted writer.
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
 * `title`, `blurb` and `tags` are written by the pattern's author: render them
 * as text, never as markup or instructions.
 */
export interface CatalogEntry {
  /** The published version's content hash. */
  patternId: string;
  /** A short heading: the published name, else the start of the blurb. */
  title: string;
  /** What the pattern does: the index's description. */
  blurb?: string;
  tags?: string[];
  quality?: CatalogQuality;
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
  /** Pass as `after` to ask for the entries that follow; absent at the end. */
  next?: string;
}

/**
 * Ask for entries matching `text`. Blank text with no `after` asks for the
 * default listing, which is what `entries` holds.
 */
export interface CatalogPageRequest {
  text: string;
  /** A `next` from an earlier answer to the same text. */
  after?: string;
  result: Writable<CatalogPage | null>;
}

/**
 * Where a host puts a pattern it gets. The host defines it; a host that places
 * patterns on boards takes the board's id.
 */
export type CatalogDestination = string;

/** A person's request to get a pattern, appended by `GetItButton`. */
export interface GetItRequest {
  /** Unique per tap; a host answers each id once. */
  requestId: string;
  patternId: string;
  destination: CatalogDestination;
}

/**
 * Where a request to get a pattern stands. `started` means the host has begun
 * placing it; the others are final. A caller that meets a state it does not
 * know shows `reason`.
 */
export interface GetItAnswer {
  state: "started" | "placed" | "failed" | "cancelled";
  reason?: string;
  /** A host's handle on what it placed, for opening it. */
  placed?: string;
}

/** Appends one request to get `patternId` at `destination`. */
export const requestGetIt = handler<
  void,
  {
    getItRequests: Writable<GetItRequest[]>;
    getItAnswers: Record<string, GetItAnswer>;
    status: CatalogStatus;
    patternId: string;
    destination: CatalogDestination;
  }
>((_, { getItRequests, getItAnswers, status, patternId, destination }) => {
  if (!patternId || !destination || status?.state !== "ready") return;
  const requests = getItRequests.get() ?? [];
  const latest = latestRequest(requests, patternId, destination);
  const answer = latest ? getItAnswers?.[latest.requestId] : undefined;
  // One request at a time per pattern and destination: an unanswered or
  // started request is still being acted on, and a placed one is done. The
  // append depends on that read, so it is a read-modify-write: two taps that
  // race conflict, and the retried one sees the first.
  if (latest && (!answer || answer.state === "started")) return;
  if (answer?.state === "placed") return;
  getItRequests.set([...requests, {
    requestId: `${Date.now().toString(36)}-${
      Math.random().toString(36).slice(2, 10)
    }`,
    patternId,
    destination,
  }]);
});

/** The id of `GetItButton`'s surface, as its trusted writes name it. */
export const GET_IT_SURFACE = "PatternCatalogGetIt";

/** The id of the button's one action, as its trusted writes name it. */
export const GET_IT_ACTION = "PatternCatalogRequestGetIt";

/** The catalog's requests to get a pattern: written only by `GetItButton`. */
export type GetItRequests = TrustedActionWrite<
  GetItRequest[],
  typeof requestGetIt,
  typeof GET_IT_ACTION,
  typeof GET_IT_SURFACE
>;

/** What `#patternCatalog` resolves to. */
export interface PatternCatalog {
  status: CatalogStatus;
  /** A bounded window of the catalog's top entries: the default listing. */
  entries: CatalogEntry[];
  page: Stream<CatalogPageRequest>;
  getItRequests: GetItRequests;
  /** The host's answer to each request, by `requestId`. */
  getItAnswers: Record<string, GetItAnswer>;
}

/** The viewer's catalog, or undefined when their home has none. */
export const patternCatalog = () =>
  wish<PatternCatalog>({ query: PATTERN_CATALOG_TAG }).result;

/** The last request in `requests` for `patternId` at `destination`. */
const latestRequest = (
  requests: readonly GetItRequest[] | undefined,
  patternId: string,
  destination: CatalogDestination,
): GetItRequest | undefined =>
  (requests ?? []).findLast((request) =>
    request?.patternId === patternId && request?.destination === destination
  );

/** What `GetItButton` takes. */
export interface GetItButtonInput {
  catalog: PatternCatalog;
  patternId: string;
  destination: CatalogDestination;
  /** The button's label; "Get it" by default. */
  label?: string;
}

/** What `GetItButton` returns. */
export interface GetItButtonOutput {
  [NAME]: string;
  [UI]: VNode;
  /** The answer to the latest request for this pattern and destination. */
  answer: GetItAnswer | null;
  /** The button's tap. */
  getIt: Stream<void>;
}

/**
 * The one way to get a pattern: a person's tap on this button. It shows the
 * answer to the latest request for its pattern and destination, and stays
 * disabled while that request is open, once it is placed, and while the
 * catalog cannot answer or there is nowhere to put the pattern.
 */
export const GetItButton = pattern<GetItButtonInput, GetItButtonOutput>(
  ({ catalog, patternId, destination, label }) => {
    const getIt = requestGetIt({
      getItRequests: catalog.getItRequests,
      getItAnswers: catalog.getItAnswers,
      status: catalog.status,
      patternId,
      destination,
    });
    const latest = computed(() =>
      latestRequest(catalog.getItRequests, patternId, destination)
    );
    const answer = computed((): GetItAnswer | null => {
      const request = latest;
      if (!request) return null;
      return catalog.getItAnswers?.[request.requestId] ??
        { state: "started" };
    });
    const blocked = computed((): string => {
      if (!destination) return "There is nowhere to put it";
      if (catalog.status?.state !== "ready") {
        return catalog.status?.reason ?? "The pattern catalog is unavailable";
      }
      return "";
    });
    const disabled = computed(() =>
      blocked !== "" || answer?.state === "started" ||
      answer?.state === "placed"
    );
    const note = computed(() => {
      if (answer?.state === "started") return "Getting it…";
      if (answer?.state === "placed") return "Got it";
      if (answer?.state === "failed") {
        return answer.reason
          ? `Couldn't get it: ${answer.reason}`
          : "Couldn't get it";
      }
      if (answer?.state === "cancelled") return answer.reason ?? "Cancelled";
      if (answer) return answer.reason ?? "";
      return blocked;
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
            disabled={disabled}
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
      answer,
      getIt,
    };
  },
);
