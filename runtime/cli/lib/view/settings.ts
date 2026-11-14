/**
 * The viewer's settings, which it keeps in git's configuration so that they
 * follow git's own rules for where a setting applies: to one repository, to
 * the user, or to the machine.
 */

import { isAbsolute, join } from "@std/path";
import type { GitQuery } from "./push.ts";

/** What the viewer's settings say. */
export interface ViewSettings {
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

const QUIT_ON_PULL_REQUEST = "cf-view.quitOnPullRequest";
const WEBHOOK_RELAY = "cf-view.webhookRelay";

/** Each git configuration variable, and the value it holds for settings. */
const VARIABLES: ReadonlyArray<
  readonly [string, (settings: ViewSettings) => string]
> = [
  [QUIT_ON_PULL_REQUEST, (settings) => String(settings.quitOnPullRequest)],
  [WEBHOOK_RELAY, (settings) => settings.webhookRelay],
];

/**
 * Returns the settings git's configuration holds, as the repository `git`
 * runs in sees them. A setting nothing sets is off, or empty.
 */
export function readSettings(git: GitQuery): ViewSettings {
  return {
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
