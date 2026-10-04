#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

/**
 * The activity lease. A key's validity window cannot be extended, so the
 * one-month lifetime is enforced here instead of by key expiry: daily, with
 * the broker's federated identity, this reads each key holder's recent
 * pull-request activity from the public GitHub API, disables the service
 * accounts of people with none in the past month, and re-enables accounts
 * whose people are active again. A disabled account's key file goes inert,
 * not destroyed; the next pull request revives it with nothing to
 * re-download. Renewal is not an act anyone performs.
 *
 * Failure direction: an error reading a holder's activity, or the GitHub
 * API being down, skips that holder — nothing is disabled on bad data, so
 * a janitor outage locks nobody out.
 */

import { readEnv } from "@commonfabric/test-support/records";
import { GCP_PROJECT, REPO } from "./test-records-config.ts";
import { usernameOfDisplayName } from "./test-records-mint.ts";

/** Repositories whose pull-request activity keeps a lease alive. */
export const LEASE_REPOSITORIES = [REPO];

/** Days of inactivity after which an account is disabled. */
export const LEASE_DAYS = 30;

/** What to do with one account, given its state and its holder's activity. */
export function leaseAction(
  state: { disabled: boolean; active: boolean },
): "enable" | "disable" | "none" {
  if (state.active && state.disabled) return "enable";
  if (!state.active && !state.disabled) return "disable";
  return "none";
}

export interface KeyHolderAccount {
  email: string;
  username: string;
  disabled: boolean;
}

/** The key-holder accounts among a service-account listing. */
export function keyHolderAccounts(
  accounts: readonly {
    email?: string;
    displayName?: string;
    disabled?: boolean;
  }[],
): KeyHolderAccount[] {
  const holders: KeyHolderAccount[] = [];
  for (const account of accounts) {
    if (account.email === undefined) continue;
    if (!account.email.startsWith("test-records-gh-")) continue;
    const username = usernameOfDisplayName(account.displayName ?? "");
    if (username === undefined) continue;
    holders.push({
      email: account.email,
      username,
      disabled: account.disabled === true,
    });
  }
  return holders;
}

interface Clients {
  gcpToken: string;
  githubToken?: string;
  fetchImpl: typeof fetch;
}

const IAM = "https://iam.googleapis.com/v1";

async function listServiceAccounts(clients: Clients): Promise<unknown[]> {
  const accounts: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${IAM}/projects/${GCP_PROJECT}/serviceAccounts`);
    url.searchParams.set("pageSize", "100");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const res = await clients.fetchImpl(url, {
      headers: { authorization: `Bearer ${clients.gcpToken}` },
    });
    if (!res.ok) {
      throw new Error(`listing service accounts failed: HTTP ${res.status}`);
    }
    const page = await res.json() as {
      accounts?: unknown[];
      nextPageToken?: string;
    };
    for (const account of page.accounts ?? []) accounts.push(account);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return accounts;
}

/**
 * Whether a person has pull-request activity in the lease window. Returns
 * undefined when the answer cannot be read, which the caller treats as
 * "leave the account alone".
 */
export async function hasRecentActivity(
  clients: Clients,
  username: string,
  since: string,
): Promise<boolean | undefined> {
  const repos = LEASE_REPOSITORIES.map((repo) => `repo:${repo}`).join(" ");
  const query = `${repos} type:pr author:${username} updated:>=${since}`;
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "1");
  try {
    const res = await clients.fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        ...(clients.githubToken !== undefined
          ? { authorization: `Bearer ${clients.githubToken}` }
          : {}),
      },
    });
    if (!res.ok) {
      console.warn(
        `janitor: activity lookup for ${username} failed: HTTP ${res.status}`,
      );
      return undefined;
    }
    const result = await res.json() as {
      total_count?: number;
      incomplete_results?: boolean;
    };
    if (typeof result.total_count !== "number") return undefined;
    // A search that timed out reports what it found so far; a partial
    // zero is not evidence of inactivity, so it reads as unknown.
    if (result.incomplete_results === true && result.total_count === 0) {
      return undefined;
    }
    return result.total_count > 0;
  } catch (error) {
    console.warn(`janitor: activity lookup for ${username} failed: ${error}`);
    return undefined;
  }
}

async function setAccountEnabled(
  clients: Clients,
  email: string,
  enabled: boolean,
): Promise<void> {
  const verb = enabled ? "enable" : "disable";
  const res = await clients.fetchImpl(
    `${IAM}/projects/${GCP_PROJECT}/serviceAccounts/${email}:${verb}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${clients.gcpToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  if (!res.ok) {
    throw new Error(`${verb} of ${email} failed: HTTP ${res.status}`);
  }
}

export async function runJanitor(clients: Clients): Promise<void> {
  const since = new Date(Date.now() - LEASE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const holders = keyHolderAccounts(
    await listServiceAccounts(clients) as Parameters<
      typeof keyHolderAccounts
    >[0],
  );
  console.log(
    `janitor: ${holders.length} key holder(s); lease window since ${since}`,
  );
  for (const holder of holders) {
    const active = await hasRecentActivity(clients, holder.username, since);
    if (active === undefined) {
      console.log(`janitor: ${holder.username}: activity unknown, skipped`);
      continue;
    }
    const action = leaseAction({ disabled: holder.disabled, active });
    if (action === "none") {
      console.log(
        `janitor: ${holder.username}: ${
          active ? "active" : "inactive"
        }, nothing to change`,
      );
      continue;
    }
    await setAccountEnabled(clients, holder.email, action === "enable");
    console.log(`janitor: ${holder.username}: ${action}d ${holder.email}`);
  }
}

async function main(): Promise<void> {
  const gcpToken = readEnv("TEST_RECORDS_GCP_TOKEN");
  if (gcpToken === undefined || gcpToken.length === 0) {
    throw new Error("TEST_RECORDS_GCP_TOKEN is not set");
  }
  const clients: Clients = { gcpToken, fetchImpl: fetch };
  const githubToken = readEnv("GH_TOKEN") ?? readEnv("GITHUB_TOKEN");
  if (githubToken !== undefined && githubToken.length > 0) {
    clients.githubToken = githubToken;
  }
  await runJanitor(clients);
}

if (import.meta.main) {
  await main();
}
