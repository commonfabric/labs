#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net

/**
 * Mints a personal test-records key. Runs inside the dispatch-gated minting
 * workflow with the broker's federated token: dispatching a workflow takes
 * write access to the repository, so the ability to trigger it is the
 * authorization check. The workflow creates or revives the person's service
 * account, creates their submissions/local/<username>/ folders with a
 * create-only grant, mints one key, and publishes it sealed to the
 * requester's delivery recipient as a workflow artifact named by the
 * recipient's fingerprint.
 *
 *   deno run -A tasks/test-records-mint.ts --recipient <string>
 *     --username <github-login> --out <dir>
 */

import { join } from "@std/path";
import { toLongQuotedDebugString } from "@commonfabric/data-model";
import { readEnv } from "@commonfabric/test-support/records";
import {
  isRecipient,
  recipientFingerprint,
  seal,
} from "./test-records-crypto.ts";
import {
  DATASET_PREFIXES,
  GCP_PROJECT,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";

/**
 * GitHub login rules: up to 39 characters, alphanumeric or hyphen, no
 * leading, trailing, or doubled hyphen.
 */
export function isGitHubUsername(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(name);
}

const ACCOUNT_PREFIX = "test-records-gh-";
const ACCOUNT_ID_LIMIT = 30;

/**
 * The service-account id for a username: test-records-gh-<username>
 * lowercased when it fits the 30-character account-id limit, and a
 * truncation with a six-digit digest suffix when it does not, so long
 * usernames stay deterministic and distinct. The display name always
 * carries the full username.
 */
export async function accountIdFor(username: string): Promise<string> {
  const lowered = username.toLowerCase();
  const plain = ACCOUNT_PREFIX + lowered;
  if (plain.length <= ACCOUNT_ID_LIMIT && !plain.endsWith("-")) return plain;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lowered)),
  );
  const suffix = Array.from(digest.subarray(0, 3))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const room = ACCOUNT_ID_LIMIT - ACCOUNT_PREFIX.length - suffix.length - 1;
  const head = lowered.slice(0, room).replace(/-+$/, "");
  return `${ACCOUNT_PREFIX}${head}-${suffix}`;
}

/** The display name the janitor reads the full username back from. */
export function displayNameFor(username: string): string {
  return `Test records key holder: ${username}`;
}

/** The username a display name carries, when it is one of ours. */
export function usernameOfDisplayName(displayName: string): string | undefined {
  const match = displayName.match(/^Test records key holder: (.+)$/);
  return match?.[1];
}

export interface GcpClient {
  token: string;
  fetchImpl: typeof fetch;

  /**
   * Waits out the window in which a just-created service account is not
   * yet visible to the other services that name it. Tests pass a no-op.
   */
  awaitVisibility?: () => Promise<void>;
}

/** How long a create is given to reach the services that consume it. */
const VISIBILITY_INTERVAL_MS = 5_000;

function awaitVisibility(client: GcpClient): Promise<void> {
  if (client.awaitVisibility !== undefined) return client.awaitVisibility();
  return new Promise((resolve) => setTimeout(resolve, VISIBILITY_INTERVAL_MS));
}

async function gcp(
  client: GcpClient,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await client.fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${client.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const IAM = "https://iam.googleapis.com/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";

/** Creates or revives the account; returns its email. */
export async function ensureServiceAccount(
  client: GcpClient,
  username: string,
): Promise<string> {
  const accountId = await accountIdFor(username);
  const email = `${accountId}@${GCP_PROJECT}.iam.gserviceaccount.com`;
  const got = await gcp(
    client,
    "GET",
    `${IAM}/projects/${GCP_PROJECT}/serviceAccounts/${email}`,
  );
  if (got.status === 404) {
    const created = await gcp(
      client,
      "POST",
      `${IAM}/projects/${GCP_PROJECT}/serviceAccounts`,
      {
        accountId,
        serviceAccount: { displayName: displayNameFor(username) },
      },
    );
    if (created.status !== 200) {
      throw new Error(
        `creating ${email} failed: HTTP ${created.status} ${
          toLongQuotedDebugString(created.json)
        }`,
      );
    }
    return email;
  }
  if (got.status !== 200) {
    throw new Error(`reading ${email} failed: HTTP ${got.status}`);
  }
  const account = got.json as { disabled?: boolean };
  if (account.disabled === true) {
    const enabled = await gcp(
      client,
      "POST",
      `${IAM}/projects/${GCP_PROJECT}/serviceAccounts/${email}:enable`,
      {},
    );
    if (enabled.status !== 200) {
      throw new Error(`enabling ${email} failed: HTTP ${enabled.status}`);
    }
  }
  return email;
}

/**
 * Creates the person's folder under one dataset prefix and grants their
 * account create-only access to it.
 */
export async function ensurePersonFolder(
  client: GcpClient,
  bucket: string,
  prefix: string,
  username: string,
  email: string,
): Promise<void> {
  const folder = `${prefix}/submissions/local/${username}/`;
  const created = await gcp(
    client,
    "POST",
    `${STORAGE}/b/${encodeURIComponent(bucket)}/managedFolders`,
    { name: folder },
  );
  if (created.status !== 200 && created.status !== 409) {
    throw new Error(
      `creating folder ${folder} failed: HTTP ${created.status} ${
        toLongQuotedDebugString(created.json)
      }`,
    );
  }
  const iamUrl = `${STORAGE}/b/${encodeURIComponent(bucket)}/managedFolders/${
    encodeURIComponent(folder)
  }/iam`;
  const policyRes = await gcp(client, "GET", iamUrl);
  if (policyRes.status !== 200) {
    throw new Error(
      `reading IAM of ${folder} failed: HTTP ${policyRes.status}`,
    );
  }
  const policy = policyRes.json as {
    bindings?: { role: string; members: string[] }[];
    etag?: string;
  };
  const member = `serviceAccount:${email}`;
  const role = "roles/storage.objectCreator";
  const bindings = policy.bindings ?? [];
  const binding = bindings.find((candidate) => candidate.role === role);
  if (binding !== undefined && binding.members.includes(member)) return;
  if (binding !== undefined) {
    binding.members.push(member);
  } else {
    bindings.push({ role, members: [member] });
  }
  // An account exists in IAM the moment its create returns, and reaches
  // the services that consume it some time after that: Cloud Storage
  // rejects a binding naming an account it has not seen yet, saying the
  // account does not exist. That answer is the signal to wait, and it is
  // the only one this loop accepts — every other status fails the mint.
  // The wait has no bound, because the account does exist and the grant
  // is going to work; only the moment is out of the caller's hands.
  for (;;) {
    const updated = await gcp(client, "PUT", iamUrl, {
      bindings,
      etag: policy.etag,
    });
    if (updated.status === 200) return;
    if (!isAccountNotVisible(updated.status, updated.json, email)) {
      throw new Error(
        `granting ${role} on ${folder} failed: HTTP ${updated.status} ${
          toLongQuotedDebugString(updated.json)
        }`,
      );
    }
    console.log(`${email} has not reached Cloud Storage yet; waiting`);
    await awaitVisibility(client);
  }
}

/**
 * Whether a response is a service the account has not propagated to yet,
 * which answers a binding that names it as though it did not exist.
 */
export function isAccountNotVisible(
  status: number,
  json: unknown,
  email: string,
): boolean {
  if (status !== 400 && status !== 404) return false;
  const text = typeof json === "string" ? json : JSON.stringify(json ?? "");
  return text.includes(email) && text.includes("does not exist");
}

/**
 * Mints one key and returns the key file JSON with cf_username added.
 * Every user-managed key the account held is revoked before the new one
 * is created: a person holds one live key, so re-requesting rotates, and
 * a lost or compromised key stops working as early as it can rather than
 * as late as it can.
 *
 * Revoking first is also what makes a failure part way through leave
 * nothing behind. A mint that fails after creating a key would leave one
 * nobody holds, live, counting against the ten a service account may
 * have and visible to no one. A revoke that fails leaves the person with
 * the key they already had, and a mint that fails after revoking leaves
 * them with none — which their next test run tells them, and which
 * running the setup command again fixes.
 */
export async function mintKey(
  client: GcpClient,
  email: string,
  username: string,
): Promise<string> {
  const account = `${IAM}/projects/${GCP_PROJECT}/serviceAccounts/${email}`;
  const before = await gcp(
    client,
    "GET",
    `${account}/keys?keyTypes=USER_MANAGED`,
  );
  if (before.status !== 200) {
    throw new Error(
      `listing the keys of ${email} failed: HTTP ${before.status}`,
    );
  }
  const superseded = ((before.json as { keys?: { name?: string }[] })
    .keys ?? [])
    .map((key) => key.name)
    .filter((name): name is string => typeof name === "string");

  for (const name of superseded) {
    const deleted = await gcp(client, "DELETE", `${IAM}/${name}`);
    if (deleted.status !== 200) {
      throw new Error(
        `revoking the superseded key ${name} failed: HTTP ${deleted.status}` +
          (deleted.status === 403
            ? "; the broker's role is missing " +
              "iam.serviceAccountKeys.delete, without which no key can be " +
              "rotated (infra: tofu/test-records)"
            : ""),
      );
    }
  }

  const minted = await gcp(client, "POST", `${account}/keys`, {});
  if (minted.status !== 200) {
    throw new Error(
      `minting a key for ${email} failed: HTTP ${minted.status} ${
        toLongQuotedDebugString(minted.json)
      }`,
    );
  }
  const keyData = (minted.json as { privateKeyData?: string }).privateKeyData;
  if (keyData === undefined) {
    throw new Error("the key response carried no privateKeyData");
  }

  const decoded = atob(keyData);
  const keyFile = JSON.parse(decoded) as Record<string, unknown>;
  keyFile.cf_username = username;
  return JSON.stringify(keyFile, null, 2) + "\n";
}

function usage(): never {
  console.error(
    "usage: test-records-mint.ts --recipient <string> " +
      "--username <github-login> --out <dir>",
  );
  Deno.exit(2);
}

export interface MintRunOptions {
  recipient: string;
  username: string;
  out: string;
  client: GcpClient;

  /** GITHUB_OUTPUT file to append the fingerprint line to, when set. */
  githubOutput?: string;
}

/**
 * The whole minting run: validates the inputs, provisions the account and
 * folders, mints the rotated key, and writes the sealed delivery. Returns
 * the path of the sealed file.
 */
export async function runMint(options: MintRunOptions): Promise<string> {
  const { recipient, out, client } = options;
  if (!isRecipient(recipient)) {
    throw new Error(
      "the recipient input is not a cfr1 delivery recipient; " +
        "generate one with: deno task test-records-key request",
    );
  }
  if (!isGitHubUsername(options.username)) {
    throw new Error(`not a GitHub username: ${options.username}`);
  }
  // GitHub logins are case-insensitive, so the login is canonicalized to
  // lowercase before it names anything: the account id, the folder, the
  // display name, and the key's cf_username all agree however the person
  // typed it into the dispatch form.
  const username = options.username.toLowerCase();
  if (!DATASET_PREFIXES.includes(storePrefix())) {
    throw new Error(
      `the configured store prefix ${storePrefix()} is not in ` +
        "DATASET_PREFIXES; a key minted now could not write where " +
        "uploads go",
    );
  }

  const email = await ensureServiceAccount(client, username);
  console.log(`service account: ${email}`);
  const bucket = storeBucket();
  for (const prefix of DATASET_PREFIXES) {
    await ensurePersonFolder(client, bucket, prefix, username, email);
    console.log(`folder ready: ${prefix}/submissions/local/${username}/`);
  }
  const keyFile = await mintKey(client, email, username);
  const sealed = await seal(recipient, new TextEncoder().encode(keyFile));
  const fingerprint = await recipientFingerprint(recipient);
  await Deno.mkdir(out, { recursive: true });
  const path = join(out, `test-records-key-${fingerprint}.sealed`);
  await Deno.writeTextFile(path, JSON.stringify(sealed) + "\n");
  console.log(`sealed delivery written: ${path}`);
  if (options.githubOutput !== undefined && options.githubOutput.length > 0) {
    await Deno.writeTextFile(
      options.githubOutput,
      `fingerprint=${fingerprint}\n`,
      { append: true },
    );
  }
  return path;
}

/** Parses the command line; undefined means a malformed one. */
export function parseMintArgs(
  argsIn: readonly string[],
): { recipient: string; username: string; out: string } | undefined {
  let recipient: string | undefined;
  let username: string | undefined;
  let out: string | undefined;
  const args = [...argsIn];
  while (args.length > 0) {
    const flag = args.shift()!;
    const value = args.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--recipient":
        recipient = value.trim();
        break;
      case "--username":
        username = value.trim();
        break;
      case "--out":
        out = value;
        break;
      default:
        return undefined;
    }
  }
  if (recipient === undefined || username === undefined || out === undefined) {
    return undefined;
  }
  return { recipient, username, out };
}

async function main(): Promise<void> {
  const parsed = parseMintArgs(Deno.args);
  if (parsed === undefined) usage();
  const token = readEnv("TEST_RECORDS_GCP_TOKEN");
  if (token === undefined || token.length === 0) {
    throw new Error("TEST_RECORDS_GCP_TOKEN is not set");
  }
  const runOptions: MintRunOptions = {
    ...parsed,
    client: { token, fetchImpl: fetch },
  };
  const githubOutput = readEnv("GITHUB_OUTPUT");
  if (githubOutput !== undefined) runOptions.githubOutput = githubOutput;
  await runMint(runOptions);
}

if (import.meta.main) {
  await main();
}
