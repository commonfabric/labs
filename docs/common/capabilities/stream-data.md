# Streaming External Data

`streamData<T>()` consumes a server-sent event stream. It is a reactive node,
not a promise: never `await` it. The call returns the clean-close result as an
`AsyncResult<T>` and associates a live event channel selected with
`partialResultOf()`.

The type argument is required. `T` describes a complete decoded event and the
transformer derives the runtime validation schema from it.

```typescript
// Shown for illustration only.
type ProgressEvent = {
  id: string;
  event: string;
  data: { completed: number; total: number };
};

const request = streamData<ProgressEvent>({ url });
const finalEvent = resultOf(request);
const liveEvent = partialResultOf(request);

return hasError(request)
  ? <p>Stream failed: {request.errorMessage}</p>
  : isPending(request)
  ? <p>Live: {liveEvent.data.completed} / {liveEvent.data.total}</p>
  : <p>Closed: {finalEvent.data.completed} / {finalEvent.data.total}</p>;
```

Both the direct request and partial value begin pending at runtime. Each decoded
event updates the partial value. A computation consuming `liveEvent` waits for
the first event; the pending branch above distinguishes an open stream from a
closed one, rather than making the partial value optional. The direct request
remains pending until the stream closes cleanly, then becomes the last decoded
event. A stream which is expected to remain open normally consumes only
`partialResultOf(request)`; `finalEvent` is useful only after a clean close.

A clean close before the first event, an unsuccessful HTTP response, a
connection failure, malformed event data, or invalid JSON produces an error on
both channels. An event that does not match `T` produces `schemaMismatch` on
both. The runtime does not reconnect automatically. Changing `url`, `options`,
the explicit `schema`, or the inferred event schema starts a new request and
resets both channels to pending.

If the UI should retain the last usable event while a replacement connects or
after a failure, opt into that continuity explicitly:

```typescript
// Shown for illustration only.
const liveEvent = partialResultOf(request);
const lastUsableEvent = latestComplete(liveEvent);
```

`latestComplete()` starts pending until the first complete event and thereafter
keeps its last complete snapshot. Use the original request with `isPending()`,
`hasError()`, and the other availability guards.

Call `partialResultOf()` in the pattern body on the direct `streamData()` result
or a stable const alias. Bind its result to a standalone `const` before deriving
values from it or passing the projected value into `computed()`,
`lift()`, an action, or a handler. A child pattern that wants to expose both
channels should return its projected partial value as a separate output; the
association itself does not cross a subpattern boundary.
