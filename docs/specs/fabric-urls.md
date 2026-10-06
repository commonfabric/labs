# Common Fabric URLs

## Status

Concept design. No implementation or deployment is currently planned. The
document remains a reference for evaluating a future URL and naming system;
the [current shell routes](../../packages/shell/README.md#routes) remain
authoritative.

The [space name registry](../plans/space-name-registry.md) describes a
compatible implementation concept. It is also not planned for deployment.

## Goals

- Brands should have nice URLs.
- Users should be able to move spaces between ASPs, with redirects in place.
- Users should be able to set up short names for their spaces, in a
  first-come-first-served manner similar to how domains are sold in a TLD or
  how names are chosen in a shortlink redirector or URL shortener namespace.

### Non-goals

ASPs already have to deal with abuse reports for content, so it is a trivial
problem to add short names to their list of abuse concerns. Therefore, we are
not concerned with making names have deniability, or otherwise safeguarding the
creation of names from ASPs. ASPs will need to deal with squatting abuse,
rate-limiting name adoption, and similar concerns. The mechanisms to do this are
out of scope at this time.

### Technical constraints

An ASP runs multiple toolshed servers on the backend, but URL resolution must
be consistent regardless of which backend is handling a particular space.

## Proposal

### URL syntax

A fully resolved HTTPS URL to a Common Fabric server that does not resolve to
some higher-priority hosted resource can contain the following components:

- A host name and port, which are mandatory. This is the *initial server*, the
  server that will first attempt to resolve the URL.
- A namespace, which is optional.
- A space name or DID, which is optional and defaults to the empty string. The
  empty string is a valid value.
- A piece DID, which is optional.

Syntax:

```text
https://host.name[:port][/@namespace][/space[/piece]]
```

Components are percent-decoded before being handled.

A namespace is a lowercase ASCII DNS hostname without a trailing dot. Its
decoded form is between 1 and 253 bytes. Each dot-separated label is between 1
and 63 bytes, starts and ends with a lowercase ASCII letter or digit, and
otherwise contains only lowercase ASCII letters, digits, or `-`. Namespace
comparison is bytewise.

A short name is between 1 and 63 bytes after decoding. It starts and ends with
a lowercase ASCII letter or digit and otherwise contains only lowercase ASCII
letters, digits, or `-`. Short-name comparison is bytewise. Uppercase input is
invalid rather than normalized. Formatters emit the allowed characters
literally and never emit a percent-encoded alternative spelling.

Examples:

```text
https://example.com/
https://example.com/@commonfabric.com
https://example.com/@commonfabric.com/welcome
https://example.com/welcome
https://example.com/@commonfabric.com//of:fid1:ST7dtOTSpCwjrhPSeEsB-qhlAL4R5hmOGyQ2u2Zv1Bk
https://example.com/welcome/of:fid1:ST7dtOTSpCwjrhPSeEsB-qhlAL4R5hmOGyQ2u2Zv1Bk
https://example.net/did:key:z6MkjTHbNeWo9Y3BYF3f78Y6V6bmwK67NheUfgkpEGCAhN3w/of:fid1:1rE7dWo5nKaKrEtqYmlAlTg7J_UFeflUOMmPUIlwhAI
```

### Resolving the hostname

The hostname is considered the *initial server*.

### Namespaces identify providers

If a namespace is given, the *initial server* resolves it.

A namespace is looked up in DNS for a `FABRIC` record, using a new record type
number that is to be registered. If one valid `FABRIC` record is present, its
value is the HTTPS hostname of the *secondary server*. A valid value uses the
namespace hostname grammar above. Only a `FABRIC` record can direct a namespace
to a different hostname.

If no `FABRIC` record is present, the namespace itself is used verbatim as the
HTTPS hostname of the *secondary server*. A `FABRIC` response that is present
but does not contain exactly one valid hostname makes namespace resolution
fail.

If no namespace is provided, then the *secondary server* is the same as the
*initial server*.

If the *initial server* and *secondary server* are different, the *initial
server* redirects to an HTTPS URL using the *secondary server* as the host name,
with the same namespace, space, and piece.

### Resolving the space name

Classify the specified space component before combining it with a namespace. If
it is a syntactically valid space DID or the empty string, the *actual space
name* is that value. The namespace selects the secondary server but is not part
of the actual space name in either case.

Otherwise, the specified space component must be a valid short name. Its
*actual space name* is the registered name formed by concatenating an `@`, the
namespace, a `/`, and that short name when a namespace is present. Without a
namespace, its actual space name is the short name itself. Any other specified
space component makes resolution fail.

If the *actual space name* is a DID, the secondary server checks its registry
for a space-move redirect keyed by that DID. If one exists, the server
uses the recorded ASP as the next location in the move-redirect lookup.
Otherwise, the DID resolves to itself only when the secondary server's local
serving state permits it to serve that space. A missing move redirect alone
does not permit the server to open the DID. The lookup returns one HTTP redirect
to the terminal ASP, with the same DID and original piece, as described below.

The space storage and transfer system owns each ASP's local serving-state
record. The record says whether that ASP may serve the space DID and carries an
opaque revision that changes whenever service is enabled or disabled. Creating
a space establishes its first serving-state revision. The name registry reads
this record but does not create an independent serving decision.

If the *actual space name* is the empty string, it resolves to the DID of the
user's home space on the *secondary server*. The server then applies the same
space-DID resolution, including any space-move redirect.

Otherwise, the *actual space name* is a *registered name*. The secondary server
looks it up in its name registry and handles it as appropriate as described
below. Without a namespace it is a short name; with a namespace it has the
`@namespace/space` form.

Once resolution reaches the terminal ASP, that ASP supplies the resolved space
DID and the storage origin for that DID in its authenticated HTTPS response to
the shell. The response binds both values to the terminal ASP's local
serving-state revision. The shell accepts this route only from the terminal ASP
reached by resolution. It does not accept a storage origin from a URL parameter
or from an earlier ASP in the redirect chain. An ASP whose public origin is also
its storage origin supplies the same origin for both roles.

#### The name registry

The space name registry for an ASP holds registered-name entries and space-move
redirects. A registered-name entry maps to one of the following:

- a redirect to a namespace and space:
  - resolve the namespace to a new *secondary server*;
  - redirect to an HTTPS URL using the new secondary server as the host name,
    with the new namespace and space, and the original piece;
- a redirect to a short name on another server:
  - redirect to an HTTPS URL using the other server as the host name, with no
    namespace, the new short name as the space name, and the original piece;
- a redirect to a space DID on another server:
  - redirect to an HTTPS URL using the other server as the host name, with no
    namespace, the space DID as the space name, and the original piece;
- a space DID on the same server:
  - resolve the DID on the same server, including any space-move redirect for
    that DID.

A space-move redirect is keyed by a space DID and records the ASP to which that
space moved. The recorded ASP is the next location in the move-redirect lookup.
The lookup returns an HTTPS redirect to the terminal ASP, with the same space
DID and original piece. A space-move redirect is not a registered name. It has
no registration owner and is not considered when choosing a displayed name.
It preserves the continuation of requests that arrive through that ASP or an
earlier redirect in the same chain.

Every registered-name target that reaches a DID also applies space-DID
resolution. A name registered before a move therefore continues through the
space-move redirect without requiring the name entry to change.

##### Moving a space between ASPs

To move a space from one ASP, the user asks that source ASP to move the space
DID to a named destination ASP. The two ASPs connect through a separate transfer
mechanism. They transfer all data for the space and complete verification while
the source continues serving requests on that route. The destination is then
ready with the complete space, but does not yet serve requests for the
transferred route.

The transfer mechanism performs one protected handoff. On the source ASP, that
handoff makes a space-move redirect from the DID to the destination ASP visible
and prevents new service from the source copy. The destination begins serving
only after it verifies durable evidence that this handoff completed. An
interrupted handoff resumes from a durable transfer operation rather than
starting another move.

During the interval after the source publishes the redirect and before the
destination enables service, the destination reports temporary unavailability.
It does not open the destination copy before local service for the transferred
route is enabled.

The data transfer and route-handoff protocol are outside this document. That
protocol must not let the source registry advertise the destination until the
destination is ready to serve the complete space. It must not let the
destination serve the transferred route while the source remains able to serve
that route without redirecting.

A later move can leave a chain of ASP redirects. When a former ASP becomes the
destination again, it keeps its stale redirect active while data is prepared.
After it verifies the source's durable handoff evidence, it retires that
redirect and enables local service for the transferred route as one protected
local state change. A revision mismatch prevents activation. Requests fail
without opening the destination copy during any interval in which the redirect
chain is cyclic. A move whose destination is the source ASP is rejected.

Common Fabric servers follow the DID's move-redirect chain through
server-to-server registry lookups before returning an HTTP redirect. They
return one redirect to the terminal ASP. They report a repeated pair of ASP and
space DID as a redirect cycle.

##### Registering names

Users can register names for their spaces at any time. A space can have multiple
entries in the registry. To create a name with an `@` prefix, the user must have
demonstrated to the ASP that they own the corresponding namespace's DNS entry.
How this is achieved is out of scope for this document.

Names use the namespace and short-name grammar defined under URL syntax.

## URL presentation

Displayed-name selection uses the registry of the terminal ASP that serves the
loaded space. The terminal ASP is also the initial host in the displayed URL.
Names registered on an earlier ASP remain usable through its move redirect, but
they are not presentation candidates on the terminal ASP.

If one of that registry's entries is owned by the owner of the space, then the
most recently updated such entry is used to form the URL.

Otherwise, if one of the entries is owned by the current user, then the most
recently updated such entry is used to form the URL.

Otherwise, if the space is the user's home space, then the empty string is used
to form the space name in the URL.

Otherwise, the URL is formed out of the space's DID.

URLs are shown in the form:

```text
https://host.name[:port][/@namespace]/space[/piece]
```

The host name is the name of the ASP host. The port is included if it is not the
default port, 443. The namespace is included only if the space name used to form
the URL has a namespace component. The space to be included, which can be a
name, space DID, or empty string, is determined as described above. The piece is
the currently shown piece, unless it is the root piece of the space, in which
case it is omitted.

The browser must replace the currently rendered URL with this presentation URL
when the piece is loaded.
