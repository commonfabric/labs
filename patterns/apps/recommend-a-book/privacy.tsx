/** Reader-private state and the immutable identity of an invitation's creator. */

import {
  type Cfc,
  type Confidential,
  type CurrentPrincipal,
  handler,
  type RepresentsCurrentUser,
  type WriteAuthorizedBy,
} from "commonfabric";

/** A value readable only by the principal who creates its scoped instance. */
export type ReaderPrivate<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

/** Retains the creator's attestation without exposing a mutation operation. */
export const retainOriginator = handler<void, Record<string, never>>(() => {});

/** Stable creator attestation used by the host's sharing confirmation. */
export type OriginatorIdentity = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<Record<string, never>, typeof retainOriginator>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;
