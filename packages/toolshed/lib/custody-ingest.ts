import {
  type Cell,
  cellRuntime,
  type IExtendedStorageTransaction,
} from "@commonfabric/runner";
import { stampExternalIngest } from "@commonfabric/runner/cfc";
import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { cloneIfNecessary } from "@commonfabric/data-model";
import type { FabricValue } from "@commonfabric/api";

/**
 * The one durable-write path for the fabric's external-ingest edges. An outside
 * service with no DID deposits data into the fabric; a vouched ingest channel
 * marks every value it writes with an unforgeable `ExternalIngest` provenance
 * stamp.
 *
 * This replaces the per-route, hand-rolled durable-write blocks
 * (`oauth2-common.utils.ts` persistTokens/clearAuthData, the divergent
 * non-retry `plaid-oauth.utils.ts` saveAuthData) with a single governed write.
 * `custodyIngest.*` adds the provenance mark for the ingest edges; `durableSet`
 * / `durableUpdate` are the same governed write for operator actions that are
 * NOT ingest (clearing tokens, removing an item), which must not carry the mark.
 *
 * NOT yet migrated: the webhook path still hand-rolls its own fire-and-forget
 * `sendToStream` (a transient, unmarked overwrite — see `webhooks.utils.ts`).
 * Moving webhooks onto a marked, durable trail is the planned `stream`-sink
 * follow-on of the ingest-channel work, not something this file already does —
 * see docs/plans/ingest-channels-journal-sink.md.
 *
 * The split-mint runs here: the payload is written under the ordinary member
 * identity (so the runtime gate strips any provenance atom an attacker smuggled
 * into it), while `stampExternalIngest` hands the commit pipeline only the
 * *verified channel metadata* — channel, audience, receive time, and a digest
 * of the bytes we wrote — from which it mints the trusted mark. The two never
 * share an authoring identity. See
 * docs/features/vouched-ingest-channel-mint.md.
 *
 * Honest limit: v1 is operator-trusted. This runtime is `as: identity` and sees
 * the plaintext; the split-mint protects the *mark*, not the *bytes*.
 */
export type VouchedChannel = {
  /** The ingest channel — its dedicated space DID. Recorded on every mark. */
  readonly channel: string;

  /**
   * The stable per-source identifier the grant was vouched to. Recorded for
   * audit/display; NOT enforced (audience-binding is the federation PR5
   * dependency).
   *
   * Two conventions coexist at rest, and a new channel must follow one: a
   * minted, token-bearing ingest channel uses its per-install `installId`
   * (`ingest.utils.ts`); a token-less integration channel uses a fixed
   * `did:web:commonfabric.org#<integration>` URI (OAuth:
   * `oauth2-common.utils.ts` `oauthIngestChannel`; Plaid equivalent).
   */
  readonly audience: string;
};

// A digest of the payload bytes the mark binds to, computed with the canonical
// shared SHA-256 (sync, so it can run inside the retry loop — see durableEdit).
// v1 hashes the JSON serialization of the parsed value; binding to the exact
// received bytes is a future hardening.
const digestOf = (payload: unknown): string =>
  `sha256:${
    toUnpaddedBase64url(sha256(new TextEncoder().encode(
      JSON.stringify(payload ?? null),
    )))
  }`;

// A fresh, independent deep-mutable copy of a cell value, so an in-place
// `mutate` callback can't touch the transaction's working copy before the
// explicit `set`. Uses the canonical `FabricValue` clone (force-copy
// everything, leave it mutable); never a JSON round-trip, which mangles a
// `FabricPrimitive`.
const cloneValue = <T>(value: T | undefined): T | undefined =>
  value === undefined ? undefined : cloneIfNecessary(value as FabricValue, {
    frozen: false,
    deep: true,
    force: true,
  }) as T;

/**
 * The one governed write. `mutate` runs INSIDE the retrying transaction, so any
 * read-modify-write it does re-reads the current value on every retry (no
 * stale-snapshot lost update). It returns the value the mark's digest binds to.
 * When `channel` is set, the ExternalIngest mark is minted from that value.
 */
const durableEdit = async <T, W>(
  cell: Cell<T>,
  mutate: (bound: Cell<T>) => W,
  channel?: VouchedChannel,
): Promise<W> => {
  const link = cell.getAsNormalizedFullLink();
  // Operator wall-clock, captured BEFORE the write: retries must not re-stamp
  // the time, and it must never come from the payload.
  const receivedAt = new Date().toISOString();
  const { ok, error } = await cellRuntime(cell).editWithRetry(
    (tx: IExtendedStorageTransaction): W => {
      const written = mutate(cell.withTx(tx));
      if (channel !== undefined) {
        stampExternalIngest(tx, {
          channel: channel.channel,
          audience: channel.audience,
          receivedAt,
          valueDigest: digestOf(written),
          target: {
            space: link.space,
            id: link.id,
            scope: link.scope,
            path: link.path,
          },
        });
      }
      return written;
    },
  );
  if (error) throw error;
  return ok as W;
};

/**
 * Governed durable write with NO ingest mark — the factored replacement for the
 * hand-rolled per-route `editWithRetry` set blocks, for writes that are operator
 * actions rather than external ingest (clearing OAuth tokens).
 */
export const durableSet = <T>(cell: Cell<T>, value: T): Promise<T> =>
  durableEdit(cell, (bound) => {
    bound.set(value);
    return value;
  });

/**
 * Governed durable read-modify-write with NO ingest mark — for operator actions
 * that must re-read the current value on each retry (e.g. removing one item
 * from a list), but are not external ingest.
 */
export const durableUpdate = <T>(
  cell: Cell<T>,
  mutate: (current: T | undefined) => T,
): Promise<T> =>
  durableEdit(cell, (bound) => {
    // Clone before handing the value to `mutate`: an in-place mutate must not
    // touch the transaction's working copy before the explicit `set`.
    const next = mutate(cloneValue(bound.get() as T | undefined));
    bound.set(next);
    return next;
  });

/**
 * Durably write external data into the fabric under a vouched ingest channel,
 * minting the `ExternalIngest` provenance mark.
 */
export const custodyIngest = {
  /** Durably replace the cell's value (e.g. an OAuth token refresh). */
  set<T>(cell: Cell<T>, value: T, channel: VouchedChannel): Promise<T> {
    return durableEdit(cell, (bound) => {
      bound.set(value);
      return value;
    }, channel);
  },

  /**
   * Durably append one external record to a list cell (e.g. a webhook event or
   * a location point). The read-append-write runs inside the retry, so
   * concurrent appends don't lose each other; the mark binds to the appended
   * element — the external bytes — not the whole accumulated array.
   */
  append<E>(cell: Cell<E[]>, element: E, channel: VouchedChannel): Promise<E> {
    return durableEdit(cell, (bound) => {
      const current = (bound.get() as E[] | undefined) ?? [];
      bound.set([...current, element]);
      return element;
    }, channel);
  },

  /**
   * Durably appends `elements` to a list cell in one commit, as one ingest
   * (e.g. the batch of records one POST carries). The mark binds to
   * `elements`, the payload this ingest brought, not to the accumulated list.
   *
   * The elements already in the list are left as they are. A list of objects
   * holds a link to a document for each one, and writing the whole list back
   * from a copy would store every earlier element again under a new id on
   * each call.
   */
  appendAll<E>(
    cell: Cell<E[]>,
    elements: E[],
    channel: VouchedChannel,
  ): Promise<E[]> {
    return durableEdit(cell, (bound) => {
      bound.pushAll(elements);
      return elements;
    }, channel);
  },

  /**
   * Durably read-modify-write a cell under a vouched channel (e.g. upsert one
   * item into an accumulated auth blob). The read-merge-write runs inside the
   * retry — each attempt re-reads the current value — so concurrent updates
   * don't overwrite each other with a stale snapshot. The mark binds to the
   * written result.
   */
  update<T>(
    cell: Cell<T>,
    mutate: (current: T | undefined) => T,
    channel: VouchedChannel,
  ): Promise<T> {
    return durableEdit(cell, (bound) => {
      // Clone before handing the value to `mutate` (see durableUpdate).
      const next = mutate(cloneValue(bound.get() as T | undefined));
      bound.set(next);
      return next;
    }, channel);
  },
} as const;
