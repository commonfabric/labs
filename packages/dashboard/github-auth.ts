/**
 * The credentials the dashboard's GitHub requests carry. A credential is
 * either a token taken from the environment and used as is, or a GitHub App's
 * installation on an organization or an enterprise, whose tokens are minted
 * from the app's private key and renewed shortly before each one expires.
 *
 * Every request asks its credential for a token as it starts, so a collection
 * that outlives one installation token, waiting on the rate limit or paging
 * through history, carries on with the next one.
 */

import {
  importRsaSigningKey,
  rs256Jwt,
} from "@commonfabric/test-support/records";

/** What a GitHub request authenticates with. */
export interface GitHubCredential {
  /**
   * Names the rate-limit allowance this credential's tokens draw on. It stays
   * the same across the tokens one credential hands out, since GitHub counts
   * an installation's requests together whichever token made them. For a
   * token from the environment it is the token itself, so it is as secret as
   * the token.
   */
  readonly allowance: string;

  /** Returns a token that is good for a request starting now. */
  token(): Promise<string>;

  /**
   * Reports that GitHub refused `token` as a credential, so that the next
   * request does not use it again where another can be had.
   */
  refused(token: string): void;
}

/** The GitHub account a GitHub App installation is on. */
export interface GitHubAccount {
  /** Whether the account is an organization or an enterprise. */
  readonly kind: "organization" | "enterprise";

  /**
   * The organization's login, or the enterprise's slug. An organization
   * account's installation may also be on a user of that login.
   */
  readonly name: string;
}

/** Where the dashboard reads its configuration from. */
export interface GitHubEnv {
  /** Returns the variable `key`, or `undefined` when it is unset. */
  env(key: string): string | undefined;
}

/**
 * How long before an installation token expires the next request gets a new
 * one instead. GitHub issues them for an hour, so a request starting with a
 * token is never within this margin of its expiry.
 */
export const INSTALLATION_TOKEN_RENEWAL_MS = 5 * 60_000;

const GITHUB_API = "https://api.github.com";

// GitHub accepts an app's JWT for at most ten minutes, and recommends dating it
// a minute early to allow for clock drift.
const APP_JWT_BACKDATE_SECONDS = 60;
const APP_JWT_LIFETIME_SECONDS = 9 * 60;

/** Options a test passes to a `GitHubApp` in place of the network and clock. */
export interface GitHubAppOptions {
  /** Makes the app's own requests to GitHub. */
  fetch?: typeof fetch;

  /** The current time, in milliseconds since the epoch. */
  now?: () => number;
}

/** A GitHub App installation's account, and the state its tokens keep. */
interface Installation {
  /** The account the installation is on. */
  readonly account: GitHubAccount;

  /** The installation's ID, once looked up. */
  id?: Promise<number>;

  /** The newest token GitHub minted for the installation. */
  current?: { token: string; expiresAt: number };

  /** The request minting the next token, while one is under way. */
  minting?: Promise<string>;
}

/** One of the app's installations, as GitHub lists them. */
interface ListedInstallation {
  /** The installation's ID. */
  id: number;

  /** `Organization`, `User`, or `Enterprise`. */
  target_type: string;

  /** The account the app is installed on. */
  account: { login?: string; slug?: string } | null;
}

/**
 * A GitHub App the dashboard authenticates as. Each installation it is asked
 * for is one credential, shared by every request made about that account.
 */
export class GitHubApp {
  #clientId: string;
  #privateKey: string;
  #key: Promise<CryptoKey> | undefined;
  #fetch: typeof fetch;
  #now: () => number;
  #installations = new Map<string, GitHubCredential>();

  /**
   * Constructs an instance for the app with client ID `clientId`, signing as
   * it with `privateKey`, a PEM key in either the PKCS#1 form GitHub issues or
   * PKCS#8. A key that cannot be read fails each request made with it.
   */
  constructor(
    clientId: string,
    privateKey: string,
    options: GitHubAppOptions = {},
  ) {
    this.#clientId = clientId;
    this.#privateKey = privateKey;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  /** Returns the credential for this app's installation on `account`. */
  installation(account: GitHubAccount): GitHubCredential {
    const allowance = `GitHub App ${this.#clientId} on ${account.kind} ` +
      account.name.toLowerCase();
    let credential = this.#installations.get(allowance);
    if (!credential) {
      const installation: Installation = { account };
      credential = {
        allowance,
        token: () => this.#token(installation),
        refused: (token) => {
          if (installation.current?.token !== token) return;
          installation.current = undefined;
          installation.id = undefined;
        },
      };
      this.#installations.set(allowance, credential);
    }
    return credential;
  }

  // Helper for `installation()`, which returns the installation's current
  // token, minting a new one when that one is near its expiry. Concurrent
  // requests share one mint.
  #token(installation: Installation): Promise<string> {
    const current = installation.current;
    if (
      current &&
      current.expiresAt - this.#now() > INSTALLATION_TOKEN_RENEWAL_MS
    ) {
      return Promise.resolve(current.token);
    }
    return installation.minting ??= this.#mint(installation).finally(() => {
      installation.minting = undefined;
    });
  }

  // Helper for `#token()`, which asks GitHub for a new token. An installation
  // that is gone, because the app was uninstalled or reinstalled, fails here,
  // and the failure clears the ID so that the next request looks the
  // installation up again.
  async #mint(installation: Installation): Promise<string> {
    const id = installation.id ??= this.#find(installation.account);
    try {
      const minted = await this.#request<
        { token?: string; expires_at?: string }
      >(`app/installations/${await id}/access_tokens`, "POST");
      const expiresAt = Date.parse(minted.expires_at ?? "");
      if (!minted.token || Number.isNaN(expiresAt)) {
        throw new Error(
          `GitHub App \`${this.#clientId}\` was given a malformed token ` +
            `for ${describe(installation.account)}`,
        );
      }
      installation.current = { token: minted.token, expiresAt };
      return minted.token;
    } catch (error) {
      if (installation.id === id) installation.id = undefined;
      throw error;
    }
  }

  // Helper for `#mint()`, which finds the installation on `account` among
  // every one the app has.
  async #find(account: GitHubAccount): Promise<number> {
    const wanted = account.name.toLowerCase();
    for (let page = 1;; page++) {
      const listed = await this.#request<ListedInstallation[]>(
        `app/installations?per_page=100&page=${page}`,
      );
      const found = listed.find((installation) =>
        account.kind === "enterprise"
          ? installation.target_type === "Enterprise" &&
            installation.account?.slug?.toLowerCase() === wanted
          : installation.target_type !== "Enterprise" &&
            installation.account?.login?.toLowerCase() === wanted
      );
      if (found) return found.id;
      if (listed.length < 100) {
        throw new Error(
          `GitHub App \`${this.#clientId}\` is not installed on ` +
            describe(account),
        );
      }
    }
  }

  // Makes a request to `path` as the app itself, rather than as one of its
  // installations, and returns the parsed JSON response.
  async #request<T>(path: string, method = "GET"): Promise<T> {
    const response = await this.#fetch(`${GITHUB_API}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.#jwt()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `GitHub App \`${this.#clientId}\` request ${method} ${path} ` +
          `failed: HTTP ${response.status}`,
      );
    }
    return await response.json() as T;
  }

  // The JSON Web Token GitHub accepts as the app's own identity: RS256,
  // issued by the client ID.
  async #jwt(): Promise<string> {
    const nowSeconds = Math.floor(this.#now() / 1000);
    return await rs256Jwt(
      await (this.#key ??= importRsaSigningKey(this.#privateKey)),
      {
        iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
        exp: nowSeconds + APP_JWT_LIFETIME_SECONDS,
        iss: this.#clientId,
      },
    );
  }
}

/** Describes `account` for an error message. */
function describe(account: GitHubAccount): string {
  return `${account.kind} \`${account.name}\``;
}

/**
 * The `refused()` of a credential with nothing to drop: a token from the
 * environment is the only one it has.
 */
function ignoreRefusal(): void {}

/** Returns a credential that uses `token` for every request. */
export function staticGitHubCredential(token: string): GitHubCredential {
  return {
    allowance: token,
    token: () => Promise.resolve(token),
    refused: ignoreRefusal,
  };
}

/**
 * Builds the dashboard's GitHub credentials from the environment, keeping one
 * instance of each, so that every tile using the same credential shares its
 * tokens and its rate-limit accounting.
 */
export class GitHubCredentials {
  #apps = new Map<string, GitHubApp>();
  #tokens = new Map<string, GitHubCredential>();

  /**
   * Returns the credential for requests about `account`, or `undefined` when
   * `source` configures none. The first of `overrides` that is set comes
   * first; then, with `GH_APP_CLIENT_ID` and `GH_APP_PRIVATE_KEY` set, the
   * GitHub App's installation on `account`; then `GH_TOKEN` or
   * `GITHUB_TOKEN`. With only one of the app's two variables set, the
   * credential refuses every request, naming the one that is missing.
   */
  for(
    source: GitHubEnv,
    account: GitHubAccount,
    overrides: readonly string[] = [],
  ): GitHubCredential | undefined {
    const clientId = source.env("GH_APP_CLIENT_ID")?.trim();
    const privateKey = source.env("GH_APP_PRIVATE_KEY")?.trim();
    const app = !clientId && !privateKey
      ? undefined
      : clientId && privateKey
      ? this.#app(clientId, privateKey).installation(account)
      : misconfiguredApp(clientId ? "GH_APP_PRIVATE_KEY" : "GH_APP_CLIENT_ID");
    return this.fromTokens(source, overrides) ?? app ??
      this.fromTokens(source, ["GH_TOKEN", "GITHUB_TOKEN"]);
  }

  /**
   * Returns the credential for the first of `variables` that `source` sets,
   * or `undefined` when it sets none of them.
   */
  fromTokens(
    source: GitHubEnv,
    variables: readonly string[],
  ): GitHubCredential | undefined {
    for (const variable of variables) {
      const value = source.env(variable);
      if (!value) continue;
      let credential = this.#tokens.get(value);
      if (!credential) {
        credential = staticGitHubCredential(value);
        this.#tokens.set(value, credential);
      }
      return credential;
    }
    return undefined;
  }

  #app(clientId: string, privateKey: string): GitHubApp {
    const key = `${clientId}\n${privateKey}`;
    let app = this.#apps.get(key);
    if (!app) {
      app = new GitHubApp(clientId, privateKey);
      this.#apps.set(key, app);
    }
    return app;
  }
}

/**
 * Returns a credential for a GitHub App configured with only one of its two
 * variables, which refuses every request, naming `missing`.
 */
function misconfiguredApp(missing: string): GitHubCredential {
  return {
    allowance: `GitHub App missing ${missing}`,
    token: () =>
      Promise.reject(
        new Error(`set ${missing} to authenticate as the GitHub App`),
      ),
    refused: ignoreRefusal,
  };
}
