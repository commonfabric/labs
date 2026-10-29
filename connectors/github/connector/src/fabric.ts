import type { Cell } from "@commonfabric/runner";
import {
  githubFabricCellId,
  type GithubFabricConnection,
  type GithubFabricWriter,
  readGithubFabricCell,
  writeGithubFabricCells,
} from "./fabric-storage.ts";
import { GithubSerialQueue } from "./serial-queue.ts";
import type {
  GithubPullRequest,
  GithubPullRequestCollection,
  GithubPullRequestIndex,
} from "./types.ts";

export const GITHUB_CONNECTOR_SCHEMAS = {
  pullRequest: "commonfabric.github-connector.pull-request.v1",
  pullRequestIndex: "commonfabric.github-connector.pull-request-index.v1",
  health: "commonfabric.github-connector.health.v1",
} as const;

const DETAIL_PUBLICATION_BATCH_SIZE = 20;

export interface GithubFabricCells {
  index: Cell<unknown>;
  health: Cell<unknown>;
}

export interface GithubConnectorSource {
  host: string;
  account: string;
}

/** Metadata committed with the last complete pull-request index. */
export interface GithubLastCompleteCollection {
  completedAt: string;
  pullRequestCount: number;
}

/** Deterministic Fabric causes for the GitHub connector's root cells. */
export function githubFabricCauses(
  spaceDid: string,
  source: GithubConnectorSource,
) {
  return {
    index: {
      spaceDid,
      githubConnector: "pull-request-index",
      version: 1,
      source,
    },
    health: {
      spaceDid,
      githubConnector: "health",
      version: 1,
      source,
    },
  } as const;
}

function pullRequestCause(
  spaceDid: string,
  source: GithubConnectorSource,
  pullRequest: GithubPullRequest,
) {
  return {
    spaceDid,
    githubConnector: "pull-request",
    version: 1,
    source,
    repository: pullRequest.repository,
    number: pullRequest.number,
    snapshot: pullRequest,
  } as const;
}

function graphEntry(cell: Cell<unknown>, value: object) {
  return { cell, value: value as Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function previousGeneration(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (
    !isRecord(value) ||
    value.schema !== GITHUB_CONNECTOR_SCHEMAS.pullRequestIndex ||
    !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
  ) {
    throw new Error("GitHub pull-request index has an invalid shape");
  }
  return Number(value.generation);
}

const STORED_PULL_REQUEST_STRING_FIELDS = [
  "id",
  "url",
  "title",
  "repository",
  "repositoryUrl",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "mergeable",
  "mergeState",
  "createdAt",
  "updatedAt",
  "observedAt",
  "visibility",
  "status",
] as const;

function storedPullRequest(
  row: Record<string, unknown>,
  index: number,
): GithubPullRequest {
  const { detail: _detail, ...pullRequest } = row;
  const nullableStrings = [
    pullRequest.headRepository,
    pullRequest.headRepositoryUrl,
    pullRequest.headRefOid,
    pullRequest.reviewDecision,
    pullRequest.checkState,
  ];
  if (
    !STORED_PULL_REQUEST_STRING_FIELDS.every((field) =>
      typeof pullRequest[field] === "string"
    ) ||
    !Number.isSafeInteger(pullRequest.number) ||
    Number(pullRequest.number) < 1 ||
    typeof pullRequest.isDraft !== "boolean" ||
    !nullableStrings.every((value) =>
      value === null || typeof value === "string"
    )
  ) {
    throw new Error(`GitHub pull-request row is invalid: ${index}`);
  }
  return structuredClone(pullRequest) as unknown as GithubPullRequest;
}

function detailValue(pullRequest: GithubPullRequest) {
  return {
    schema: GITHUB_CONNECTOR_SCHEMAS.pullRequest,
    formatVersion: 1,
    ...pullRequest,
  };
}

/** The stable Fabric target for current GitHub pull-request state. */
export class GithubFabricTarget {
  readonly conn: GithubFabricConnection;
  readonly cells: GithubFabricCells;
  readonly source: GithubConnectorSource;
  readonly #writeGraph: GithubFabricWriter;
  readonly #mutations = new GithubSerialQueue();

  private constructor(
    conn: GithubFabricConnection,
    cells: GithubFabricCells,
    source: GithubConnectorSource,
    writeGraph: GithubFabricWriter,
  ) {
    this.conn = conn;
    this.cells = cells;
    this.source = source;
    this.#writeGraph = writeGraph;
  }

  /** Open and synchronize the connector's root cells. */
  static async open(
    conn: GithubFabricConnection,
    source: GithubConnectorSource,
    writeGraph: GithubFabricWriter = writeGithubFabricCells,
  ): Promise<GithubFabricTarget> {
    if (/\r|\n/.test(source.host) || /\r|\n/.test(source.account)) {
      throw new Error("GitHub connector source must not contain line breaks");
    }
    const normalizedSource = {
      host: source.host.trim().toLowerCase(),
      account: source.account.trim().toLowerCase(),
    };
    if (!normalizedSource.host || !normalizedSource.account) {
      throw new Error("GitHub connector source must name a host and account");
    }
    const causes = githubFabricCauses(conn.spaceDid, normalizedSource);
    const cells = {
      index: conn.runtime.getCell(conn.spaceDid, causes.index),
      health: conn.runtime.getCell(conn.spaceDid, causes.health),
    };
    await Promise.all([cells.index.sync(), cells.health.sync()]);
    await conn.runtime.storageManager.synced();
    return new GithubFabricTarget(conn, cells, normalizedSource, writeGraph);
  }

  /** Publish one complete collection, with the index committed last. */
  publish(
    collection: GithubPullRequestCollection,
  ): Promise<GithubLastCompleteCollection> {
    return this.#mutations.run(() => this.#publish(collection));
  }

  async #publish(
    collection: GithubPullRequestCollection,
  ): Promise<GithubLastCompleteCollection> {
    if (collection.viewer.toLowerCase() !== this.source.account) {
      throw new Error(
        `GitHub viewer ${collection.viewer} does not match configured account ${this.source.account}`,
      );
    }
    const prior = await readGithubFabricCell(this.conn, this.cells.index);
    const generation = previousGeneration(prior) + 1;
    const rows = collection.pullRequests.map((pullRequest) => {
      const cell = this.conn.runtime.getCell(
        this.conn.spaceDid,
        pullRequestCause(
          this.conn.spaceDid,
          this.source,
          pullRequest,
        ),
      );
      return { pullRequest, cell };
    });
    for (
      let offset = 0;
      offset < rows.length;
      offset += DETAIL_PUBLICATION_BATCH_SIZE
    ) {
      await this.#writeGraph(
        this.conn,
        rows.slice(offset, offset + DETAIL_PUBLICATION_BATCH_SIZE).map(
          ({ pullRequest, cell }) => graphEntry(cell, detailValue(pullRequest)),
        ),
      );
    }
    const completedAt = new Date().toISOString();
    const index: GithubPullRequestIndex = {
      schema: GITHUB_CONNECTOR_SCHEMAS.pullRequestIndex,
      formatVersion: 1,
      viewer: collection.viewer,
      generatedAt: completedAt,
      lastCompleteCollectionAt: collection.observedAt,
      generation,
      pullRequests: rows
        .map(({ pullRequest, cell }) => ({
          ...pullRequest,
          detail: cell.getAsLink(),
        }))
        .sort((left, right) =>
          left.repository.localeCompare(right.repository) ||
          left.number - right.number
        ),
    };
    await this.#writeGraph(
      this.conn,
      [graphEntry(this.cells.index, index)],
    );
    return { completedAt, pullRequestCount: rows.length };
  }

  /** Read the pull requests retained by the last complete generation. */
  async readPullRequests(): Promise<GithubPullRequest[]> {
    const value = await readGithubFabricCell(this.conn, this.cells.index);
    if (value === undefined || value === null) return [];
    previousGeneration(value);
    if (
      !isRecord(value) || value.formatVersion !== 1 ||
      !Array.isArray(value.pullRequests) ||
      typeof value.viewer !== "string" ||
      value.viewer.toLowerCase() !== this.source.account
    ) {
      throw new Error("GitHub pull-request index has an invalid shape");
    }
    return value.pullRequests.map((row, index) => {
      if (!isRecord(row)) {
        throw new Error(`GitHub pull-request row is invalid: ${index}`);
      }
      return storedPullRequest(row, index);
    });
  }

  /** Read durable metadata for the last complete collection. */
  async readLastComplete(): Promise<GithubLastCompleteCollection | undefined> {
    const value = await readGithubFabricCell(this.conn, this.cells.index);
    if (value === undefined || value === null) return undefined;
    previousGeneration(value);
    if (
      !isRecord(value) || value.formatVersion !== 1 ||
      typeof value.generatedAt !== "string" ||
      typeof value.lastCompleteCollectionAt !== "string" ||
      !Array.isArray(value.pullRequests) ||
      typeof value.viewer !== "string" ||
      value.viewer.toLowerCase() !== this.source.account
    ) {
      throw new Error("GitHub pull-request index has an invalid shape");
    }
    return {
      completedAt: value.generatedAt,
      pullRequestCount: value.pullRequests.length,
    };
  }

  /** Publish host health without changing the last complete PR index. */
  publishHealth(value: object): Promise<void> {
    return this.#mutations.run(() =>
      this.#writeGraph(
        this.conn,
        [
          graphEntry(this.cells.health, {
            ...value,
            schema: GITHUB_CONNECTOR_SCHEMAS.health,
          }),
        ],
      )
    );
  }

  /** Return the stable index cell identifier for deployment and consumers. */
  indexCellId(): string {
    return githubFabricCellId(this.cells.index);
  }

  /** Return the stable health cell identifier for deployment and consumers. */
  healthCellId(): string {
    return githubFabricCellId(this.cells.health);
  }
}
