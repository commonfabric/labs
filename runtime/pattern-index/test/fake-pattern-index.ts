/**
 * An in-memory pattern index behind a fetch function, for tests of the index's
 * clients: `cf`'s commands and Loom's helper. It verifies each call's CF1 signature and, when the body
 * carries `proofs`, holds the chain to the index's rules through the same
 * `checkIndexChain` the client uses, so a call the real index would refuse
 * is refused here too. It answers only the functions `cf` calls.
 */

import { fromBase64url } from "@commonfabric/bytes/base64url";
import {
  decodeDelegation,
  type DIDKey,
  verifyDelegation,
} from "@commonfabric/identity";
import type {
  PatternIndexListedPattern,
  PatternIndexListing,
  PatternIndexPublishRequest,
} from "../src/client.ts";
import type { PatternIndexFetch } from "../src/http-fetch.ts";
import { checkIndexChain } from "../src/membership.ts";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

/** One stored publication, with the member who published it. */
export interface FakePublication {
  patternId: string;
  owner: string;
  body: Record<string, unknown>;
  listing: PatternIndexListing;

  /** The channel `shareVersion` shared it on. */
  channel?: "beta" | "stable";
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
  readonly #lineageSeqs = new Map<string, number>();
  readonly #versions = new Map<string, string>();

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
    if (fn === "moveRoot") return await this.#moveRoot(signer, body);
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
      case "shareVersion":
        return this.#shareVersion(member.handle, body);
      case "getPattern":
        return this.#get(member.handle, body);
      case "listPatterns":
        return this.#list(member.handle, body);
      case "listLineages":
        return json(200, {
          lineages: [...this.#lineageSeqs.keys()]
            .filter((key) => key.startsWith(`${member.handle}\n`))
            .map((key) => ({ slot: key.slice(member.handle.length + 1) })),
        });
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
    const member = {
      handle: `p-${this.#members.size + 1}`,
      role: "user" as const,
    };
    this.#members.set(root, member);
    return json(200, member);
  }

  async #moveRoot(
    signer: DIDKey,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const move = await decodeDelegation(
      fromBase64url(String(body.rootDelegation)),
    );
    await verifyDelegation(move);
    const member = this.#members.get(move.payload.iss);
    if (
      member === undefined || move.payload.cmd !== "/index/root" ||
      move.payload.aud !== signer || move.payload.sub !== move.payload.iss
    ) {
      return json(403, { error: "not a root move" });
    }
    if (this.#members.has(signer)) return json(409, { error: "taken" });
    this.#members.delete(move.payload.iss);
    this.#members.set(signer, member);
    return json(200, member);
  }

  #publish(owner: string, body: Record<string, unknown>): Response {
    const patternId = String(body.patternId);
    // A version number per owner and slot, as the index numbers a lineage's
    // versions; a publication without a slot gets none.
    const lineageKey = typeof body.slot === "string"
      ? `${owner}\n${body.slot}`
      : undefined;
    const existing = this.publications.get(patternId);
    if (existing !== undefined) {
      // The index answers the version already holding this source.
      const versionId = [...this.#versions].find(([, id]) => id === patternId)
        ?.[0];
      return json(200, {
        patternId,
        created: false,
        listing: existing.listing,
        ...(lineageKey === undefined
          ? {}
          : { seq: this.#lineageSeqs.get(lineageKey), versionId }),
      });
    }
    this.publications.set(patternId, {
      patternId,
      owner,
      body,
      listing: "not_requested",
    });
    if (lineageKey === undefined) {
      return json(200, { patternId, created: true, listing: "not_requested" });
    }
    const seq = (this.#lineageSeqs.get(lineageKey) ?? 0) + 1;
    this.#lineageSeqs.set(lineageKey, seq);
    // Version ids are unique across lineages, as the index's are.
    const versionId = `ver-${this.#versions.size + 1}`;
    this.#versions.set(versionId, patternId);
    return json(200, {
      patternId,
      created: true,
      listing: "not_requested",
      versionId,
      seq,
      visibility: "private",
      share: "none",
    });
  }

  /** Shares a version as `requestListing` does, on the channel asked for. */
  #shareVersion(owner: string, body: Record<string, unknown>): Response {
    const patternId = this.#versions.get(String(body.versionId));
    if (patternId === undefined) return json(404, { error: "not found" });
    const listed = this.#requestListing(owner, { patternId });
    if (listed.status !== 200) return listed;
    const stored = this.publications.get(patternId)!;
    const asked = body.channel === "beta" ? "beta" : "stable";
    // Channels only move forward: stable never goes back to beta.
    const changed = stored.channel !== asked && stored.channel !== "stable";
    if (changed) stored.channel = asked;
    return json(200, {
      versionId: body.versionId,
      patternId,
      visibility: "public",
      share: "pending",
      listing: stored.listing,
      changed,
    });
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
