# Runtime client

`RuntimeClient` connects a host to the Common Fabric runtime and renderer.

## Cell write acknowledgments

`CellHandle` exposes three overwrite contracts:

| Method        | Local display                                                                    | Promise completion                                    | Operation queue                                         |
| ------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `set()`       | Publishes an optimistic handle value immediately                                 | Request acknowledgment; transport failures are logged | Releases after acknowledgment                           |
| `setStrict()` | Publishes after commit if no newer write or delivery superseded it               | Commit outcome; rejects refusal                       | Holds subsequent operations until commit                |
| `setForUI()`  | The calling control owns its optimistic display; subscriptions update the handle | Commit outcome; rejects refusal                       | Releases after dispatch so subsequent input can proceed |

`setForUI()` is for controls that protect a pending local edit while observing
the stored value through a subscription. A matching value delivery can still be
speculative; the control retains that edit until the commit outcome arrives. A
refused write must release the edit and repaint from the bound state. The commit
promise is distinct from the subscription stream: resolving it does not itself
publish a value or guarantee that a component has rendered.

## Refused event admission

The `eventintentoutcome` event reports a refused event admission to every
accepted client attached to the runtime. Its payload contains `space` (a DID),
`eventId`, `kind: "refused"`, and `reason: "admission-refused"`. It contains no
event payload or server diagnostic text. Hosts scope their feedback to `space`
and can use `eventId` to distinguish outcomes.

A refusal means that the event was not admitted. It does not revoke read access,
and hosts can retain the space's rendered view. Authoritative access loss uses
`spaceaccesslost`. Events requiring recovery use `eventneedsattention` with
attention details.
