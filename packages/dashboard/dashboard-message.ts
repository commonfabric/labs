/**
 * Holds the one short message anyone at the dashboard can leave on it, and the
 * store that keeps that message across dashboard restarts. A message stays
 * fully visible for a while, then fades out linearly and expires, so a note
 * left about a broken build clears itself rather than growing stale on the
 * dashboard. Each save carries a revision, which is how a page that has been
 * open across someone else's edit tells its own text from theirs.
 */

import { dashboardCacheFile } from "./history-files.ts";

/** The period during which a saved message remains fully visible. */
export const DASHBOARD_MESSAGE_VISIBLE_MS = 2 * 60 * 60 * 1_000;

/** The linear fade period after the fully visible period. */
export const DASHBOARD_MESSAGE_FADE_MS = 4 * 60 * 60 * 1_000;

/** The total time from saving a message until it expires. */
export const DASHBOARD_MESSAGE_LIFETIME_MS = DASHBOARD_MESSAGE_VISIBLE_MS +
  DASHBOARD_MESSAGE_FADE_MS;

/** The largest message accepted by the shared editor. */
export const DASHBOARD_MESSAGE_MAX_LENGTH = 500;

/** The dashboard message and the time its current text was saved. */
export interface DashboardMessage {
  text: string;
  updatedAt: number | null;
  revision: number;
}

/** The result of checking the stored message at the current time. */
export interface DashboardMessageRefresh {
  message: DashboardMessage;
  expired: boolean;
}

interface StoredDashboardMessage {
  version: 1;
  text: string;
  updatedAt: number | null;
  revision?: number;
}

interface DashboardMessageStoreOptions {
  file?: string;
  now?: () => number;
  readTextFile?: typeof Deno.readTextFile;
  writeTextFile?: typeof Deno.writeTextFile;
  rename?: typeof Deno.rename;
}

const emptyMessage = (revision = 0): DashboardMessage => ({
  text: "",
  updatedAt: null,
  revision,
});

function isStoredDashboardMessage(
  value: unknown,
): value is StoredDashboardMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as StoredDashboardMessage;
  return message.version === 1 &&
    typeof message.text === "string" &&
    message.text.length <= DASHBOARD_MESSAGE_MAX_LENGTH &&
    (message.revision === undefined ||
      (typeof message.revision === "number" &&
        Number.isSafeInteger(message.revision) && message.revision >= 0)) &&
    ((message.text === "" && message.updatedAt === null) ||
      (message.text !== "" && Number.isFinite(message.updatedAt) &&
        Number.isInteger(message.updatedAt) && message.updatedAt! >= 0));
}

/** Returns the message opacity at a given wall-clock time. */
export function dashboardMessageOpacity(
  updatedAt: number,
  now: number,
  visibleMs = DASHBOARD_MESSAGE_VISIBLE_MS,
  fadeMs = DASHBOARD_MESSAGE_FADE_MS,
): number {
  const fadeAge = Math.max(0, now - updatedAt - visibleMs);
  return Math.max(0, 1 - fadeAge / fadeMs);
}

/** Normalizes text accepted by the shared message endpoint. */
export function normalizeDashboardMessageText(text: string): string {
  const normalized = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (normalized.length > DASHBOARD_MESSAGE_MAX_LENGTH) {
    throw new RangeError(
      `Dashboard messages are limited to ${DASHBOARD_MESSAGE_MAX_LENGTH} characters.`,
    );
  }
  return normalized;
}

/** Stores the shared dashboard message and expires it after its fade completes. */
export class DashboardMessageStore {
  readonly #file: string;
  readonly #now: () => number;
  readonly #readTextFile: typeof Deno.readTextFile;
  readonly #writeTextFile: typeof Deno.writeTextFile;
  readonly #rename: typeof Deno.rename;
  #message = emptyMessage();
  #loaded = false;
  #operation = Promise.resolve();

  constructor(options: DashboardMessageStoreOptions = {}) {
    this.#file = options.file ??
      dashboardCacheFile("fabric-wall-message.json");
    this.#now = options.now ?? (() => Date.now());
    this.#readTextFile = options.readTextFile ?? Deno.readTextFile;
    this.#writeTextFile = options.writeTextFile ?? Deno.writeTextFile;
    this.#rename = options.rename ?? Deno.rename;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operation;
    let release = () => {};
    this.#operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    let stored: unknown;
    try {
      stored = JSON.parse(await this.#readTextFile(this.#file));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        this.#loaded = true;
        return;
      }
      throw new Error(
        `Could not load the dashboard message: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (!isStoredDashboardMessage(stored)) {
      throw new Error("Could not load the dashboard message: invalid stored data.");
    }
    this.#message = {
      text: stored.text,
      updatedAt: stored.updatedAt,
      revision: stored.revision ?? 0,
    };
    this.#loaded = true;
  }

  async #save(): Promise<void> {
    const temporary = `${this.#file}.tmp`;
    const stored: StoredDashboardMessage & { revision: number } = {
      version: 1,
      ...this.#message,
    };
    try {
      await this.#writeTextFile(temporary, JSON.stringify(stored));
      await this.#rename(temporary, this.#file);
    } catch (error) {
      throw new Error(
        `Could not save the dashboard message: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  /** Returns the current message and clears one whose fade has completed. */
  refresh(): Promise<DashboardMessageRefresh> {
    return this.#run(async () => {
      await this.#load();
      const updatedAt = this.#message.updatedAt;
      const expired = updatedAt !== null &&
        this.#now() - updatedAt >= DASHBOARD_MESSAGE_LIFETIME_MS;
      if (expired) {
        const previous = this.#message;
        this.#message = emptyMessage(previous.revision + 1);
        try {
          await this.#save();
        } catch (error) {
          this.#message = previous;
          throw error;
        }
      }
      return { message: { ...this.#message }, expired };
    });
  }

  /** Replaces the current message and starts its visible period. */
  set(text: string): Promise<DashboardMessage> {
    return this.#run(async () => {
      await this.#load();
      const normalized = normalizeDashboardMessageText(text);
      const previous = this.#message;
      this.#message = normalized === ""
        ? emptyMessage(previous.revision + 1)
        : {
          text: normalized,
          updatedAt: this.#now(),
          revision: previous.revision + 1,
        };
      try {
        await this.#save();
      } catch (error) {
        this.#message = previous;
        throw error;
      }
      return { ...this.#message };
    });
  }
}
