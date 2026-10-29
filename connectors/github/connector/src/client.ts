import { classifyPullRequestStatus } from "./status.ts";
import type {
  GithubCheckState,
  GithubMergeState,
  GithubPullRequest,
  GithubPullRequestCollection,
  GithubReviewDecision,
} from "./types.ts";

const OPEN_PULL_REQUESTS_QUERY = `
  query OpenPullRequests($after: String) {
    viewer {
      login
      pullRequests(
        first: 50
        after: $after
        states: OPEN
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          url
          title
          isDraft
          createdAt
          updatedAt
          baseRefName
          baseRefOid
          headRefName
          headRefOid
          mergeable
          mergeStateStatus
          reviewDecision
          repository { nameWithOwner url }
          headRepository { nameWithOwner url }
          statusCheckRollup { state }
        }
      }
    }
  }
`;

const KNOWN_PULL_REQUEST_STATES_QUERY = `
  query KnownPullRequestStates($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on PullRequest { id state }
    }
  }
`;

const PAGE_SIZE = 50;
const MAX_OPEN_PULL_REQUESTS = 100_000;

export interface GithubGraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

export type GithubGraphqlTransport = (
  request: GithubGraphqlRequest,
  signal?: AbortSignal,
) => Promise<unknown>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface PullRequestPage {
  viewer: string;
  totalCount: number;
  pageInfo: PageInfo;
  nodes: GithubPullRequest[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function enumeration<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} has an unsupported value`);
  }
  return value as T;
}

const MERGEABLE = new Set(["CONFLICTING", "MERGEABLE", "UNKNOWN"]);
const MERGE_STATES = new Set([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);
const REVIEW_DECISIONS = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);
const CHECK_STATES = new Set([
  "ERROR",
  "EXPECTED",
  "FAILURE",
  "PENDING",
  "SUCCESS",
]);
const PULL_REQUEST_STATES = new Set(["OPEN", "CLOSED", "MERGED"]);

function parsePullRequest(
  value: unknown,
  observedAt: string,
  label: string,
): GithubPullRequest {
  const source = record(value, label);
  const repository = record(source.repository, `${label}.repository`);
  const headRepository = source.headRepository === null
    ? null
    : record(source.headRepository, `${label}.headRepository`);
  const statusRollup = source.statusCheckRollup === null
    ? null
    : record(source.statusCheckRollup, `${label}.statusCheckRollup`);
  if (!Number.isSafeInteger(source.number) || Number(source.number) < 1) {
    throw new Error(`${label}.number must be a positive safe integer`);
  }
  if (typeof source.isDraft !== "boolean") {
    throw new Error(`${label}.isDraft must be a boolean`);
  }
  const mergeable = enumeration<
    GithubPullRequest["mergeable"]
  >(source.mergeable, MERGEABLE, `${label}.mergeable`);
  const mergeState = enumeration<GithubMergeState>(
    source.mergeStateStatus,
    MERGE_STATES,
    `${label}.mergeStateStatus`,
  );
  const reviewDecision = source.reviewDecision === null
    ? null
    : enumeration<Exclude<GithubReviewDecision, null>>(
      source.reviewDecision,
      REVIEW_DECISIONS,
      `${label}.reviewDecision`,
    );
  const checkState = statusRollup === null
    ? null
    : enumeration<Exclude<GithubCheckState, null>>(
      statusRollup.state,
      CHECK_STATES,
      `${label}.statusCheckRollup.state`,
    );
  const common = {
    id: string(source.id, `${label}.id`),
    number: Number(source.number),
    url: string(source.url, `${label}.url`),
    title: string(source.title, `${label}.title`),
    repository: string(
      repository.nameWithOwner,
      `${label}.repository.nameWithOwner`,
    ),
    repositoryUrl: string(repository.url, `${label}.repository.url`),
    baseRefName: string(source.baseRefName, `${label}.baseRefName`),
    baseRefOid: string(source.baseRefOid, `${label}.baseRefOid`),
    headRefName: string(source.headRefName, `${label}.headRefName`),
    headRefOid: nullableString(source.headRefOid, `${label}.headRefOid`),
    headRepository: headRepository === null ? null : string(
      headRepository.nameWithOwner,
      `${label}.headRepository.nameWithOwner`,
    ),
    headRepositoryUrl: headRepository === null
      ? null
      : string(headRepository.url, `${label}.headRepository.url`),
    isDraft: source.isDraft,
    mergeable,
    mergeState,
    reviewDecision,
    checkState,
    createdAt: string(source.createdAt, `${label}.createdAt`),
    updatedAt: string(source.updatedAt, `${label}.updatedAt`),
    observedAt,
    visibility: "visible" as const,
  };
  return {
    ...common,
    status: classifyPullRequestStatus(common),
  };
}

function parsePage(value: unknown, observedAt: string): PullRequestPage {
  const root = record(value, "GraphQL response");
  const data = record(root.data, "GraphQL response.data");
  const viewer = record(data.viewer, "GraphQL response.data.viewer");
  const pullRequests = record(
    viewer.pullRequests,
    "GraphQL response.data.viewer.pullRequests",
  );
  const pageInfo = record(
    pullRequests.pageInfo,
    "GraphQL response.data.viewer.pullRequests.pageInfo",
  );
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error("GraphQL pull-request page has invalid hasNextPage");
  }
  if (!Array.isArray(pullRequests.nodes)) {
    throw new Error("GraphQL pull-request page has invalid nodes");
  }
  if (
    !Number.isSafeInteger(pullRequests.totalCount) ||
    Number(pullRequests.totalCount) < 0
  ) {
    throw new Error("GraphQL pull-request page has invalid totalCount");
  }
  const endCursor = nullableString(
    pageInfo.endCursor,
    "GraphQL pull-request page endCursor",
  );
  if (pageInfo.hasNextPage && endCursor === null) {
    throw new Error("GraphQL pull-request page has no next cursor");
  }
  return {
    viewer: string(viewer.login, "GraphQL response.data.viewer.login"),
    totalCount: Number(pullRequests.totalCount),
    pageInfo: { hasNextPage: pageInfo.hasNextPage, endCursor },
    nodes: pullRequests.nodes.map((node, index) =>
      parsePullRequest(node, observedAt, `pullRequests.nodes[${index}]`)
    ),
  };
}

async function readJsonResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (response.body === null) return await response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let removeAbortListener = () => {};
  const aborted = signal === undefined
    ? new Promise<never>(() => {})
    : new Promise<never>((_, reject) => {
      const onAbort = () => {
        void reader.cancel(signal.reason).catch(() => {});
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    signal?.throwIfAborted();
    text += decoder.decode();
  } finally {
    removeAbortListener();
    reader.releaseLock();
  }
  return JSON.parse(text);
}

/** A direct GitHub GraphQL client that performs complete paginated scans. */
export class GithubClient {
  readonly #transport: GithubGraphqlTransport;
  readonly #clock: () => Date;

  /** Create a client around an authenticated GraphQL transport. */
  constructor(
    transport: GithubGraphqlTransport,
    clock: () => Date = () => new Date(),
  ) {
    this.#transport = transport;
    this.#clock = clock;
  }

  /** Collect every open pull request authored by the authenticated user. */
  async collectOpenPullRequests(
    signal?: AbortSignal,
    previouslyKnown: ReadonlyArray<GithubPullRequest> = [],
  ): Promise<GithubPullRequestCollection> {
    const observedAt = this.#clock().toISOString();
    const pullRequests: GithubPullRequest[] = [];
    let cursor: string | null = null;
    let viewer: string | undefined;
    let totalCount: number | undefined;
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let pageCount = 0;
    do {
      signal?.throwIfAborted();
      const page = parsePage(
        await this.#transport(
          {
            query: OPEN_PULL_REQUESTS_QUERY,
            variables: { after: cursor },
          },
          signal,
        ),
        observedAt,
      );
      pageCount++;
      if (viewer !== undefined && page.viewer !== viewer) {
        throw new Error("GitHub viewer changed during collection");
      }
      if (totalCount !== undefined && page.totalCount !== totalCount) {
        throw new Error("GitHub pull-request count changed during collection");
      }
      viewer = page.viewer;
      totalCount = page.totalCount;
      if (totalCount > MAX_OPEN_PULL_REQUESTS) {
        throw new Error("GitHub pull-request collection exceeds safety limit");
      }
      const maximumPages = Math.max(1, totalCount);
      if (pageCount > maximumPages) {
        throw new Error("GitHub pull-request pagination exceeded its total");
      }
      if (page.pageInfo.hasNextPage && page.nodes.length === 0) {
        throw new Error("GitHub returned an empty pull-request page");
      }
      for (const pullRequest of page.nodes) {
        if (ids.has(pullRequest.id)) {
          throw new Error(
            `GitHub returned a duplicate pull request: ${pullRequest.url}`,
          );
        }
        ids.add(pullRequest.id);
        pullRequests.push(pullRequest);
      }
      if (pullRequests.length > totalCount) {
        throw new Error("GitHub pull-request pages exceed their total");
      }
      const nextCursor = page.pageInfo.hasNextPage
        ? page.pageInfo.endCursor
        : null;
      if (nextCursor !== null && cursors.has(nextCursor)) {
        throw new Error(`GitHub repeated a pull-request cursor: ${nextCursor}`);
      }
      if (nextCursor !== null) cursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor !== null);
    if (pullRequests.length !== totalCount) {
      throw new Error(
        `GitHub collection returned ${pullRequests.length} of ${totalCount} pull requests`,
      );
    }
    const missing = previouslyKnown.filter((pullRequest) =>
      !ids.has(pullRequest.id)
    );
    const retained = await this.#retainUnknownMissing(missing, signal);
    for (const pullRequest of retained) pullRequests.push(pullRequest);
    return {
      viewer: viewer!,
      observedAt,
      pullRequests,
    };
  }

  async #retainUnknownMissing(
    missing: ReadonlyArray<GithubPullRequest>,
    signal?: AbortSignal,
  ): Promise<GithubPullRequest[]> {
    const retained: GithubPullRequest[] = [];
    for (let offset = 0; offset < missing.length; offset += PAGE_SIZE) {
      signal?.throwIfAborted();
      const batch = missing.slice(offset, offset + PAGE_SIZE);
      const response = record(
        await this.#transport({
          query: KNOWN_PULL_REQUEST_STATES_QUERY,
          variables: { ids: batch.map((pullRequest) => pullRequest.id) },
        }, signal),
        "known pull-request response",
      );
      const data = record(response.data, "known pull-request response.data");
      if (!Array.isArray(data.nodes) || data.nodes.length !== batch.length) {
        throw new Error("known pull-request response has invalid nodes");
      }
      for (let index = 0; index < batch.length; index++) {
        const node = data.nodes[index];
        if (node !== null) {
          const state = enumeration<"OPEN" | "CLOSED" | "MERGED">(
            record(node, `known pull-request node ${index}`).state,
            PULL_REQUEST_STATES,
            `known pull-request node ${index}.state`,
          );
          if (state === "CLOSED" || state === "MERGED") continue;
        }
        retained.push({
          ...batch[index],
          visibility: "unknown",
          status: "visibility-unknown",
        });
      }
    }
    return retained;
  }
}

/** Create the HTTPS transport used by the laptop host. */
export function createGithubGraphqlTransport(options: {
  token: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}): GithubGraphqlTransport {
  const token = options.token.trim();
  if (!token) throw new Error("GitHub token must not be empty");
  const endpoint = options.endpoint ?? "https://api.github.com/graphql";
  const request = options.fetch ?? globalThis.fetch;
  return async (body, signal) => {
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "commonfabric-github-host",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub GraphQL request failed with ${response.status}`);
    }
    const value = await readJsonResponse(response, signal);
    const root = record(value, "GitHub GraphQL response");
    if (Array.isArray(root.errors) && root.errors.length > 0) {
      const messages = root.errors.map((item, index) => {
        const error = record(item, `GitHub GraphQL error ${index}`);
        return typeof error.message === "string"
          ? error.message
          : "unknown GraphQL error";
      });
      throw new Error(`GitHub GraphQL request failed: ${messages.join("; ")}`);
    }
    return value;
  };
}
