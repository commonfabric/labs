/**
 * An in-memory pattern index behind a fetch function, for tests of `cf`'s
 * index commands. It verifies each call's CF1 signature and, when the body
 * carries `proofs`, holds the chain to the index's rules through the same
 * `checkIndexChain` the client uses, so a call the real index would refuse
 * is refused here too. It answers only the functions `cf` calls.
 */

import { fromBase64url } from "@commonfabric/bytes/base64url";
import type { DIDKey } from "@commonfabric/identity";
import type {
  PatternIndexListedPattern,
  PatternIndexListing,
  PatternIndexPublishRequest,
} from "@commonfabric/pattern-index/client";
import type { PatternIndexFetch } from "@commonfabric/pattern-index/http-fetch";
import { checkIndexChain } from "@commonfabric/pattern-index/membership";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

/** One stored publication, with the member who published it. */
export interface FakePublication {
  patternId: string;
  owner: string;
  body: Record<string, unknown>;
  listing: PatternIndexListing;
}

/** One call the fake answered, as it arrived. */
export interface FakeCall {
  fn: string;
  signer: DIDKey;
  body: Record<string, unknown>;
}

export interface FakePatternIndexOptions {
  /** Invite id to its code; each works once. */
  invites?: Record<string, string>;

  /** What `getGardenerPrompt {name: "privacy"}` answers. */
  privacyPrompt?: Record<string, unknown>;

  /** When set, `requestListing` refuses with 429 and this reset time. */
  capResetsAt?: string;

  nowSeconds?: number;
}

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

export class FakePatternIndex {
  readonly calls: FakeCall[] = [];
  readonly publications = new Map<string, FakePublication>();
  readonly #invites: Map<string, string>;
  readonly #members = new Map<DIDKey, { handle: string; role: "user" }>();
  readonly #options: FakePatternIndexOptions;

  constructor(options: FakePatternIndexOptions = {}) {
    this.#options = options;
    this.#invites = new Map(Object.entries(options.invites ?? {}));
  }

  /** Makes `did` a member's root directly, as `admitKey` would. */
  admit(did: DIDKey, handle: string): void {
    this.#members.set(did, { handle, role: "user" });
  }

  /** Sets a stored publication's listing, as a gardener would. */
  setListing(patternId: string, listing: PatternIndexListing): void {
    const stored = this.publications.get(patternId);
    if (stored !== undefined) stored.listing = listing;
  }

  readonly fetchFn: PatternIndexFetch = async (input, init) => {
    const url = new URL(String(input));
    const fn = url.pathname.split("/").at(-1)!;
    const request = new Request(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    let signer: DIDKey;
    try {
      signer = (await verifyFirstPartyHttpRequest({ request })).userDid;
    } catch {
      return json(401, { error: "unverified" });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    this.calls.push({ fn, signer, body });
    let root: DIDKey = signer;
    if (Array.isArray(body.proofs)) {
      try {
        const checked = await checkIndexChain(
          body.proofs.map((link: string) => fromBase64url(link)),
          signer,
          this.#options.nowSeconds,
        );
        root = checked.root;
      } catch (error) {
        return json(403, { error: (error as Error).message });
      }
    }
    if (fn === "redeemInvite") return this.#redeem(root, body);
    const member = this.#members.get(root);
    if (member === undefined) return json(403, { error: "not a member" });
    switch (fn) {
      case "whoami":
        return json(200, member);
      case "getGardenerPrompt":
        return this.#options.privacyPrompt === undefined
          ? json(404, { error: "no such gardener" })
          : json(200, this.#options.privacyPrompt);
      case "publishPattern":
        return this.#publish(member.handle, body);
      case "requestListing":
        return this.#requestListing(member.handle, body);
      case "getPattern":
        return this.#get(member.handle, body);
      case "listPatterns":
        return this.#list(member.handle, body);
      default:
        return json(404, { error: `no function ${fn}` });
    }
  };

  #redeem(root: DIDKey, body: Record<string, unknown>): Response {
    const code = this.#invites.get(String(body.inviteId));
    if (code === undefined || code !== body.code) {
      return json(404, { error: "no such invite" });
    }
    if (this.#members.has(root)) return json(409, { error: "already" });
    this.#invites.delete(String(body.inviteId));
    const member = { handle: `p-${this.#members.size + 1}`, role: "user" as const };
    this.#members.set(root, member);
    return json(200, member);
  }

  #publish(owner: string, body: Record<string, unknown>): Response {
    const patternId = String(body.patternId);
    const existing = this.publications.get(patternId);
    if (existing !== undefined) {
      return json(200, { patternId, created: false, listing: existing.listing });
    }
    this.publications.set(patternId, {
      patternId,
      owner,
      body,
      listing: "not_requested",
    });
    return json(200, { patternId, created: true, listing: "not_requested" });
  }

  #requestListing(owner: string, body: Record<string, unknown>): Response {
    const stored = this.publications.get(String(body.patternId));
    if (stored === undefined) return json(404, { error: "not found" });
    if (stored.owner !== owner) return json(403, { error: "not yours" });
    if (this.#options.capResetsAt !== undefined) {
      return json(429, {
        error: "daily cap reached",
        resetsAt: this.#options.capResetsAt,
      });
    }
    if (stored.listing === "not_requested") stored.listing = "pending";
    return json(200, { patternId: stored.patternId, listing: stored.listing });
  }

  #get(caller: string, body: Record<string, unknown>): Response {
    const stored = this.publications.get(String(body.patternId));
    if (stored === undefined) return json(404, { error: "not found" });
    return json(200, {
      patternId: stored.patternId,
      handle: stored.owner,
      ...(stored.owner === caller ? { mine: true } : {}),
      createdAt: "2026-11-15T00:00:00.000Z",
      description: (stored.body.meta as PatternIndexPublishRequest)
        .description,
      hashtags: [],
      dependencies: [],
      listing: stored.listing,
    });
  }

  #list(caller: string, body: Record<string, unknown>): Response {
    const rows: PatternIndexListedPattern[] = [];
    for (const stored of this.publications.values()) {
      if (body.mine === true && stored.owner !== caller) continue;
      const meta = stored.body.meta as {
        description: string;
        hashtags: string[];
      };
      rows.push({
        patternId: stored.patternId,
        description: meta.description,
        hashtags: meta.hashtags,
        keywords: [],
        handle: stored.owner,
        ...(stored.owner === caller ? { mine: true } : {}),
        createdAt: "2026-11-15T00:00:00.000Z",
        events: {},
        score: 0,
        listing: stored.listing,
        listed: stored.listing === "passed",
        ...(typeof stored.body.priorPatternId === "string"
          ? { lineageId: String(stored.body.priorPatternId) }
          : { lineageId: stored.patternId }),
      });
    }
    return json(200, { patterns: rows, eventTypes: {} });
  }
}
