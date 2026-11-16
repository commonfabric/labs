/**
 * The viewer's settings, which it keeps in git's configuration so that they
 * follow git's own rules for where a setting applies: to one repository, to
 * the user, or to the machine.
 */

import { isAbsolute, join } from "@std/path";
import type { GitQuery } from "./push.ts";

/**
 * How the viewer handles the pushed branch's pull request: what `P` does once
 * the server offers a page for creating one, and what `L` does with the one
 * that is open. With "link", `P` shows the page's address and `L` the pull
 * request's. With "browser", each opens its page in the browser. With "api",
 * `P` creates the pull request and `L` merges it with GitHub's REST API, and
 * with "touch-gate", they ask a touch-gate server to, once a security key is
 * touched.
 */
export type PullRequestTool = "link" | "api" | "browser" | "touch-gate";

/** Each {@link PullRequestTool}, in the order the settings dialog lists them. */
export const PULL_REQUEST_TOOLS: readonly PullRequestTool[] = [
  "link",
  "api",
  "browser",
  "touch-gate",
];

/** What the viewer's settings say. */
export interface ViewSettings {
  /** How the viewer handles the pushed branch's pull request. */
  readonly pullRequestTool: PullRequestTool;

  /** The name of the token the touch-gate server uses, or "" for none. */
  readonly touchGateToken: string;

  /**
   * Whether the viewer quits, printing the pull request's address, when the
   * pull request for a branch that `P` pushed is opened while the push dialog
   * is up.
   */
  readonly quitOnPullRequest: boolean;

  /**
   * The `host:port` of the GitHub webhook relay's subscriber listener, which
   * tells the viewer when the pull request is opened, or "" for none.
   */
  readonly webhookRelay: string;
}

const PULL_REQUEST_TOOL = "cf-view.pullRequestTool";
const TOUCH_GATE_TOKEN = "cf-view.touchGateToken";
const QUIT_ON_PULL_REQUEST = "cf-view.quitOnPullRequest";
const WEBHOOK_RELAY = "cf-view.webhookRelay";

/** Each git configuration variable, and the value it holds for settings. */
const VARIABLES: ReadonlyArray<
  readonly [string, (settings: ViewSettings) => string]
> = [
  [PULL_REQUEST_TOOL, (settings) => settings.pullRequestTool],
  [TOUCH_GATE_TOKEN, (settings) => settings.touchGateToken],
  [QUIT_ON_PULL_REQUEST, (settings) => String(settings.quitOnPullRequest)],
  [WEBHOOK_RELAY, (settings) => settings.webhookRelay],
];

/**
 * Returns the settings git's configuration holds, as the repository `git`
 * runs in sees them. A setting nothing sets is off, or empty, except that
 * the pull request tool is "browser" unless it is set to another.
 */
export function readSettings(git: GitQuery): ViewSettings {
  const tool = git(["config", "--get", PULL_REQUEST_TOOL])?.trim();
  return {
    pullRequestTool: PULL_REQUEST_TOOLS.find((t) => t === tool) ?? "browser",
    touchGateToken: git(["config", "--get", TOUCH_GATE_TOKEN])?.trim() ?? "",
    quitOnPullRequest:
      git(["config", "--type=bool", "--get", QUIT_ON_PULL_REQUEST])?.trim() ===
        "true",
    webhookRelay: git(["config", "--get", WEBHOOK_RELAY])?.trim() ?? "",
  };
}

/**
 * Saves each setting in `settings` that differs from `shown`, the settings it
 * was edited from, and returns whether git saved every one. A setting is
 * saved in the file git read its value from, so that the new value is the one
 * git reads, except that a value from the machine's own configuration, or
 * from none, is saved in the user's. Git names a file of the repository's
 * from the top of its work tree.
 */
export function saveSettings(
  git: GitQuery,
  shown: ViewSettings,
  settings: ViewSettings,
): boolean {
  const saved = VARIABLES.map(([variable, valueOf]) => {
    const value = valueOf(settings);
    if (value === valueOf(shown)) return true;
    const [scope, origin] = git([
      "config",
      "-z",
      "--show-scope",
      "--show-origin",
      "--get",
      variable,
    ])?.split("\0") ?? [];
    const path = origin?.startsWith("file:")
      ? origin.slice("file:".length)
      : undefined;
    const top = path !== undefined && !isAbsolute(path)
      ? git(["rev-parse", "--show-toplevel"])?.trim()
      : undefined;
    const file = scope !== "system" && path !== undefined
      ? ["--file", top === undefined ? path : join(top, path)]
      : ["--global"];
    return git(["config", ...file, variable, value]) !== null;
  });
  return saved.every((ok) => ok);
}
