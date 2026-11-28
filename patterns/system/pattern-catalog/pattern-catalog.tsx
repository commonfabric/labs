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
 * get a pattern. Only `GetItButton` can add one of those: each request's type
 * declares its one trusted writer, and labels it with who tapped.
 */
import {
  AuthoredByCurrentUser,
  type Cell,
  computed,
  eventKey,
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
 * Where a pattern ranks. `featured` is chosen by a curator; `main` holds
 * patterns their author has used, ranked by other people's use; `unvetted`
 * holds patterns nobody has shown working yet.
 */
export type CatalogBucket = "featured" | "main" | "unvetted";

/**
 * Why an entry is not discoverable. Only the pattern's own author sees an
 * unlisted entry: `draft` until they ask for it to be listed, `checking` while
 * it is checked for personal details, `held` when the check found something
 * (`reason` says what, without repeating it), `error` when the check failed
 * and waits for a re-run.
 */
export interface CatalogUnlisted {
  state: "draft" | "checking" | "held" | "error";
  reason?: string;
}

/** How many people have used a pattern, across its versions. */
export interface CatalogCounts {
  /** Distinct people who placed it. */
  people?: number;
  /** Distinct people who came back to it on a later day. */
  returning?: number;
}

/**
 * A link to a Common Fabric profile, opaque on purpose: render it with
 * `<cf-profile-badge>`, which reads the name and picture from the profile and
 * shows whether they are the profile owner's own. Never read a name out of it
 * yourself.
 */
export type CatalogProfile = Cell<Record<string, never>>;

/**
 * One original along a remix's chain: the pattern and its published name, or
 * `unavailable` for an original the viewer may not see (taken down, say),
 * which ends the chain and says nothing else about it. A step with no
 * `patternId` is read as `unavailable`.
 */
export type CatalogRemixStep =
  | { patternId: string; title?: string }
  | { unavailable: true };

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
  /**
   * Whether its author offers it to a person choosing what to place, on its
   * own at the top of a loom. Every pattern is also a part other patterns
   * may build from; one that is not standalone is only that. A host copies
   * the index's answer onto every entry and never fills in its own; a caller
   * reads an entry without it as not offered on its own.
   */
  standalone?: boolean;
  tags?: string[];
  quality?: CatalogQuality;
  /** When the version was published (ISO 8601). */
  createdAt?: string;
  bucket?: CatalogBucket;
  /** The author's stable pseudonym, not who they are. */
  author?: string;
  /**
   * How much other people use the author's other shared patterns, 0 to 9: what
   * makes an anonymous author worth trusting. Shown beside `author`, never
   * beside a profile.
   */
  authorTier?: number;
  /**
   * The Common Fabric profile the author published this pattern under, when
   * they chose to be named (`cf pattern publish --as`). The name and picture
   * are read from the profile itself, never carried here. Absent on a pattern
   * shared anonymously, which shows only `author`.
   */
  authorProfile?: CatalogProfile;
  /**
   * What this pattern is a remix of, nearest original first: a remix of a
   * remix lists its whole chain. An original the viewer may not see is
   * `{unavailable: true}` and ends the chain. Absent when it is not a remix,
   * or when the index shows it to this viewer as no remix at all.
   */
  remixOf?: CatalogRemixStep[];
  /** Present only on the viewer's own entries that others cannot find yet. */
  unlisted?: CatalogUnlisted;
  counts?: CatalogCounts;
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
  /** When the tap happened (ms since the epoch); a host acts within a window. */
  requestedAt: number;
  /** The catalog's `host` at the tap: only that host acts on the request. */
  host: string;
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

/**
 * Appends one request to get `patternId` at `destination`, as a document of
 * its own labelled with who tapped (`GetItRequests`).
 */
export const requestGetIt = handler<
  void,
  {
    getItRequests: Writable<GetItRequests>;
    getItAnswers: Record<string, GetItAnswer>;
    status: CatalogStatus;
    host: string | undefined;
    patternId: string;
    destination: CatalogDestination;
  }
>((
  _,
  { getItRequests, getItAnswers, status, host, patternId, destination },
) => {
  if (!patternId || !destination || !host || status?.state !== "ready") {
    return;
  }
  const requests = getItRequests.get() ?? [];
  const latest = latestRequest(requests, patternId, destination);
  const answer = latest ? getItAnswers?.[latest.requestId] : undefined;
  // One request at a time per pattern and destination: an unanswered or
  // started request is still being acted on, and a placed one is done. The
  // append depends on that read, so it is a read-modify-write: two taps that
  // race conflict, and the retried one sees the first.
  if (latest && (!answer || answer.state === "started")) return;
  if (answer?.state === "placed") return;
  // The same on every run of this tap (a conflict retry, the client's echo
  // and the served run), so a host sees one request per tap. A tap the stream
  // admits again derives the same key, and finds its request already there.
  const requestId = eventKey();
  if (requests.some((request) => request?.requestId === requestId)) return;
  // The new request is a `GetItEntry`, so it is stored as a document of its
  // own with its own `authored-by` and writer; the requests already there
  // stay the documents they are.
  getItRequests.set([...requests, {
    requestId,
    patternId,
    destination,
    requestedAt: Date.now(),
    host,
  } as GetItEntry]);
});

/** The id of `GetItButton`'s surface, as its trusted writes name it. */
export const GET_IT_SURFACE = "PatternCatalogGetIt";

/** The id of the button's one action, as its trusted writes name it. */
export const GET_IT_ACTION = "PatternCatalogRequestGetIt";

/**
 * One stored request to get a pattern: written only by `requestGetIt`, on a
 * trusted tap on `GetItButton`, and labelled `authored-by` the principal who
 * tapped. The policy sits on each request rather than on the list, so each is
 * a document of its own carrying both, and a host checks the request it acts
 * on: who asked, and that the button's handler wrote it.
 */
export type GetItEntry = AuthoredByCurrentUser<
  TrustedActionWrite<
    GetItRequest,
    typeof requestGetIt,
    typeof GET_IT_ACTION,
    typeof GET_IT_SURFACE
  >
>;

/** The catalog's requests to get a pattern, oldest first. */
export type GetItRequests = GetItEntry[];

/** What `#patternCatalog` resolves to. */
export interface PatternCatalog {
  status: CatalogStatus;
  /** A bounded window of the catalog's top entries: the default listing. */
  entries: CatalogEntry[];
  page: Stream<CatalogPageRequest>;
  getItRequests: GetItRequests;
  /** The host's answer to each request, by `requestId`. */
  getItAnswers: Record<string, GetItAnswer>;
  /**
   * An opaque id naming the host instance that will act on get requests;
   * absent means no host acts yet.
   */
  host?: string;
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
  /**
   * The name of the place `destination` stands for, as the person knows it
   * (such as the loom's name). The button says it installs onto this; it says
   * nothing about where when the name is absent.
   */
  destinationName?: string;
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
 * The one way to get a pattern: a person's tap on this button. The button is a
 * `cf-pattern-install`, which says in its own words what a tap does: "Install
 * “title” onto destination", with the title taken from the catalog's own
 * `entries` for `patternId` (the id when the window does not hold it), never
 * from text the caller passes. It shows the answer to the latest request for
 * its pattern and destination, and stays
 * disabled while that request is open, once it is placed, and while the
 * catalog cannot answer, no host acts on its requests, or there is nowhere to
 * put the pattern.
 */
export const GetItButton = pattern<GetItButtonInput, GetItButtonOutput>(
  ({ catalog, patternId, destination, destinationName }) => {
    const getIt = requestGetIt({
      getItRequests: catalog.getItRequests,
      getItAnswers: catalog.getItAnswers,
      status: catalog.status,
      host: catalog.host,
      patternId,
      destination,
    });
    const patternTitle = computed(() =>
      (catalog.entries ?? []).find((entry) => entry?.patternId === patternId)
        ?.title ?? ""
    );
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
      if (!patternId) return "There is no pattern to get";
      if (!destination) return "There is nowhere to put it";
      if (catalog.status?.state !== "ready") {
        const reason = catalog.status?.reason ??
          "The pattern catalog is unavailable";
        const remedy = catalog.status?.remedy;
        return remedy ? `${reason}. ${remedy}` : reason;
      }
      if (!catalog.host) return "Nothing can get patterns here yet";
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
      [NAME]: "Get it",
      [UI]: (
        <cf-hstack
          gap="2"
          style={{ alignItems: "center" }}
          data-ui-pattern={GET_IT_SURFACE}
          data-ui-event-integrity={GET_IT_SURFACE}
        >
          <cf-pattern-install
            data-ui-action={GET_IT_ACTION}
            patternId={patternId}
            patternTitle={patternTitle}
            destinationName={destinationName}
            disabled={disabled}
            onClick={getIt}
          />
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

/** What `CatalogByline` takes. */
export interface CatalogBylineInput {
  entry: CatalogEntry;
}

/** What `CatalogByline` returns. */
export interface CatalogBylineOutput {
  [NAME]: string;
  [UI]: VNode;
}

/**
 * How a remix's chain reads: "Remix of “A”, a remix of “B”". A step without a
 * title is "an untitled pattern", never its id. The chain stops at the first
 * step the viewer may not see, or that is not well formed (fail closed), and
 * says "a pattern that's no longer available" for it.
 */
export const remixOfText = (steps: readonly CatalogRemixStep[]): string => {
  const names: string[] = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (
      !step || typeof step !== "object" || "unavailable" in step ||
      typeof step.patternId !== "string" || !step.patternId
    ) {
      names.push("a pattern that's no longer available");
      break;
    }
    const title = typeof step.title === "string"
      ? step.title.split(/\s+/).join(" ").trim()
      : "";
    names.push(title ? `“${title}”` : "an untitled pattern");
  }
  return names.length === 0 ? "" : `Remix of ${names.join(", a remix of ")}`;
};

/**
 * Who made an entry and what it remixes, the way every caller shows it. A
 * pattern published under a profile shows that profile's badge, which reads
 * the name and picture from the profile itself; one shared anonymously shows
 * only its pseudonym. A remix says what it is a remix of, down its chain.
 */
export const CatalogByline = pattern<CatalogBylineInput, CatalogBylineOutput>(
  ({ entry }) => {
    const remixText = computed(() => remixOfText(entry?.remixOf ?? []));
    const pseudonym = computed(() => {
      if (entry?.authorProfile || !entry?.author) return "";
      const tier = entry?.authorTier;
      return typeof tier === "number" && Number.isInteger(tier) && tier >= 0 &&
          tier <= 9
        ? `${entry.author} · credibility ${tier} of 9`
        : entry.author;
    });
    return {
      [NAME]: "Byline",
      [UI]: (
        <cf-hstack
          gap="2"
          wrap
          style={{
            alignItems: "center",
            fontSize: "13px",
            color: "var(--cf-theme-color-text-secondary)",
          }}
        >
          {entry?.authorProfile
            ? <cf-profile-badge $profile={entry.authorProfile} size="xs" />
            : null}
          {computed(() => pseudonym ? <span>by {pseudonym}</span> : null)}
          {computed(() => remixText ? <span>{remixText}</span> : null)}
        </cf-hstack>
      ),
    };
  },
);
