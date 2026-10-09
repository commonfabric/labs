/**
 * The control-plane verbs that bind an ingest channel to a Gmail mailbox, so
 * that Gmail push notifications for the mailbox reach the channel's cell,
 * and unbind it again. Only a `latest` channel binds: a push carries a
 * cursor, not a record anyone keeps, so the cell holds the newest one. The
 * binding store itself, and the data plane that reads it, are in
 * `routes/ingest-push/gmail-push.utils.ts`.
 *
 * Two proofs stand behind a binding: the caller owns the space the channel
 * writes into, which `loadOwned()` checks against the stored registration,
 * and the caller holds an access token Gmail accepts for the mailbox. Without
 * the second, anyone could bind someone else's address to a channel of their
 * own and learn when that person's mail arrives.
 */

import {
  channelRefusal,
  ClaimStoreFullError,
  isValidRequestId,
  peekMintRequest,
  RequestAlreadyClaimedError,
} from "@/routes/ingest/ingest.utils.ts";
import {
  BindingConflictError,
  bindMailbox,
  MailboxBindingFullError,
  type MailboxLookup,
  MAX_CHANNELS_PER_MAILBOX,
  unbindChannel,
} from "@/routes/ingest-push/gmail-push.utils.ts";
import {
  type ControlDeps,
  type ControlResult,
  loadOwned,
} from "./ingest-channels.utils.ts";

/** What the bind verb needs besides the ordinary control-plane dependencies. */
export interface GmailBindDeps extends ControlDeps {
  /** Asks Gmail which mailbox an access token reads. */
  fetchMailbox: (accessToken: string) => Promise<MailboxLookup>;
}

const INVALID_REQUEST_ID: ControlResult<never> = {
  status: 400,
  body: { error: "Invalid or missing requestId" },
};

const TOO_MANY_REQUESTS: ControlResult<never> = {
  status: 429,
  body: { error: "Too many recent requests — retry in a few minutes" },
};

/** Helper for both verbs, which builds the 409 for a request id already used. */
const replayed = (channel: string): ControlResult<never> => ({
  status: 409,
  body: {
    error: `requestId already used for channel ${channel}. Retry with a ` +
      "fresh requestId.",
  },
});

/**
 * Binds channel `input.id` to the mailbox `input.accessToken` reads, moving it
 * off any mailbox it was bound to before. The caller must own the channel's
 * space, and the channel must be live and a `latest` channel. The access
 * token is used for one profile lookup and kept nowhere. `input.space`, when
 * given, is the space the request was addressed to, and a channel writing
 * into any other is refused as an unowned one is.
 *
 * `input.requestId` makes the bind at most once: the proof on a request stays
 * valid for minutes, and without the id a late duplicate of an earlier bind
 * would move the channel back to the mailbox it named.
 */
export async function processGmailBind(
  deps: GmailBindDeps,
  callerDid: string,
  input: { id: string; accessToken: string; requestId: string; space?: string },
): Promise<ControlResult<{ id: string; emailAddress: string }>> {
  if (!isValidRequestId(input.requestId)) return INVALID_REQUEST_ID;
  const owned = await loadOwned(deps, callerDid, input.id, input.space);
  if (!owned.ok) return owned.result;
  if (channelRefusal(owned.registration) !== null) {
    return {
      status: 409,
      body: { error: "Channel is revoked or expired; it must be live to bind" },
    };
  }
  if (owned.registration.sink !== "latest") {
    return {
      status: 409,
      body: {
        error: "Channel is a journal; Gmail push writes to a `latest` " +
          'channel. Mint one with `sink: "latest"`',
      },
    };
  }

  // Advisory, so that a replay costs no request to Gmail. The check that
  // decides is the one `bindMailbox()` makes inside its transaction.
  try {
    const usedFor = await peekMintRequest(
      deps.runtime,
      deps.serviceSpace,
      callerDid,
      input.requestId,
    );
    if (usedFor !== null) return replayed(usedFor);
  } catch (error) {
    deps.logger?.error(
      { error, id: input.id },
      "gmail-bind: claim read failed",
    );
    return { status: 502, body: { error: "Storage failure" } };
  }

  const mailbox = await deps.fetchMailbox(input.accessToken);
  if (!mailbox.ok) {
    return mailbox.reason === "rejected"
      ? { status: 400, body: { error: "Gmail did not accept the token" } }
      : { status: 502, body: { error: "Gmail profile lookup failed" } };
  }

  try {
    await bindMailbox(
      deps.runtime,
      deps.serviceSpace,
      input.id,
      mailbox.emailAddress,
      { owner: callerDid, requestId: input.requestId, channel: input.id },
    );
  } catch (error) {
    if (error instanceof RequestAlreadyClaimedError) {
      return replayed(error.channel);
    }
    if (error instanceof ClaimStoreFullError) return TOO_MANY_REQUESTS;
    if (error instanceof MailboxBindingFullError) {
      return {
        status: 409,
        body: {
          error: `Mailbox already has ${MAX_CHANNELS_PER_MAILBOX} bound ` +
            "channels; unbind one first",
        },
      };
    }
    if (error instanceof BindingConflictError) {
      return {
        status: 409,
        body: { error: "Binding changed concurrently; try again" },
      };
    }
    deps.logger?.error({ error, id: input.id }, "gmail-bind: write failed");
    return { status: 502, body: { error: "Storage failure" } };
  }
  deps.logger?.info({ id: input.id }, "gmail-bind: bound a mailbox");
  return {
    status: 200,
    body: { id: input.id, emailAddress: mailbox.emailAddress },
  };
}

/**
 * Unbinds channel `input.id` from its mailbox. The caller must own the
 * channel's space; the channel need not be live, so that a revoked channel
 * can still be cleared. `unbound` says whether it was bound to anything.
 * `input.space` narrows as it does for `processGmailBind()`.
 *
 * `input.requestId` makes the unbind at most once, so that a late duplicate
 * cannot clear a binding made after the first one landed. An unbind whose id
 * cannot be recorded is refused for that reason: nothing else ties it to the
 * binding the caller saw. A caller refused here can still stop delivery by
 * revoking the channel.
 */
export async function processGmailUnbind(
  deps: ControlDeps,
  callerDid: string,
  input: { id: string; requestId: string; space?: string },
): Promise<ControlResult<{ id: string; unbound: boolean }>> {
  if (!isValidRequestId(input.requestId)) return INVALID_REQUEST_ID;
  const owned = await loadOwned(deps, callerDid, input.id, input.space);
  if (!owned.ok) return owned.result;

  const claim = {
    owner: callerDid,
    requestId: input.requestId,
    channel: input.id,
  };
  let unbound: boolean;
  try {
    unbound = await unbindChannel(
      deps.runtime,
      deps.serviceSpace,
      input.id,
      claim,
    );
  } catch (error) {
    if (error instanceof RequestAlreadyClaimedError) {
      return replayed(error.channel);
    }
    if (error instanceof ClaimStoreFullError) return TOO_MANY_REQUESTS;
    if (error instanceof BindingConflictError) {
      return {
        status: 409,
        body: { error: "Binding changed concurrently; try again" },
      };
    }
    deps.logger?.error({ error, id: input.id }, "gmail-unbind: write failed");
    return { status: 502, body: { error: "Storage failure" } };
  }
  return { status: 200, body: { id: input.id, unbound } };
}
