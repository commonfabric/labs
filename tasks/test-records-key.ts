#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run=gh

/**
 * The personal key tool, in one command that finishes the job and two that
 * split it.
 *
 *   deno task test-records-key setup
 *     Generates a delivery identity, dispatches the minting workflow —
 *     or prints the page to run it in a browser, which is the supported
 *     minimum of a read-only token — then watches until the run delivers,
 *     installs the key, and exports it from the login shell's profiles.
 *     It waits as long as the run takes and stops on Ctrl-C; running it
 *     again resumes from wherever it got to. Pass --rotate to mint a
 *     replacement for a key that is already installed.
 *
 *   deno task test-records-key request
 *     The first half alone: store the identity and dispatch the workflow.
 *
 *   deno task test-records-key collect
 *     The second half alone: install the delivery of a finished run.
 *
 *   deno task test-records-key uninstall
 *     Takes back everything setup put on the workstation: the key, the
 *     delivery identity, and the export it added to the profiles.
 *
 * With commit access every part is self-service. Without it, a team member
 * dispatches the minting workflow with the requester's recipient and login,
 * and the requester's own command collects the delivery as usual.
 */

import { join } from "@std/path";
import {
  defaultSpoolRoot,
  type Environment,
  readEnv,
  RECORDS_KEY_FILE_VARIABLE,
  saAssertion,
  STORE_WRITE_SCOPE,
} from "@commonfabric/test-support/records";
import {
  generateIdentity,
  type KeyDeliveryIdentity,
  open as openSealed,
  recipientFingerprint,
  type SealedBox,
} from "./test-records-crypto.ts";
import {
  MINT_WORKFLOW_FILE,
  parsePersonalKeyFile,
  type PersonalKeyFile,
  REPO,
} from "./test-records-config.ts";
import { readZip } from "./test-records-zip.ts";
import {
  type AgentConfigRemoval,
  type AgentConfigUpdate,
  exportFromAgentConfigs,
  unexportFromAgentConfigs,
} from "./test-records-agent-config.ts";
import {
  exportFromProfiles,
  exportLine,
  type ProfileUpdate,
  reloadHint,
  shellKind,
  unexportFromProfiles,
} from "./test-records-shell-config.ts";

const API = "https://api.github.com";

/** How often the watch asks GitHub what the minting run is doing. */
const POLL_INTERVAL_MS = 5_000;

/** Runs per listing page; a hundred is what the API will serve. */
const RUNS_PER_PAGE = 100;

/**
 * How far back a search looks when nothing narrower bounds it. A
 * delivery artifact is kept for seven days, and the extra day covers the
 * two clocks disagreeing.
 */
const DELIVERY_WINDOW_MS = 8 * 24 * 60 * 60 * 1_000;

/**
 * A failure whose message is the whole report. Everything a person can
 * hit — no token, a refused dispatch, a run that failed, a delivery that
 * expired — is raised as one of these and printed as a message; anything
 * else keeps its stack, because a stack is the report for a bug in this
 * tool.
 */
export class KeyToolError extends Error {
  override name = "KeyToolError";
}

/** What the two commands reach outside the process through, injectable so
 * tests run them against stubs. */
export interface KeyToolDeps {
  env: Environment;
  fetchImpl: typeof fetch;
  githubToken: () => Promise<string | undefined>;

  /** Waits out one polling interval. */
  pause: () => Promise<void>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a command for its output; injectable so tests run no commands. */
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: Uint8Array }>;

const runCommand: CommandRunner = async (command, args) => {
  const { code, stdout } = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "null",
  }).output();
  return { code, stdout };
};

/**
 * The GitHub token to work with: the environment's, and otherwise
 * whatever the `gh` command line is signed in as. A machine with
 * neither has no token, which each command reports in its own terms.
 */
export function defaultGithubToken(
  env: Environment = Deno.env.get,
  run: CommandRunner = runCommand,
): Promise<string | undefined> {
  return (async () => {
    const fromEnv = readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env);
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    try {
      const { code, stdout } = await run("gh", ["auth", "token"]);
      if (code !== 0) return undefined;
      const token = new TextDecoder().decode(stdout).trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  })();
}

/** The wiring the command line runs against. */
export function defaultDeps(): KeyToolDeps {
  return {
    env: Deno.env.get,
    fetchImpl: fetch,
    githubToken: () => defaultGithubToken(),
    pause: () =>
      new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)),
  };
}

function configDir(env: Environment): string {
  const xdg = readEnv("XDG_CONFIG_HOME", env);
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "common-fabric");
  }
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  if (home === undefined || home.length === 0) {
    throw new KeyToolError("Neither XDG_CONFIG_HOME nor HOME is set.");
  }
  return join(home, ".config", "common-fabric");
}

function home(env: Environment): string | undefined {
  return readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
}

function identityPath(env: Environment): string {
  return join(configDir(env), "test-records-identity.json");
}

function keyFilePath(env: Environment): string {
  return join(configDir(env), "test-records-key.json");
}

async function github(
  deps: KeyToolDeps,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await deps.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new KeyToolError(
      `Cannot reach ${API}: ${reason(error)}`,
    );
  }
}

async function loadIdentity(
  env: Environment,
): Promise<KeyDeliveryIdentity | undefined> {
  try {
    return JSON.parse(
      await Deno.readTextFile(identityPath(env)),
    ) as KeyDeliveryIdentity;
  } catch {
    return undefined;
  }
}

/** Loads the stored delivery identity, generating one the first time. */
async function ensureIdentity(
  deps: KeyToolDeps,
): Promise<KeyDeliveryIdentity> {
  const stored = await loadIdentity(deps.env);
  if (stored !== undefined) {
    console.log(`Delivery identity: ${identityPath(deps.env)}`);
    return stored;
  }
  const identity = await generateIdentity();
  await Deno.mkdir(configDir(deps.env), { recursive: true });
  await Deno.writeTextFile(
    identityPath(deps.env),
    JSON.stringify(identity, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(`Delivery identity stored: ${identityPath(deps.env)}`);
  return identity;
}

/** The GitHub login a token belongs to. */
async function githubLogin(
  deps: KeyToolDeps,
  token: string,
): Promise<string | undefined> {
  const who = await github(deps, token, "GET", "/user");
  if (!who.ok) {
    await who.text();
    return undefined;
  }
  return (await who.json() as { login?: string }).login;
}

/** The name the workflow gives this recipient's sealed delivery. */
async function deliveryName(recipient: string): Promise<string> {
  return `test-records-key-${await recipientFingerprint(recipient)}`;
}

/** Where a browser runs the minting workflow by hand. */
function mintWorkflowUrl(): string {
  return `https://github.com/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}`;
}

interface DispatchResult {
  dispatched: boolean;
  username?: string;

  /** GitHub's clock at the dispatch, which bounds the run's creation. */
  at?: number;
}

/**
 * Asks GitHub to run the minting workflow. Dispatching takes repository
 * write access — that call is the authorization check — so a token that
 * can only read comes back undispatched and the caller falls back to the
 * browser.
 */
async function dispatchMint(
  deps: KeyToolDeps,
  token: string,
  recipient: string,
  username: string,
): Promise<DispatchResult> {
  const dispatched = await github(
    deps,
    token,
    "POST",
    `/repos/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}/dispatches`,
    { ref: "main", inputs: { recipient, username } },
  );
  const at = Date.parse(dispatched.headers.get("date") ?? "");
  const body = await dispatched.text();
  const result: DispatchResult = { dispatched: dispatched.status === 204 };
  if (result.dispatched) result.username = username;
  // The clock is kept whether the dispatch was taken or refused: a run
  // that appears after this moment is this attempt's either way, and a
  // refusal is followed by the same person starting the run themselves.
  if (!Number.isNaN(at)) result.at = at;
  if (result.dispatched) return result;
  // A token that may only read is answered 401, 403, or — on a
  // repository it cannot see — 404. Anything else is the workflow or
  // GitHub failing, which no amount of clicking in a browser fixes.
  if (![401, 403, 404].includes(dispatched.status)) {
    throw new KeyToolError(
      `Dispatching the minting workflow failed: HTTP ${dispatched.status} ` +
        `${body.slice(0, 200)}`,
    );
  }
  console.log(
    `This token cannot dispatch the workflow (HTTP ${dispatched.status}).`,
  );
  return result;
}

/** What to print when the dispatch has to happen in a browser. */
function browserInstructions(recipient: string): string {
  return `
Open the minting workflow and run it with your recipient:

    ${mintWorkflowUrl()}

    Recipient: ${recipient}

Dispatching the workflow takes repository write access — that click is
the authorization step. If you do not have commit access, send the
recipient and your GitHub login to a team member, who will run the
workflow with both filled in.`;
}

interface MintRun {
  id: number;
  status: string;
  conclusion?: string;
  html_url?: string;
  created_at?: string;
  actor?: { login?: string };
  display_title?: string;
  name?: string;
}

/** A minting run this requester's, and the delivery it published. */
interface RunMatch {
  run: MintRun;

  /** The delivery artifact, when one identified the run. */
  artifact?: number;
}

/** What a search for the requester's own minting run works from. */
interface RunSearch {
  token: string;
  recipient: string;
  artifactName: string;
  login: string;

  /**
   * GitHub's clock at the moment this attempt began, bounding how far
   * back a run can be and still be this attempt's. Unset examines every
   * run listed, which is what one collection wants and a repeating watch
   * does not.
   */
  notBefore?: number;
}

interface RunSearchResult {
  match?: RunMatch;

  /** GitHub's clock at the listing, for bounding later searches. */
  serverDate?: number;
}

/**
 * The runs worth examining, newest first, over as many pages as the
 * window holds.
 */
async function listCandidateRuns(
  deps: KeyToolDeps,
  search: RunSearch,
): Promise<{ candidates: MintRun[]; serverDate?: number }> {
  // A delivery is kept for seven days, so a run older than that has
  // nothing left to collect; asking GitHub for that window keeps the
  // search to the runs that could still be answered, however many the
  // workflow has accumulated.
  const since = new Date(
    search.notBefore ?? Date.now() - DELIVERY_WINDOW_MS,
  ).toISOString();
  const candidates: MintRun[] = [];
  let serverDate: number | undefined;
  for (let page = 1;; page += 1) {
    const res = await github(
      deps,
      search.token,
      "GET",
      `/repos/${REPO}/actions/workflows/${MINT_WORKFLOW_FILE}/runs` +
        `?per_page=${RUNS_PER_PAGE}&page=${page}` +
        `&created=${encodeURIComponent(`>=${since}`)}`,
    );
    if (!res.ok) {
      await res.text();
      throw new KeyToolError(`Listing minting runs failed: HTTP ${res.status}`);
    }
    const listed = Date.parse(res.headers.get("date") ?? "");
    if (serverDate === undefined && !Number.isNaN(listed)) serverDate = listed;
    const runs = (await res.json() as { workflow_runs?: MintRun[] })
      .workflow_runs ?? [];
    for (const run of runs) {
      if (!isCandidate(run, search)) continue;
      candidates.push(run);
    }
    if (runs.length < RUNS_PER_PAGE) break;
  }
  return serverDate === undefined ? { candidates } : { candidates, serverDate };
}

/** Whether a run could be the one this search is for. */
function isCandidate(run: MintRun, search: RunSearch): boolean {
  const mine = namesRecipient(run, search.recipient) ||
    run.actor?.login?.toLowerCase() === search.login.toLowerCase();
  if (!mine) return false;
  if (search.notBefore === undefined) return true;
  const created = Date.parse(run.created_at ?? "");
  return !Number.isNaN(created) && created >= search.notBefore;
}

/** Whether a run says which recipient it is minting for. */
function namesRecipient(run: MintRun, recipient: string): boolean {
  return `${run.display_title ?? ""}\n${run.name ?? ""}`.includes(recipient);
}

/**
 * The requester's own minting run, newest first, by three tests in
 * descending order of certainty. A run whose name carries the recipient
 * is minting for it. A completed run that published this recipient's
 * delivery minted for it, whatever its name says — which is what a run
 * from a workflow version that does not name its recipient is found by.
 * Failing both, the newest run this person dispatched within this
 * attempt is the one they are waiting on, which is all that can be said
 * of a run that is still going and does not name what it is minting.
 * That last test needs the bound this attempt sets, so a search without
 * one answers only when it can identify the run outright.
 */
async function findMintRun(
  deps: KeyToolDeps,
  search: RunSearch,
): Promise<RunSearchResult> {
  const { candidates, serverDate } = await listCandidateRuns(deps, search);
  const result: RunSearchResult = {};
  if (serverDate !== undefined) result.serverDate = serverDate;

  for (const run of candidates) {
    const named = namesRecipient(run, search.recipient);
    if (run.status === "completed" && run.conclusion === "success") {
      const artifact = await deliveryArtifact(
        deps,
        search.token,
        run.id,
        search.artifactName,
      );
      if (artifact !== undefined) {
        return { ...result, match: { run, artifact } };
      }
      // A run that named this recipient and delivered nothing is still
      // the run to report on; one that named nothing is unidentifiable.
      if (named) return { ...result, match: { run } };
      continue;
    }
    if (named) return { ...result, match: { run } };
  }

  // Attributing a run by who started it and when takes a bound to be
  // safe: without one, a run this person started for some other
  // recipient, under a name that says nothing about what it is minting,
  // cannot be told from theirs.
  if (search.notBefore === undefined) return result;
  const attributed = candidates[0];
  return attributed === undefined
    ? result
    : { ...result, match: { run: attributed } };
}

/** The id of a run's sealed delivery, when it published an unexpired one. */
async function deliveryArtifact(
  deps: KeyToolDeps,
  token: string,
  runId: number,
  artifactName: string,
): Promise<number | undefined> {
  const res = await github(
    deps,
    token,
    "GET",
    `/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  if (!res.ok) {
    await res.text();
    throw new KeyToolError(
      `Listing the artifacts of run ${runId} failed: HTTP ${res.status}`,
    );
  }
  const artifacts = (await res.json() as {
    artifacts?: { id: number; name: string; expired?: boolean }[];
  }).artifacts ?? [];
  return artifacts.find((artifact) =>
    artifact.name === artifactName && artifact.expired !== true
  )?.id;
}

/**
 * Downloads one sealed delivery, opens it with the stored identity, and
 * installs the key file. Decrypting proves the delivery was sealed to
 * this identity, not that its content is a key worth installing:
 * validate the shape — which requires exactly Google's HTTPS token
 * endpoint, since the uploader authenticates wherever that URL points —
 * and require the key to be for whoever collects it.
 */
async function installDelivery(
  deps: KeyToolDeps,
  token: string,
  identity: KeyDeliveryIdentity,
  login: string,
  artifactId: number,
): Promise<string> {
  const download = await github(
    deps,
    token,
    "GET",
    `/repos/${REPO}/actions/artifacts/${artifactId}/zip`,
  );
  if (!download.ok) {
    await download.text();
    throw new KeyToolError(
      `Downloading the delivery failed: HTTP ${download.status}`,
    );
  }
  const zip = new Uint8Array(await download.arrayBuffer());
  const members = await readZip(zip);
  const sealedMember = members.find((member) =>
    member.name.endsWith(".sealed")
  );
  if (sealedMember === undefined) {
    throw new KeyToolError("The delivery artifact holds no sealed key.");
  }
  const box = JSON.parse(
    new TextDecoder().decode(sealedMember.data),
  ) as SealedBox;
  let keyFile: Uint8Array;
  try {
    keyFile = await openSealed(identity, box);
  } catch (error) {
    throw new KeyToolError(
      `The delivery does not open with the identity at ` +
        `${identityPath(deps.env)}: ${reason(error)}`,
    );
  }
  const keyText = new TextDecoder().decode(keyFile);
  const parsedKey = parsePersonalKeyFile(keyText);
  if (parsedKey === undefined) {
    throw new KeyToolError(
      "The delivery is not a personal test-records key file.",
    );
  }
  if (parsedKey.cf_username.toLowerCase() !== login.toLowerCase()) {
    throw new KeyToolError(
      `The delivered key was minted for ${parsedKey.cf_username}, but ` +
        `this token belongs to ${login}; refusing to install it`,
    );
  }
  await Deno.mkdir(configDir(deps.env), { recursive: true });
  const path = keyFilePath(deps.env);
  await Deno.writeTextFile(path, keyText, { mode: 0o600 });
  return path;
}

/**
 * Exports the key file from the login shell's profiles and says what
 * each file's update did.
 */
async function exportKeyFile(
  deps: KeyToolDeps,
  path: string,
): Promise<ProfileUpdate[]> {
  const updates = await exportFromProfiles(
    RECORDS_KEY_FILE_VARIABLE,
    path,
    deps.env,
  );
  if (updates.length === 0) {
    console.log(`
No shell profile to update. Export the key file yourself:

    ${RECORDS_KEY_FILE_VARIABLE}=${path}`);
    // A workstation with no profile to write can still be running an
    // agent, whose harness carries the variable instead.
    await exportAgentConfigs(deps, path);
    return updates;
  }
  const kind = shellKind(deps.env);
  for (const update of updates) {
    if (update.outcome === "added") {
      console.log(`${RECORDS_KEY_FILE_VARIABLE} exported from ${update.path}`);
    } else if (update.outcome === "present") {
      console.log(`${update.path} already exports the key file.`);
    } else if (update.outcome === "unexported") {
      console.log(`
${update.path} sets ${RECORDS_KEY_FILE_VARIABLE} without exporting it:

    ${update.existing}

Left alone. A test run is a program the shell starts, and it sees only
what the shell exports.`);
    } else if (update.outcome === "absent") {
      console.log(`
${update.path} does not exist, and a login shell here reads it before the
profile just written. Create it and it will be read instead of the file
your login shells fall back to, so that one is yours to make; the line
to put in it is:

    ${exportLine(kind, RECORDS_KEY_FILE_VARIABLE, path, home(deps.env))}`);
    } else {
      console.log(`
${update.path} already sets ${RECORDS_KEY_FILE_VARIABLE} elsewhere:

    ${update.existing}

Left alone. Point it at ${path} to record from this key.`);
    }
  }
  const added = updates.filter((update) => update.outcome === "added");
  if (added.length > 0) {
    console.log(`
Every new shell records its test runs. For the one you are in:

    ${reloadHint(added[0]!.path, kind)}`);
  }
  await exportAgentConfigs(deps, path);
  return updates;
}

/** What one harness configuration's update says to a person. */
export function agentConfigReport(
  update: AgentConfigUpdate,
  path: string,
): string {
  switch (update.outcome) {
    case "added":
      return `${update.harness} passes ${RECORDS_KEY_FILE_VARIABLE} to what ` +
        `it runs (${update.path})`;
    case "present":
      return `${update.harness} already passes the key file on.`;
    case "conflict":
      return `
${update.path} gives ${RECORDS_KEY_FILE_VARIABLE} to ${update.harness} as

    ${update.existing}

Left alone. Point it at ${path} to record from this key.`;
    case "changed":
      return `
${update.path} changed while this was writing, so ${update.harness} was
left as it stands. Run the command again.`;
    case "unreadable":
      return `
${update.path} does not parse as JSON, so ${update.harness} was left
alone. Add this to its "env" once the file is readable again:

    "${RECORDS_KEY_FILE_VARIABLE}": "${path}"`;
  }
}

/** What one harness configuration's removal says to a person. */
export function agentRemovalReport(removal: AgentConfigRemoval): string {
  switch (removal.outcome) {
    case "removed":
      return `${removal.harness} no longer passes ` +
        `${RECORDS_KEY_FILE_VARIABLE} on (${removal.path})`;
    case "kept":
      return `
${removal.path} gives ${RECORDS_KEY_FILE_VARIABLE} to ${removal.harness} as

    ${removal.existing}

Left alone. It is not the key this tool installed.`;
    case "changed":
      return `
${removal.path} changed while this was writing, so ${removal.harness} was
left as it stands. Run the command again.`;
    case "unreadable":
      return `
${removal.path} does not parse as JSON, so ${removal.harness} was left
alone. Take ${RECORDS_KEY_FILE_VARIABLE} out of its "env" by hand.`;
  }
}

/**
 * Carries the key file into the configuration of every agent harness
 * installed here. A shell profile covers an agent whose commands go
 * through that shell; this covers the rest.
 */
async function exportAgentConfigs(
  deps: KeyToolDeps,
  path: string,
): Promise<AgentConfigUpdate[]> {
  const updates = await exportFromAgentConfigs(
    RECORDS_KEY_FILE_VARIABLE,
    path,
    deps.env,
  );
  for (const update of updates) console.log(agentConfigReport(update, path));
  return updates;
}

/** The key already installed on this workstation, when there is one. */
async function installedKey(
  env: Environment,
): Promise<{ path: string; key: PersonalKeyFile } | undefined> {
  const path = keyFilePath(env);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
  const parsed = parsePersonalKeyFile(text);
  return parsed === undefined ? undefined : { path, key: parsed };
}

/**
 * Whether Google still accepts the installed key, as far as asking can
 * tell: true where it does, false where it is refused, and undefined
 * where the question could not be put.
 *
 * A key file on disk is not the same thing as a key that works. Minting
 * revokes the person's previous keys before it creates the new one, so a
 * mint that fails in between leaves this workstation holding a file that
 * names a key nothing will accept — and every later test run would ship
 * nothing while saying so only in a warning nobody reads.
 */
async function keyStillWorks(
  deps: KeyToolDeps,
  key: PersonalKeyFile,
): Promise<boolean | undefined> {
  let assertion: string;
  try {
    assertion = await saAssertion(
      key,
      Math.floor(Date.now() / 1000),
      STORE_WRITE_SCOPE,
    );
  } catch {
    // A key that cannot sign is a key nothing will accept, whatever the
    // endpoint would have said about it.
    return false;
  }
  let response: Response;
  try {
    response = await deps.fetchImpl(key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  } catch {
    // The endpoint could not be reached, which says nothing about the
    // key; a workstation offline enough for this cannot mint either.
    return undefined;
  }
  await response.text();
  if (response.ok) return true;
  // A key that has been revoked, or an account that has been disabled,
  // is refused; anything else is the endpoint having a bad day.
  return response.status === 400 || response.status === 401 ? false : undefined;
}

export async function requestCommand(
  deps: KeyToolDeps = defaultDeps(),
): Promise<void> {
  const identity = await ensureIdentity(deps);
  console.log(`Recipient: ${identity.recipient}`);

  const token = await deps.githubToken();
  const username = token === undefined
    ? undefined
    : await githubLogin(deps, token);
  if (token === undefined) {
    console.log(
      "No GitHub token was found; set GH_TOKEN or sign in with " +
        "`gh auth login` to dispatch from here.",
    );
  } else if (username === undefined) {
    console.log("This token cannot read your GitHub login.");
  } else {
    const dispatch = await dispatchMint(
      deps,
      token,
      identity.recipient,
      username,
    );
    if (dispatch.dispatched) {
      console.log(
        `Minting workflow dispatched for ${username}; ` +
          "run `deno task test-records-key collect` once it finishes.",
      );
      return;
    }
  }
  console.log(`${browserInstructions(identity.recipient)}

Once the run finishes:

    deno task test-records-key collect
`);
}

/**
 * Watches until the minting run delivers, printing what it is doing as
 * that changes. There is no bound on the wait: a run takes as long as it
 * takes, and Ctrl-C is how a person stops watching.
 */
async function awaitDelivery(
  deps: KeyToolDeps,
  search: RunSearch,
): Promise<number> {
  let said: string | undefined;
  const say = (line: string): void => {
    if (line === said) return;
    said = line;
    console.log(line);
  };
  for (;;) {
    const { match, serverDate } = await findMintRun(deps, search);
    // Once the first listing has said what time GitHub thinks it is,
    // every later one is bounded by it, so a watch left running does not
    // re-examine runs from before it started.
    if (search.notBefore === undefined && serverDate !== undefined) {
      search.notBefore = serverDate;
    }
    if (match === undefined) {
      say("Waiting for the minting run to appear...");
    } else if (match.artifact !== undefined) {
      say(`Minting run succeeded: ${runUrl(match.run)}`);
      return match.artifact;
    } else if (match.run.status !== "completed") {
      say(
        `Minting run ${match.run.status.replace("_", " ")}: ${
          runUrl(match.run)
        }`,
      );
    } else if (match.run.conclusion === "success") {
      throw new KeyToolError(
        `The minting run published no delivery for this recipient, or it ` +
          `has expired: ${runUrl(match.run)}\n` +
          "Deliveries are kept for seven days; mint a fresh one with " +
          "`deno task test-records-key setup --rotate`.",
      );
    } else {
      throw new KeyToolError(
        `The minting run finished as ${match.run.conclusion ?? "unfinished"}: ${
          runUrl(match.run)
        }\n` +
          "Open it to see which step failed. Run " +
          "`deno task test-records-key setup` again once the cause is fixed.",
      );
    }
    await deps.pause();
  }
}

function runUrl(run: MintRun): string {
  return run.html_url ?? `https://github.com/${REPO}/actions/runs/${run.id}`;
}

/**
 * The whole opt-in: identity, dispatch, watch, install, export. Rerunning
 * it resumes — the identity is reused, and a run already under way is the
 * one it watches.
 */
export async function setupCommand(
  deps: KeyToolDeps = defaultDeps(),
  options: { rotate?: boolean } = {},
): Promise<number> {
  const token = await deps.githubToken();
  const login = token === undefined
    ? undefined
    : await githubLogin(deps, token);
  const stored = await loadIdentity(deps.env);

  // What this recipient already has going, asked before anything else,
  // because a run still minting is this person's own earlier attempt —
  // a watch they stopped, or a dispatch from a browser — and taking it
  // up is what rerunning the command is for. Rotating deliberately is
  // the one case that wants a new run whatever is already going.
  let search: RunSearch | undefined;
  let found: RunMatch | undefined;
  if (
    options.rotate !== true && token !== undefined && login !== undefined &&
    stored !== undefined
  ) {
    search = {
      token,
      recipient: stored.recipient,
      artifactName: await deliveryName(stored.recipient),
      login,
    };
    found = (await findMintRun(deps, search)).match;
  }
  const running = found !== undefined && found.artifact === undefined &&
    found.run.status !== "completed";

  // A key installed here settles the matter only when nothing is being
  // minted to replace it. The key that run delivers is the one this
  // workstation is going to need, and the mint revokes this one to make
  // it, so standing down now is how a person ends up holding a key that
  // has been revoked.
  const existing = await installedKey(deps.env);
  if (existing !== undefined && options.rotate !== true && !running) {
    const works = await keyStillWorks(deps, existing.key);
    if (works === false) {
      console.log(`
The key installed at ${existing.path} is no longer accepted, which is
what a mint that failed after revoking the key it was replacing leaves
behind. Minting a replacement; there is nothing live to revoke.`);
    } else {
      console.log(
        `A reporting key for ${existing.key.cf_username} is installed at ` +
          `${existing.path}`,
      );
      if (works === undefined) {
        console.log(
          "Whether the token endpoint still accepts it could not be asked " +
            "just now.",
        );
      }
      await exportKeyFile(deps, existing.path);
      console.log(`
Minting another key revokes this one, on every machine holding a copy.
To rotate deliberately:

    deno task test-records-key setup --rotate
`);
      return 0;
    }
  }

  if (token === undefined) {
    throw new KeyToolError(
      "A GitHub token is needed to mint and collect a key; set GH_TOKEN " +
        "or sign in with `gh auth login`",
    );
  }
  if (login === undefined) {
    throw new KeyToolError(
      "Cannot read your GitHub login; use a token that can GET /user.",
    );
  }

  const identity = await ensureIdentity(deps);
  console.log(`Recipient: ${identity.recipient}`);
  const watching: RunSearch = search ?? {
    token,
    recipient: identity.recipient,
    artifactName: await deliveryName(identity.recipient),
    login,
  };

  let artifact: number;
  if (found?.artifact !== undefined) {
    console.log(`An earlier run has the key waiting: ${runUrl(found.run)}`);
    artifact = found.artifact;
  } else {
    if (running && found !== undefined) {
      console.log(
        `A minting run for this recipient is already going: ${
          runUrl(found.run)
        }`,
      );
      const created = Date.parse(found.run.created_at ?? "");
      if (!Number.isNaN(created)) watching.notBefore = created;
    } else {
      const dispatch = await dispatchMint(
        deps,
        token,
        identity.recipient,
        login,
      );
      if (dispatch.dispatched) {
        console.log(`Minting workflow dispatched for ${login}`);
      } else {
        console.log(`${browserInstructions(identity.recipient)}

Waiting for that run — this command collects the key on its own once it
finishes. Ctrl-C stops watching; rerunning picks up where it left off.
`);
      }
      if (dispatch.at !== undefined) watching.notBefore = dispatch.at;
    }
    artifact = await awaitDelivery(deps, watching);
  }
  const path = await installDelivery(deps, token, identity, login, artifact);
  console.log(`Key installed: ${path}`);
  await exportKeyFile(deps, path);
  return 0;
}

export async function collectCommand(
  deps: KeyToolDeps = defaultDeps(),
): Promise<number> {
  const identity = await loadIdentity(deps.env);
  if (identity === undefined) {
    throw new KeyToolError(
      `No delivery identity at ${identityPath(deps.env)}; ` +
        "run `deno task test-records-key setup` first",
    );
  }
  const token = await deps.githubToken();
  if (token === undefined) {
    throw new KeyToolError(
      "A GitHub token is needed to download the delivery artifact; " +
        "set GH_TOKEN or sign in with `gh auth login`",
    );
  }
  // The collector's login is read first: the delivered key must be for
  // whoever collects it.
  const login = await githubLogin(deps, token);
  if (login === undefined) {
    throw new KeyToolError(
      "Cannot read your GitHub login to confirm the key is yours; " +
        "use a token that can GET /user",
    );
  }
  const { match } = await findMintRun(deps, {
    token,
    recipient: identity.recipient,
    artifactName: await deliveryName(identity.recipient),
    login,
  });
  if (match === undefined) {
    throw new KeyToolError(
      "No minting run for this recipient; dispatch one with " +
        "`deno task test-records-key setup`.",
    );
  }
  if (match.artifact === undefined) {
    if (match.run.status !== "completed") {
      console.log(
        `The minting run is ${match.run.status.replace("_", " ")}: ${
          runUrl(match.run)
        }\nRun this command again once it has finished, or wait for it ` +
          "with `deno task test-records-key setup`.",
      );
      return 1;
    }
    if (match.run.conclusion !== "success") {
      throw new KeyToolError(
        `The minting run finished as ${match.run.conclusion ?? "unfinished"}: ${
          runUrl(match.run)
        }\n` +
          "Open it to see which step failed, then run " +
          "`deno task test-records-key setup` again.",
      );
    }
    throw new KeyToolError(
      `The minting run published no delivery for this recipient, or it has ` +
        `expired: ${runUrl(match.run)}\n` +
        "Deliveries are kept for seven days; mint a fresh one with " +
        "`deno task test-records-key setup --rotate`.",
    );
  }
  const artifact = match.artifact;
  const path = await installDelivery(deps, token, identity, login, artifact);
  console.log(`Key installed: ${path}`);
  await exportKeyFile(deps, path);
  return 0;
}

/** Deletes a file, saying whether there was one. */
async function removeFile(path: string): Promise<boolean> {
  try {
    await Deno.remove(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw new KeyToolError(`Cannot remove ${path}: ${reason(error)}`);
  }
}

/** The spools waiting under a root, of which there may be none. */
async function spoolCount(root: string): Promise<number | undefined> {
  try {
    let count = 0;
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) count += 1;
    }
    return count;
  } catch {
    return undefined;
  }
}

/**
 * Takes this workstation back to where it was before `setup`: the key,
 * the delivery identity, and the export are removed, and the recording
 * every task entry point does turns itself off with them.
 */
export async function uninstallCommand(
  deps: KeyToolDeps = defaultDeps(),
): Promise<number> {
  const key = keyFilePath(deps.env);
  const identity = identityPath(deps.env);

  // What names the key comes apart before the key itself. A removal
  // that fails part way then leaves a workstation that still records,
  // rather than one pointing every shell at a file that is gone.
  const removals = await unexportFromProfiles(
    RECORDS_KEY_FILE_VARIABLE,
    key,
    deps.env,
  );
  for (const removal of removals) {
    if (removal.outcome === "removed") {
      console.log(
        `${RECORDS_KEY_FILE_VARIABLE} no longer exported from ${removal.path}`,
      );
    } else {
      console.log(`
${removal.path} sets ${RECORDS_KEY_FILE_VARIABLE} in a line this tool did
not write:

    ${removal.existing}

Left alone. Recording continues from whatever key that names.`);
    }
  }

  const configs = await unexportFromAgentConfigs(
    RECORDS_KEY_FILE_VARIABLE,
    key,
    deps.env,
  );
  for (const config of configs) console.log(agentRemovalReport(config));

  const removedKey = await removeFile(key);
  if (removedKey) console.log(`Removed ${key}`);
  const removedIdentity = await removeFile(identity);
  if (removedIdentity) console.log(`Removed ${identity}`);
  // The directory goes only when this tool leaves it empty; anything
  // else in there belongs to something other than test records.
  await Deno.remove(configDir(deps.env)).catch(() => {});

  const removed = removedKey || removedIdentity ||
    removals.some((removal) => removal.outcome === "removed") ||
    configs.some((config) => config.outcome === "removed");
  if (!removed) {
    console.log("Nothing to remove; this workstation was not recording.");
    return 0;
  }
  // What somebody else set stays, and so does whatever it points at, so
  // saying recording has stopped would be saying something untrue.
  const kept = removals.some((removal) => removal.outcome !== "removed") ||
    configs.some((config) => config.outcome !== "removed");

  const root = defaultSpoolRoot(deps.env);
  const spools = root === undefined ? undefined : await spoolCount(root);
  if (spools !== undefined && spools > 0) {
    const runs = spools === 1 ? "One run's" : `${spools} runs'`;
    console.log(`
${runs} records were never shipped, and are still spooled in

    ${root}

A later key ships them; remove that directory to throw them away.`);
  }

  console.log(`
${
    kept
      ? "What this tool could take back is gone."
      : "Every new shell records nothing."
  } Two things this does not do.

The key still exists. This stops the machine using it, and the service
account and the key itself are untouched; a key that has leaked stops
working only when a new one replaces it, which any machine can do with

    deno task test-records-key setup --rotate

Records already shipped stay in the store. They carry no personal
material, and nothing there can be changed or removed by any key this
tool installs.`);
  return 0;
}

function usage(): number {
  console.error(
    "usage: deno task test-records-key " +
      "<setup [--rotate]|request|collect|uninstall>",
  );
  return 2;
}

/** What a stopped watch says on its way out. */
export const INTERRUPT_NOTICE = `
Stopped watching. The minting run carries on; pick the key up with

    deno task test-records-key setup
`;

/**
 * Reports a stop as a stop rather than as a stack, and returns the call
 * that takes the listener back off: a live signal listener holds the
 * event loop open, so the command would not end on its own with one
 * still registered.
 */
function watchForInterrupt(): () => void {
  const stop = () => {
    console.log(INTERRUPT_NOTICE);
    Deno.exit(130);
  };
  try {
    Deno.addSignalListener("SIGINT", stop);
  } catch {
    // A platform without SIGINT delivery stops the way it always did.
    return () => {};
  }
  return () => Deno.removeSignalListener("SIGINT", stop);
}

/**
 * Runs one command line and returns the status the process exits with.
 * A failure a person can hit arrives here as a KeyToolError, whose
 * message is the whole report; anything else keeps its stack, because a
 * stack is the report for a bug in this tool.
 */
export async function runCli(
  args: readonly string[],
  deps: KeyToolDeps = defaultDeps(),
): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === "setup") {
      if (rest.some((argument) => argument !== "--rotate")) return usage();
      const stopWatching = watchForInterrupt();
      try {
        return await setupCommand(deps, { rotate: rest.includes("--rotate") });
      } finally {
        stopWatching();
      }
    }
    if (command === "request") {
      if (rest.length > 0) return usage();
      await requestCommand(deps);
      return 0;
    }
    if (command === "collect") {
      if (rest.length > 0) return usage();
      return await collectCommand(deps);
    }
    if (command === "uninstall") {
      if (rest.length > 0) return usage();
      return await uninstallCommand(deps);
    }
    return usage();
  } catch (error) {
    if (!(error instanceof KeyToolError)) throw error;
    console.error(`\n${error.message}\n`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(await runCli(Deno.args));
