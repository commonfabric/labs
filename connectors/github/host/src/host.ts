import type { GithubClient } from "@commonfabric/github-connector/client";
import type { GithubFabricTarget } from "@commonfabric/github-connector/fabric";

export type GithubHostStatus =
  | "starting"
  | "syncing"
  | "ready"
  | "degraded"
  | "stopped";

export interface GithubHostHealth {
  service: "github-host";
  formatVersion: 1;
  status: GithubHostStatus;
  startedAt: string;
  updatedAt: string;
  target: {
    spaceDid: string;
    cells: { index: string; health: string };
  };
  sync?: {
    reason: string;
    status: "running" | "complete" | "failed";
    startedAt: string;
    completedAt?: string;
    pullRequestCount?: number;
    error?: string;
  };
  lastComplete?: {
    completedAt: string;
    pullRequestCount: number;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Coordinates complete GitHub collections and health publication. */
export class GithubHost {
  readonly #client: GithubClient;
  readonly #target: GithubFabricTarget;
  readonly #spaceDid: string;
  readonly #clock: () => Date;
  readonly #startedAt: string;
  #status: GithubHostStatus = "starting";
  #sync?: GithubHostHealth["sync"];
  #lastComplete?: GithubHostHealth["lastComplete"];
  #syncTail: Promise<void> = Promise.resolve();

  /** Create a host for one GitHub account and Fabric destination. */
  constructor(options: {
    client: GithubClient;
    target: GithubFabricTarget;
    spaceDid: string;
    clock?: () => Date;
  }) {
    this.#client = options.client;
    this.#target = options.target;
    this.#spaceDid = options.spaceDid;
    this.#clock = options.clock ?? (() => new Date());
    this.#startedAt = this.#now();
  }

  /** Return a copy of the health record most recently derived by the host. */
  health(): GithubHostHealth {
    return structuredClone({
      service: "github-host",
      formatVersion: 1,
      status: this.#status,
      startedAt: this.#startedAt,
      updatedAt: this.#now(),
      target: {
        spaceDid: this.#spaceDid,
        cells: {
          index: this.#target.indexCellId(),
          health: this.#target.healthCellId(),
        },
      },
      ...(this.#sync ? { sync: this.#sync } : {}),
      ...(this.#lastComplete ? { lastComplete: this.#lastComplete } : {}),
    });
  }

  /** Publish initial health before the first GitHub request. */
  async start(): Promise<void> {
    this.#lastComplete = await this.#target.readLastComplete();
    await this.#target.publishHealth(this.health());
  }

  /** Schedule a complete collection after any collection already in flight. */
  synchronize(reason: string, signal?: AbortSignal): Promise<number> {
    const result = this.#syncTail.then(
      () => this.#synchronize(reason, signal),
      () => this.#synchronize(reason, signal),
    );
    this.#syncTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #synchronize(reason: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const startedAt = this.#now();
    this.#status = "syncing";
    this.#sync = { reason, status: "running", startedAt };
    await this.#target.publishHealth(this.health());
    try {
      const previous = await this.#target.readPullRequests();
      const collection = await this.#client.collectOpenPullRequests(
        signal,
        previous,
      );
      signal?.throwIfAborted();
      const lastComplete = await this.#target.publish(collection);
      this.#status = "ready";
      this.#sync = {
        reason,
        status: "complete",
        startedAt,
        ...lastComplete,
      };
      this.#lastComplete = lastComplete;
      await this.#target.publishHealth(this.health());
      return lastComplete.pullRequestCount;
    } catch (error) {
      this.#status = "degraded";
      this.#sync = {
        reason,
        status: "failed",
        startedAt,
        completedAt: this.#now(),
        error: errorMessage(error),
      };
      try {
        await this.#target.publishHealth(this.health());
      } catch (healthError) {
        throw new AggregateError(
          [error, healthError],
          "GitHub collection and health publication failed",
        );
      }
      throw error;
    }
  }

  /** Publish stopped health after all requested collections have settled. */
  async stop(): Promise<void> {
    await this.#syncTail;
    this.#status = "stopped";
    await this.#target.publishHealth(this.health());
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}
