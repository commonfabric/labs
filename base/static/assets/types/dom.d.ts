interface AddEventListenerOptions extends EventListenerOptions {
    once?: boolean;
    passive?: boolean;
    signal?: AbortSignal;
}   

interface BlobPropertyBag {
    endings?: EndingType;
    type?: string;
}

interface CacheQueryOptions {
    ignoreMethod?: boolean;
    ignoreSearch?: boolean;
    ignoreVary?: boolean;
}

interface CustomEventInit<T = any> extends EventInit {
    detail?: T;
}

interface ErrorEventInit extends EventInit {
    colno?: number;
    error?: any;
    filename?: string;
    lineno?: number;
    message?: string;
}

interface EventInit {
    bubbles?: boolean;
    cancelable?: boolean;
    composed?: boolean;
}

interface EventListenerOptions {
    capture?: boolean;
}

interface EventSourceInit {
    withCredentials?: boolean;
}

interface ExtendableEventInit extends EventInit {
}

interface FetchEventInit extends ExtendableEventInit {
    clientId?: string;
    handled?: Promise<void>;
    preloadResponse?: Promise<any>;
    request: Request;
    resultingClientId?: string;
}

interface MessageEventInit<T = any> extends EventInit {
    data?: T;
    lastEventId?: string;
    origin?: string;
    ports?: MessagePort[];
    source?: MessageEventSource | null;
}

interface PromiseRejectionEventInit extends EventInit {
    promise: Promise<any>;
    reason?: any;
}

interface QueuingStrategy<T = any> {
    highWaterMark?: number;
    size?: QueuingStrategySize<T>;
}

interface QueuingStrategyInit {
    /**
     * Creates a new ByteLengthQueuingStrategy with the provided high water mark.
     *
     * Note that the provided high water mark will not be validated ahead of time. Instead, if it is negative, NaN, or not a number, the resulting ByteLengthQueuingStrategy will cause the corresponding stream constructor to throw.
     */
    highWaterMark: number;
}

interface ReadableStreamGetReaderOptions {
    /**
     * Creates a ReadableStreamBYOBReader and locks the stream to the new reader.
     *
     * This call behaves the same way as the no-argument variant, except that it only works on readable byte streams, i.e. streams which were constructed specifically with the ability to handle "bring your own buffer" reading. The returned BYOB reader provides the ability to directly read individual chunks from the stream via its read() method, into developer-supplied buffers, allowing more precise control over allocation.
     */
    mode?: ReadableStreamReaderMode;
}

interface ReadableStreamIteratorOptions {
    /**
     * Asynchronously iterates over the chunks in the stream's internal queue.
     *
     * Asynchronously iterating over the stream will lock it, preventing any other consumer from acquiring a reader. The lock will be released if the async iterator's return() method is called, e.g. by breaking out of the loop.
     *
     * By default, calling the async iterator's return() method will also cancel the stream. To prevent this, use the stream's values() method, passing true for the preventCancel option.
     */
    preventCancel?: boolean;
}

interface ReadableStreamReadDoneResult<T> {
    done: true;
    value: T | undefined;
}

interface ReadableStreamReadValueResult<T> {
    done: false;
    value: T;
}

interface ReadableWritablePair<R = any, W = any> {
    readable: ReadableStream<R>;
    /**
     * Provides a convenient, chainable way of piping this readable stream through a transform stream (or any other { writable, readable } pair). It simply pipes the stream into the writable side of the supplied pair, and returns the readable side for further use.
     *
     * Piping a stream will lock it for the duration of the pipe, preventing any other consumer from acquiring a reader.
     */
    writable: WritableStream<W>;
}

interface RequestInit {
    /** A BodyInit object or null to set request's body. */
    body?: BodyInit | null;
    /** A string indicating how the request will interact with the browser's cache to set request's cache. */
    cache?: RequestCache;
    /** A string indicating whether credentials will be sent with the request always, never, or only when sent to a same-origin URL. Sets request's credentials. */
    credentials?: RequestCredentials;
    /** A Headers object, an object literal, or an array of two-item arrays to set request's headers. */
    headers?: HeadersInit;
    /** A cryptographic hash of the resource to be fetched by request. Sets request's integrity. */
    integrity?: string;
    /** A boolean to set request's keepalive. */
    keepalive?: boolean;
    /** A string to set request's method. */
    method?: string;
    /** A string to indicate whether the request will use CORS, or will be restricted to same-origin URLs. Sets request's mode. */
    mode?: RequestMode;
    priority?: RequestPriority;
    /** A string indicating whether request follows redirects, results in an error upon encountering a redirect, or returns the redirect (in an opaque fashion). Sets request's redirect. */
    redirect?: RequestRedirect;
    /** A string whose value is a same-origin URL, "about:client", or the empty string, to set request's referrer. */
    referrer?: string;
    /** A referrer policy to set request's referrerPolicy. */
    referrerPolicy?: ReferrerPolicy;
    /** An AbortSignal to set request's signal. */
    signal?: AbortSignal | null;
    /** Can only be null. Used to disassociate request from any Window. */
    window?: null;
}

interface ResponseInit {
    headers?: HeadersInit;
    status?: number;
    statusText?: string;
}

interface StreamPipeOptions {
    preventAbort?: boolean;
    preventCancel?: boolean;
    /**
     * Pipes this readable stream to a given writable stream destination. The way in which the piping process behaves under various error conditions can be customized with a number of passed options. It returns a promise that fulfills when the piping process completes successfully, or rejects if any errors were encountered.
     *
     * Piping a stream will lock it for the duration of the pipe, preventing any other consumer from acquiring a reader.
     *
     * Errors and closures of the source and destination streams propagate as follows:
     *
     * An error in this source readable stream will abort destination, unless preventAbort is truthy. The returned promise will be rejected with the source's error, or with any error that occurs during aborting the destination.
     *
     * An error in destination will cancel this source readable stream, unless preventCancel is truthy. The returned promise will be rejected with the destination's error, or with any error that occurs during canceling the source.
     *
     * When this source readable stream closes, destination will be closed, unless preventClose is truthy. The returned promise will be fulfilled once this process completes, unless an error is encountered while closing the destination, in which case it will be rejected with that error.
     *
     * If destination starts out closed or closing, this source readable stream will be canceled, unless preventCancel is true. The returned promise will be rejected with an error indicating piping to a closed stream failed, or with any error that occurs during canceling the source.
     *
     * The signal option can be set to an AbortSignal to allow aborting an ongoing pipe operation via the corresponding AbortController. In this case, this source readable stream will be canceled, and destination aborted, unless the respective options preventCancel or preventAbort are set.
     */
    preventClose?: boolean;
    signal?: AbortSignal;
}

interface StructuredSerializeOptions {
    transfer?: Transferable[];
}

interface TextDecodeOptions {
    stream?: boolean;
}

interface TextDecoderOptions {
    fatal?: boolean;
    ignoreBOM?: boolean;
}

interface TextEncoderEncodeIntoResult {
    read: number;
    written: number;
}

interface Transformer<I = any, O = any> {
    flush?: TransformerFlushCallback<O>;
    readableType?: undefined;
    start?: TransformerStartCallback<O>;
    transform?: TransformerTransformCallback<I, O>;
    writableType?: undefined;
}

interface UnderlyingByteSource {
    autoAllocateChunkSize?: number;
    cancel?: UnderlyingSourceCancelCallback;
    pull?: (controller: ReadableByteStreamController) => void | PromiseLike<void>;
    start?: (controller: ReadableByteStreamController) => any;
    type: "bytes";
}

interface UnderlyingDefaultSource<R = any> {
    cancel?: UnderlyingSourceCancelCallback;
    pull?: (controller: ReadableStreamDefaultController<R>) => void | PromiseLike<void>;
    start?: (controller: ReadableStreamDefaultController<R>) => any;
    type?: undefined;
}

interface UnderlyingSink<W = any> {
    abort?: UnderlyingSinkAbortCallback;
    close?: UnderlyingSinkCloseCallback;
    start?: UnderlyingSinkStartCallback;
    type?: undefined;
    write?: UnderlyingSinkWriteCallback<W>;
}

interface UnderlyingSource<R = any> {
    autoAllocateChunkSize?: number;
    cancel?: UnderlyingSourceCancelCallback;
    pull?: UnderlyingSourcePullCallback<R>;
    start?: UnderlyingSourceStartCallback<R>;
    type?: ReadableStreamType;
}

interface WriteParams {
    data?: BufferSource | Blob | string | null;
    position?: number | null;
    size?: number | null;
    type: WriteCommandType;
}

/**
 * The **`AbortController`** interface represents a controller object that allows you to abort one or more Web requests as and when desired.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortController)
 */
interface AbortController {
    /**
     * Returns the AbortSignal object associated with this object.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortController/signal)
     */
    readonly signal: AbortSignal;
    /**
     * Invoking this method will set this object's AbortSignal's aborted flag and signal to any observers that the associated activity is to be aborted.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortController/abort)
     */
    abort(reason?: any): void;
}

interface AbortSignalEventMap {
    "abort": Event;
}

/**
 * The **`AbortSignal`** interface represents a signal object that allows you to communicate with an asynchronous operation (such as a fetch request) and abort it if required via an AbortController object.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortSignal)
 */
interface AbortSignal extends EventTarget {
    /**
     * Returns true if this AbortSignal's AbortController has signaled to abort, and false otherwise.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortSignal/aborted)
     */
    readonly aborted: boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortSignal/abort_event) */
    onabort: ((this: AbortSignal, ev: Event) => any) | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortSignal/reason) */
    readonly reason: any;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortSignal/throwIfAborted) */
    throwIfAborted(): void;
    addEventListener<K extends keyof AbortSignalEventMap>(type: K, listener: (this: AbortSignal, ev: AbortSignalEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof AbortSignalEventMap>(type: K, listener: (this: AbortSignal, ev: AbortSignalEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/**
 * The **`Blob`** interface represents a blob, which is a file-like object of immutable, raw data; they can be read as text or binary data, or converted into a ReadableStream so its methods can be used for processing the data.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob)
 */
interface Blob {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/size) */
    readonly size: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/type) */
    readonly type: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/arrayBuffer) */
    arrayBuffer(): Promise<ArrayBuffer>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/bytes) */
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/slice) */
    slice(start?: number, end?: number, contentType?: string): Blob;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/stream) */
    stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/text) */
    text(): Promise<string>;
}

interface Body {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/body) */
    readonly body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/bodyUsed) */
    readonly bodyUsed: boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/arrayBuffer) */
    arrayBuffer(): Promise<ArrayBuffer>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/blob) */
    blob(): Promise<Blob>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/bytes) */
    bytes(): Promise<Uint8Array<ArrayBuffer>>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/formData) */
    // formData(): Promise<FormData>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/json) */
    json(): Promise<any>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/text) */
    text(): Promise<string>;
}

/**
 * The **`ByteLengthQueuingStrategy`** interface of the Streams API provides a built-in byte length queuing strategy that can be used when constructing streams.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ByteLengthQueuingStrategy)
 */
interface ByteLengthQueuingStrategy extends QueuingStrategy<ArrayBufferView> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ByteLengthQueuingStrategy/highWaterMark) */
    readonly highWaterMark: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ByteLengthQueuingStrategy/size) */
    readonly size: QueuingStrategySize<ArrayBufferView>;
}

/**
 * The **`CountQueuingStrategy`** interface of the Streams API provides a built-in chunk counting queuing strategy that can be used when constructing streams.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CountQueuingStrategy)
 */
interface CountQueuingStrategy extends QueuingStrategy {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/CountQueuingStrategy/highWaterMark) */
    readonly highWaterMark: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/CountQueuingStrategy/size) */
    readonly size: QueuingStrategySize;
}

/**
 * The **`CustomEvent`** interface represents events initialized by an application for any purpose.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CustomEvent)
 */
interface CustomEvent<T = any> extends Event {
    /**
     * Returns any custom data event was created with. Typically used for synthetic events.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CustomEvent/detail)
     */
    readonly detail: T;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/CustomEvent/initCustomEvent)
     */
    initCustomEvent(type: string, bubbles?: boolean, cancelable?: boolean, detail?: T): void;
}

/**
 * The **`DOMException`** interface represents an abnormal event (called an **exception**) that occurs as a result of calling a method or accessing a property of a web API.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/DOMException)
 */
interface DOMException extends Error {
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/DOMException/code)
     */
    readonly code: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/DOMException/message) */
    readonly message: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/DOMException/name) */
    readonly name: string;
    readonly INDEX_SIZE_ERR: 1;
    readonly DOMSTRING_SIZE_ERR: 2;
    readonly HIERARCHY_REQUEST_ERR: 3;
    readonly WRONG_DOCUMENT_ERR: 4;
    readonly INVALID_CHARACTER_ERR: 5;
    readonly NO_DATA_ALLOWED_ERR: 6;
    readonly NO_MODIFICATION_ALLOWED_ERR: 7;
    readonly NOT_FOUND_ERR: 8;
    readonly NOT_SUPPORTED_ERR: 9;
    readonly INUSE_ATTRIBUTE_ERR: 10;
    readonly INVALID_STATE_ERR: 11;
    readonly SYNTAX_ERR: 12;
    readonly INVALID_MODIFICATION_ERR: 13;
    readonly NAMESPACE_ERR: 14;
    readonly INVALID_ACCESS_ERR: 15;
    readonly VALIDATION_ERR: 16;
    readonly TYPE_MISMATCH_ERR: 17;
    readonly SECURITY_ERR: 18;
    readonly NETWORK_ERR: 19;
    readonly ABORT_ERR: 20;
    readonly URL_MISMATCH_ERR: 21;
    readonly QUOTA_EXCEEDED_ERR: 22;
    readonly TIMEOUT_ERR: 23;
    readonly INVALID_NODE_TYPE_ERR: 24;
    readonly DATA_CLONE_ERR: 25;
}

/**
 * The **`ErrorEvent`** interface represents events providing information related to errors in scripts or in files.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ErrorEvent)
 */
interface ErrorEvent extends Event {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ErrorEvent/colno) */
    readonly colno: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ErrorEvent/error) */
    readonly error: any;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ErrorEvent/filename) */
    readonly filename: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ErrorEvent/lineno) */
    readonly lineno: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ErrorEvent/message) */
    readonly message: string;
}

/**
 * The **`Event`** interface represents an event which takes place on an `EventTarget`.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event)
 */
interface Event {
    /**
     * Returns true or false depending on how event was initialized. True if event goes through its target's ancestors in reverse tree order, and false otherwise.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/bubbles)
     */
    readonly bubbles: boolean;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/cancelBubble)
     */
    cancelBubble: boolean;
    /**
     * Returns true or false depending on how event was initialized. Its return value does not always carry meaning, but true can indicate that part of the operation during which event was dispatched, can be canceled by invoking the preventDefault() method.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/cancelable)
     */
    readonly cancelable: boolean;
    /**
     * Returns true or false depending on how event was initialized. True if event invokes listeners past a ShadowRoot node that is the root of its target, and false otherwise.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/composed)
     */
    readonly composed: boolean;
    /**
     * Returns the object whose event listener's callback is currently being invoked.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/currentTarget)
     */
    readonly currentTarget: EventTarget | null;
    /**
     * Returns true if preventDefault() was invoked successfully to indicate cancelation, and false otherwise.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/defaultPrevented)
     */
    readonly defaultPrevented: boolean;
    /**
     * Returns the event's phase, which is one of NONE, CAPTURING_PHASE, AT_TARGET, and BUBBLING_PHASE.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/eventPhase)
     */
    readonly eventPhase: number;
    /**
     * Returns true if event was dispatched by the user agent, and false otherwise.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/isTrusted)
     */
    readonly isTrusted: boolean;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/returnValue)
     */
    returnValue: boolean;
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/srcElement)
     */
    readonly srcElement: EventTarget | null;
    /**
     * Returns the object to which event is dispatched (its target).
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/target)
     */
    readonly target: EventTarget | null;
    /**
     * Returns the event's timestamp as the number of milliseconds measured relative to the time origin.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/timeStamp)
     */
    readonly timeStamp: DOMHighResTimeStamp;
    /**
     * Returns the type of event, e.g. "click", "hashchange", or "submit".
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/type)
     */
    readonly type: string;
    /**
     * Returns the invocation target objects of event's path (objects on which listeners will be invoked), except for any nodes in shadow trees of which the shadow root's mode is "closed" that are not reachable from event's currentTarget.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/composedPath)
     */
    composedPath(): EventTarget[];
    /**
     * @deprecated
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/initEvent)
     */
    initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void;
    /**
     * If invoked when the cancelable attribute value is true, and while executing a listener for the event with passive set to false, signals to the operation that caused event to be dispatched that it needs to be canceled.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/preventDefault)
     */
    preventDefault(): void;
    /**
     * Invoking this method prevents event from reaching any registered event listeners after the current one finishes running and, when dispatched in a tree, also prevents event from reaching any other objects.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/stopImmediatePropagation)
     */
    stopImmediatePropagation(): void;
    /**
     * When dispatched in a tree, invoking this method prevents event from reaching any objects other than the current object.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event/stopPropagation)
     */
    stopPropagation(): void;
    readonly NONE: 0;
    readonly CAPTURING_PHASE: 1;
    readonly AT_TARGET: 2;
    readonly BUBBLING_PHASE: 3;
}

interface EventListener {
    (evt: Event): void;
}

interface EventListenerObject {
    handleEvent(object: Event): void;
}

interface EventSourceEventMap {
    "error": Event;
    "message": MessageEvent;
    "open": Event;
}

/**
 * The **`EventSource`** interface is web content's interface to server-sent events.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource)
 */
interface EventSource extends EventTarget {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/error_event) */
    onerror: ((this: EventSource, ev: Event) => any) | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/message_event) */
    onmessage: ((this: EventSource, ev: MessageEvent) => any) | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/open_event) */
    onopen: ((this: EventSource, ev: Event) => any) | null;
    /**
     * Returns the state of this EventSource object's connection. It can have the values described below.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/readyState)
     */
    readonly readyState: number;
    /**
     * Returns the URL providing the event stream.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/url)
     */
    readonly url: string;
    /**
     * Returns true if the credentials mode for connection requests to the URL providing the event stream is set to "include", and false otherwise.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/withCredentials)
     */
    readonly withCredentials: boolean;
    /**
     * Aborts any instances of the fetch algorithm started for this EventSource object, and sets the readyState attribute to CLOSED.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventSource/close)
     */
    close(): void;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSED: 2;
    addEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (this: EventSource, ev: EventSourceEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: (this: EventSource, event: MessageEvent) => any, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (this: EventSource, ev: EventSourceEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: (this: EventSource, event: MessageEvent) => any, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/**
 * The **`EventTarget`** interface is implemented by objects that can receive events and may have listeners for them.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventTarget)
 */
interface EventTarget {
    /**
     * Appends an event listener for events whose type attribute value is type. The callback argument sets the callback that will be invoked when the event is dispatched.
     *
     * The options argument sets listener-specific options. For compatibility this can be a boolean, in which case the method behaves exactly as if the value was specified as options's capture.
     *
     * When set to true, options's capture prevents callback from being invoked when the event's eventPhase attribute value is BUBBLING_PHASE. When false (or not present), callback will not be invoked when event's eventPhase attribute value is CAPTURING_PHASE. Either way, callback will be invoked if event's eventPhase attribute value is AT_TARGET.
     *
     * When set to true, options's passive indicates that the callback will not cancel the event by invoking preventDefault(). This is used to enable performance optimizations described in § 2.8 Observing event listeners.
     *
     * When set to true, options's once indicates that the callback will only be invoked once after which the event listener will be removed.
     *
     * If an AbortSignal is passed for options's signal, then the event listener will be removed when signal is aborted.
     *
     * The event listener is appended to target's event listener list and is not appended if it has the same type, callback, and capture.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventTarget/addEventListener)
     */
    addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void;
    /**
     * Dispatches a synthetic event event to target and returns true if either event's cancelable attribute value is false or its preventDefault() method was not invoked, and false otherwise.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventTarget/dispatchEvent)
     */
    dispatchEvent(event: Event): boolean;
    /**
     * Removes the event listener in target's event listener list with the same type, callback, and options.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/EventTarget/removeEventListener)
     */
    removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void;
}

interface GenericTransformStream {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/CompressionStream/readable) */
    readonly readable: ReadableStream;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/CompressionStream/writable) */
    readonly writable: WritableStream;
}

/**
 * The **`Headers`** interface of the Fetch API allows you to perform various actions on HTTP request and response headers.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Headers)
 */
interface Headers {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Headers/append) */
    append(name: string, value: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Headers/delete) */
    delete(name: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Headers/get) */
    get(name: string): string | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Headers/getSetCookie) */
    getSetCookie(): string[];
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Headers/has) */
    has(name: string): boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Headers/set) */
    set(name: string, value: string): void;
    forEach(callbackfn: (value: string, key: string, parent: Headers) => void, thisArg?: any): void;
}

/**
 * The **`MessageChannel`** interface of the Channel Messaging API allows us to create a new message channel and send data through it via its two MessagePort properties.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageChannel)
 */
interface MessageChannel {
    /**
     * Returns the first MessagePort object.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageChannel/port1)
     */
    readonly port1: MessagePort;
    /**
     * Returns the second MessagePort object.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageChannel/port2)
     */
    readonly port2: MessagePort;
}

/**
 * The **`MessageEvent`** interface represents a message received by a target object.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent)
 */
interface MessageEvent<T = any> extends Event {
    /**
     * Returns the data of the message.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/data)
     */
    readonly data: T;
    /**
     * Returns the last event ID string, for server-sent events.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/lastEventId)
     */
    readonly lastEventId: string;
    /**
     * Returns the origin of the message, for server-sent events and cross-document messaging.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/origin)
     */
    readonly origin: string;
    /**
     * Returns the MessagePort array sent with the message, for cross-document messaging and channel messaging.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/ports)
     */
    readonly ports: ReadonlyArray<MessagePort>;
    /**
     * Returns the WindowProxy of the source window, for cross-document messaging, and the MessagePort being attached, in the connect event fired at SharedWorkerGlobalScope objects.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/source)
     */
    readonly source: MessageEventSource | null;
    /** @deprecated */
    initMessageEvent(type: string, bubbles?: boolean, cancelable?: boolean, data?: any, origin?: string, lastEventId?: string, source?: MessageEventSource | null, ports?: MessagePort[]): void;
}

interface MessageEventTargetEventMap {
    "message": MessageEvent;
    "messageerror": MessageEvent;
}

interface MessageEventTarget<T> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/DedicatedWorkerGlobalScope/message_event) */
    onmessage: ((this: T, ev: MessageEvent) => any) | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/DedicatedWorkerGlobalScope/messageerror_event) */
    onmessageerror: ((this: T, ev: MessageEvent) => any) | null;
    addEventListener<K extends keyof MessageEventTargetEventMap>(type: K, listener: (this: T, ev: MessageEventTargetEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof MessageEventTargetEventMap>(type: K, listener: (this: T, ev: MessageEventTargetEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

interface MessagePortEventMap extends MessageEventTargetEventMap {
    "message": MessageEvent;
    "messageerror": MessageEvent;
}

/**
 * The **`MessagePort`** interface of the Channel Messaging API represents one of the two ports of a MessageChannel, allowing messages to be sent from one port and listening out for them arriving at the other.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessagePort)
 */
interface MessagePort extends EventTarget, MessageEventTarget<MessagePort> {
    /**
     * Disconnects the port, so that it is no longer active.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessagePort/close)
     */
    close(): void;
    /**
     * Posts a message through the channel. Objects listed in transfer are transferred, not just cloned, meaning that they are no longer usable on the sending side.
     *
     * Throws a "DataCloneError" DOMException if transfer contains duplicate objects or port, or if message could not be cloned.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessagePort/postMessage)
     */
    postMessage(message: any, transfer: Transferable[]): void;
    postMessage(message: any, options?: StructuredSerializeOptions): void;
    /**
     * Begins dispatching messages received on the port.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessagePort/start)
     */
    start(): void;
    addEventListener<K extends keyof MessagePortEventMap>(type: K, listener: (this: MessagePort, ev: MessagePortEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof MessagePortEventMap>(type: K, listener: (this: MessagePort, ev: MessagePortEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/**
 * The **`PromiseRejectionEvent`** interface represents events which are sent to the global script context when JavaScript Promises are rejected.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/PromiseRejectionEvent)
 */
interface PromiseRejectionEvent extends Event {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/PromiseRejectionEvent/promise) */
    readonly promise: Promise<any>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/PromiseRejectionEvent/reason) */
    readonly reason: any;
}

/**
 * The **`ReadableByteStreamController`** interface of the Streams API represents a controller for a readable byte stream.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableByteStreamController)
 */
interface ReadableByteStreamController {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableByteStreamController/byobRequest) */
    readonly byobRequest: ReadableStreamBYOBRequest | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableByteStreamController/desiredSize) */
    readonly desiredSize: number | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableByteStreamController/close) */
    close(): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableByteStreamController/enqueue) */
    enqueue(chunk: ArrayBufferView<ArrayBuffer>): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableByteStreamController/error) */
    error(e?: any): void;
}

/**
 * The `ReadableStream` interface of the Streams API represents a readable stream of byte data.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStream)
 */
interface ReadableStream<R = any> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStream/locked) */
    readonly locked: boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStream/cancel) */
    cancel(reason?: any): Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStream/getReader) */
    getReader(options: { mode: "byob" }): ReadableStreamBYOBReader;
    getReader(): ReadableStreamDefaultReader<R>;
    getReader(options?: ReadableStreamGetReaderOptions): ReadableStreamReader<R>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStream/pipeThrough) */
    pipeThrough<T>(transform: ReadableWritablePair<T, R>, options?: StreamPipeOptions): ReadableStream<T>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStream/pipeTo) */
    pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStream/tee) */
    tee(): [ReadableStream<R>, ReadableStream<R>];
}

/**
 * The `ReadableStreamBYOBReader` interface of the Streams API defines a reader for a ReadableStream that supports zero-copy reading from an underlying byte source.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBReader)
 */
interface ReadableStreamBYOBReader extends ReadableStreamGenericReader {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBReader/read) */
    read<T extends ArrayBufferView>(view: T): Promise<ReadableStreamReadResult<T>>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBReader/releaseLock) */
    releaseLock(): void;
}

/**
 * The **`ReadableStreamBYOBRequest`** interface of the Streams API represents a 'pull request' for data from an underlying source that will made as a zero-copy transfer to a consumer (bypassing the stream's internal queues).
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBRequest)
 */
interface ReadableStreamBYOBRequest {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBRequest/view) */
    readonly view: ArrayBufferView<ArrayBuffer> | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBRequest/respond) */
    respond(bytesWritten: number): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBRequest/respondWithNewView) */
    respondWithNewView(view: ArrayBufferView<ArrayBuffer>): void;
}

/**
 * The **`ReadableStreamDefaultController`** interface of the Streams API represents a controller allowing control of a ReadableStream's state and internal queue.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultController)
 */
interface ReadableStreamDefaultController<R = any> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultController/desiredSize) */
    readonly desiredSize: number | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultController/close) */
    close(): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultController/enqueue) */
    enqueue(chunk?: R): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultController/error) */
    error(e?: any): void;
}

/**
 * The **`ReadableStreamDefaultReader`** interface of the Streams API represents a default reader that can be used to read stream data supplied from a network (such as a fetch request).
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultReader)
 */
interface ReadableStreamDefaultReader<R = any> extends ReadableStreamGenericReader {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultReader/read) */
    read(): Promise<ReadableStreamReadResult<R>>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamDefaultReader/releaseLock) */
    releaseLock(): void;
}

interface ReadableStreamGenericReader {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBReader/closed) */
    readonly closed: Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/ReadableStreamBYOBReader/cancel) */
    cancel(reason?: any): Promise<void>;
}

/**
 * The **`Request`** interface of the Fetch API represents a resource request.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request)
 */
interface Request extends Body {
    /**
     * Returns the cache mode associated with request, which is a string indicating how the request will interact with the browser's cache when fetching.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/cache)
     */
    readonly cache: RequestCache;
    /**
     * Returns the credentials mode associated with request, which is a string indicating whether credentials will be sent with the request always, never, or only when sent to a same-origin URL.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/credentials)
     */
    readonly credentials: RequestCredentials;
    /**
     * Returns the kind of resource requested by request, e.g., "document" or "script".
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/destination)
     */
    readonly destination: RequestDestination;
    /**
     * Returns a Headers object consisting of the headers associated with request. Note that headers added in the network layer by the user agent will not be accounted for in this object, e.g., the "Host" header.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/headers)
     */
    readonly headers: Headers;
    /**
     * Returns request's subresource integrity metadata, which is a cryptographic hash of the resource being fetched. Its value consists of multiple hashes separated by whitespace. [SRI]
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/integrity)
     */
    readonly integrity: string;
    /**
     * Returns a boolean indicating whether or not request can outlive the global in which it was created.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/keepalive)
     */
    readonly keepalive: boolean;
    /**
     * Returns request's HTTP method, which is "GET" by default.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/method)
     */
    readonly method: string;
    /**
     * Returns the mode associated with request, which is a string indicating whether the request will use CORS, or will be restricted to same-origin URLs.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/mode)
     */
    readonly mode: RequestMode;
    /**
     * Returns the redirect mode associated with request, which is a string indicating how redirects for the request will be handled during fetching. A request will follow redirects by default.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/redirect)
     */
    readonly redirect: RequestRedirect;
    /**
     * Returns the referrer of request. Its value can be a same-origin URL if explicitly set in init, the empty string to indicate no referrer, and "about:client" when defaulting to the global's default. This is used during fetching to determine the value of the `Referer` header of the request being made.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/referrer)
     */
    readonly referrer: string;
    /**
     * Returns the referrer policy associated with request. This is used during fetching to compute the value of the request's referrer.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/referrerPolicy)
     */
    readonly referrerPolicy: ReferrerPolicy;
    /**
     * Returns the signal associated with request, which is an AbortSignal object indicating whether or not request has been aborted, and its abort event handler.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/signal)
     */
    readonly signal: AbortSignal;
    /**
     * Returns the URL of request as a string.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/url)
     */
    readonly url: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Request/clone) */
    clone(): Request;
}

/**
 * The **`Response`** interface of the Fetch API represents the response to a request.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response)
 */
interface Response extends Body {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/headers) */
    readonly headers: Headers;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/ok) */
    readonly ok: boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/redirected) */
    readonly redirected: boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/status) */
    readonly status: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/statusText) */
    readonly statusText: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/type) */
    readonly type: ResponseType;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/url) */
    readonly url: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Response/clone) */
    clone(): Response;
}

/**
 * The **`TextDecoder`** interface represents a decoder for a specific text encoding, such as `UTF-8`, `ISO-8859-2`, `KOI8-R`, `GBK`, etc.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextDecoder)
 */
interface TextDecoder extends TextDecoderCommon {
    /**
     * Returns the result of running encoding's decoder. The method can be invoked zero or more times with options's stream set to true, and then once without options's stream (or set to false), to process a fragmented input. If the invocation without options's stream (or set to false) has no input, it's clearest to omit both arguments.
     *
     * ```
     * var string = "", decoder = new TextDecoder(encoding), buffer;
     * while(buffer = next_chunk()) {
     *   string += decoder.decode(buffer, {stream:true});
     * }
     * string += decoder.decode(); // end-of-queue
     * ```
     *
     * If the error mode is "fatal" and encoding's decoder returns error, throws a TypeError.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextDecoder/decode)
     */
    decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string;
}

declare var TextDecoder: {
    prototype: TextDecoder;
    new(label?: string, options?: TextDecoderOptions): TextDecoder;
};

interface TextDecoderCommon {
    /**
     * Returns encoding's name, lowercased.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextDecoder/encoding)
     */
    readonly encoding: string;
    /**
     * Returns true if error mode is "fatal", otherwise false.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextDecoder/fatal)
     */
    readonly fatal: boolean;
    /**
     * Returns the value of ignore BOM.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextDecoder/ignoreBOM)
     */
    readonly ignoreBOM: boolean;
}

/**
 * The **`TextDecoderStream`** interface of the Encoding API converts a stream of text in a binary encoding, such as UTF-8 etc., to a stream of strings.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextDecoderStream)
 */
interface TextDecoderStream extends GenericTransformStream, TextDecoderCommon {
    readonly readable: ReadableStream<string>;
    readonly writable: WritableStream<BufferSource>;
}

/**
 * The **`TextEncoder`** interface takes a stream of code points as input and emits a stream of UTF-8 bytes.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextEncoder)
 */
interface TextEncoder extends TextEncoderCommon {
    /**
     * Returns the result of running UTF-8's encoder.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextEncoder/encode)
     */
    encode(input?: string): Uint8Array<ArrayBuffer>;
    /**
     * Runs the UTF-8 encoder on source, stores the result of that operation into destination, and returns the progress made as an object wherein read is the number of converted code units of source and written is the number of bytes modified in destination.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextEncoder/encodeInto)
     */
    encodeInto(source: string, destination: Uint8Array<ArrayBufferLike>): TextEncoderEncodeIntoResult;
}

declare var TextEncoder: {
    prototype: TextEncoder;
    new(): TextEncoder;
};

interface TextEncoderCommon {
    /**
     * Returns "utf-8".
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextEncoder/encoding)
     */
    readonly encoding: string;
}

/**
 * The **`TextEncoderStream`** interface of the Encoding API converts a stream of strings into bytes in the UTF-8 encoding.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TextEncoderStream)
 */
interface TextEncoderStream extends GenericTransformStream, TextEncoderCommon {
    readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: WritableStream<string>;
}

/**
 * The **`TransformStream`** interface of the Streams API represents a concrete implementation of the pipe chain _transform stream_ concept.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStream)
 */
interface TransformStream<I = any, O = any> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStream/readable) */
    readonly readable: ReadableStream<O>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStream/writable) */
    readonly writable: WritableStream<I>;
}

/**
 * The **`TransformStreamDefaultController`** interface of the Streams API provides methods to manipulate the associated ReadableStream and WritableStream.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStreamDefaultController)
 */
interface TransformStreamDefaultController<O = any> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStreamDefaultController/desiredSize) */
    readonly desiredSize: number | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStreamDefaultController/enqueue) */
    enqueue(chunk?: O): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStreamDefaultController/error) */
    error(reason?: any): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/TransformStreamDefaultController/terminate) */
    terminate(): void;
}

/**
 * The **`URL`** interface is used to parse, construct, normalize, and encode URL.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL)
 */
interface URL {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/hash) */
    hash: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/host) */
    host: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/hostname) */
    hostname: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/href) */
    href: string;
    toString(): string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/origin) */
    readonly origin: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/password) */
    password: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/pathname) */
    pathname: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/port) */
    port: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/protocol) */
    protocol: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/search) */
    search: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/searchParams) */
    readonly searchParams: URLSearchParams;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/username) */
    username: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/toJSON) */
    toJSON(): string;
}

declare var URL: {
    prototype: URL;
    new(url: string | URL, base?: string | URL): URL;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/canParse_static) */
    canParse(url: string | URL, base?: string | URL): boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/createObjectURL_static) */
    createObjectURL(obj: Blob): string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/parse_static) */
    parse(url: string | URL, base?: string | URL): URL | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/revokeObjectURL_static) */
    revokeObjectURL(url: string): void;
};

/**
 * The **`URLSearchParams`** interface defines utility methods to work with the query string of a URL.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams)
 */
interface URLSearchParams {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/size) */
    readonly size: number;
    /**
     * Appends a specified key/value pair as a new search parameter.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/append)
     */
    append(name: string, value: string): void;
    /**
     * Deletes the given search parameter, and its associated value, from the list of all search parameters.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/delete)
     */
    delete(name: string, value?: string): void;
    /**
     * Returns the first value associated to the given search parameter.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/get)
     */
    get(name: string): string | null;
    /**
     * Returns all the values association with a given search parameter.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/getAll)
     */
    getAll(name: string): string[];
    /**
     * Returns a Boolean indicating if such a search parameter exists.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/has)
     */
    has(name: string, value?: string): boolean;
    /**
     * Sets the value associated to a given search parameter to the given value. If there were several values, delete the others.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/set)
     */
    set(name: string, value: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URLSearchParams/sort) */
    sort(): void;
    /** Returns a string containing a query string suitable for use in a URL. Does not include the question mark. */
    toString(): string;
    forEach(callbackfn: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: any): void;
}

declare var URLSearchParams: {
    prototype: URLSearchParams;
    new(init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams;
};

/**
 * The **`WritableStream`** interface of the Streams API provides a standard abstraction for writing streaming data to a destination, known as a sink.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStream)
 */
interface WritableStream<W = any> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStream/locked) */
    readonly locked: boolean;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStream/abort) */
    abort(reason?: any): Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStream/close) */
    close(): Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStream/getWriter) */
    getWriter(): WritableStreamDefaultWriter<W>;
}

/**
 * The **`WritableStreamDefaultController`** interface of the Streams API represents a controller allowing control of a WritableStream's state.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultController)
 */
interface WritableStreamDefaultController {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultController/signal) */
    readonly signal: AbortSignal;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultController/error) */
    error(e?: any): void;
}

/**
 * The **`WritableStreamDefaultWriter`** interface of the Streams API is the object returned by WritableStream.getWriter() and once created locks the writer to the `WritableStream` ensuring that no other streams can write to the underlying sink.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter)
 */
interface WritableStreamDefaultWriter<W = any> {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter/closed) */
    readonly closed: Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter/desiredSize) */
    readonly desiredSize: number | null;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter/ready) */
    readonly ready: Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter/abort) */
    abort(reason?: any): Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter/close) */
    close(): Promise<void>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter/releaseLock) */
    releaseLock(): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WritableStreamDefaultWriter/write) */
    write(chunk?: W): Promise<void>;
}

/** The **`console`** object provides access to the debugging console (e.g., the Web console in Firefox). */
/**
 * The **`console`** object provides access to the debugging console (e.g., the Web console in Firefox).
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/console)
 */
interface Console {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/assert_static) */
    assert(condition?: boolean, ...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/clear_static) */
    clear(): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/count_static) */
    count(label?: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/countReset_static) */
    countReset(label?: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/debug_static) */
    debug(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/dir_static) */
    dir(item?: any, options?: any): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/dirxml_static) */
    dirxml(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/error_static) */
    error(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/group_static) */
    group(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/groupCollapsed_static) */
    groupCollapsed(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/groupEnd_static) */
    groupEnd(): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/info_static) */
    info(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/log_static) */
    log(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/table_static) */
    table(tabularData?: any, properties?: string[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/time_static) */
    time(label?: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/timeEnd_static) */
    timeEnd(label?: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/timeLog_static) */
    timeLog(label?: string, ...data: any[]): void;
    timeStamp(label?: string): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/trace_static) */
    trace(...data: any[]): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/warn_static) */
    warn(...data: any[]): void;
}

declare var console: Console;

interface OnErrorEventHandlerNonNull {
    (event: Event | string, source?: string, lineno?: number, colno?: number, error?: Error): any;
}

interface QueuingStrategySize<T = any> {
    (chunk: T): number;
}

interface TransformerFlushCallback<O> {
    (controller: TransformStreamDefaultController<O>): void | PromiseLike<void>;
}

interface TransformerStartCallback<O> {
    (controller: TransformStreamDefaultController<O>): any;
}

interface TransformerTransformCallback<I, O> {
    (chunk: I, controller: TransformStreamDefaultController<O>): void | PromiseLike<void>;
}

interface UnderlyingSinkAbortCallback {
    (reason?: any): void | PromiseLike<void>;
}

interface UnderlyingSinkCloseCallback {
    (): void | PromiseLike<void>;
}

interface UnderlyingSinkStartCallback {
    (controller: WritableStreamDefaultController): any;
}

interface UnderlyingSinkWriteCallback<W> {
    (chunk: W, controller: WritableStreamDefaultController): void | PromiseLike<void>;
}

interface UnderlyingSourceCancelCallback {
    (reason?: any): void | PromiseLike<void>;
}

interface UnderlyingSourcePullCallback<R> {
    (controller: ReadableStreamController<R>): void | PromiseLike<void>;
}

interface UnderlyingSourceStartCallback<R> {
    (controller: ReadableStreamController<R>): any;
}

interface VoidFunction {
    (): void;
}

interface WorkerGlobalScope {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/atob) */
    atob(data: string): string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/btoa) */
    btoa(data: string): string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/clearInterval) */
    clearInterval(id: number | undefined): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/clearTimeout) */
    clearTimeout(id: number | undefined): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch) */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/queueMicrotask) */
    queueMicrotask(callback: VoidFunction): void;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/setInterval) */
    setInterval(handler: TimerHandler, timeout?: number, ...arguments: any[]): number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/setTimeout) */
    setTimeout(handler: TimerHandler, timeout?: number, ...arguments: any[]): number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/structuredClone) */
    structuredClone<T = any>(value: T, options?: StructuredSerializeOptions): T;
}


/**
 * Returns workerGlobal.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WorkerGlobalScope/self)
 */
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/atob) */
declare function atob(data: string): string;
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/btoa) */
declare function btoa(data: string): string;
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/clearInterval) */
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/clearTimeout) */
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch) */
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/queueMicrotask) */
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/setInterval) */
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/setTimeout) */
/** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/structuredClone) */
declare function structuredClone<T = any>(value: T, options?: StructuredSerializeOptions): T;
type AllowSharedBufferSource = ArrayBufferLike | ArrayBufferView<ArrayBufferLike>;
type BigInteger = Uint8Array<ArrayBuffer>;
type BlobPart = BufferSource | Blob | string;
type BodyInit = ReadableStream | XMLHttpRequestBodyInit;
type BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer;
type DOMHighResTimeStamp = number;
type EpochTimeStamp = number;
type EventListenerOrEventListenerObject = EventListener | EventListenerObject;
type HeadersInit = [string, string][] | Record<string, string> | Headers;
type MessageEventSource = MessagePort;
type OnErrorEventHandler = OnErrorEventHandlerNonNull | null;
type PushMessageDataInit = BufferSource | string;
type ReadableStreamController<T> = ReadableStreamDefaultController<T> | ReadableByteStreamController;
type ReadableStreamReadResult<T> = ReadableStreamReadValueResult<T> | ReadableStreamReadDoneResult<T>;
type ReadableStreamReader<T> = ReadableStreamDefaultReader<T> | ReadableStreamBYOBReader;
type RequestInfo = Request | string;
type TimerHandler = string | Function;
type Transferable = MessagePort | ReadableStream | WritableStream | TransformStream | ArrayBuffer;
type BinaryType = "arraybuffer" | "blob";
type BitrateMode = "constant" | "variable";
type CompressionFormat = "deflate" | "deflate-raw" | "gzip";
type DocumentVisibilityState = "hidden" | "visible";
type EncodedAudioChunkType = "delta" | "key";
type EncodedVideoChunkType = "delta" | "key";
type EndingType = "native" | "transparent";
type FrameType = "auxiliary" | "nested" | "none" | "top-level";
type LatencyMode = "quality" | "realtime";
type ReadableStreamReaderMode = "byob";
type ReadableStreamType = "bytes";
type ReferrerPolicy = "" | "no-referrer" | "no-referrer-when-downgrade" | "origin" | "origin-when-cross-origin" | "same-origin" | "strict-origin" | "strict-origin-when-cross-origin" | "unsafe-url";
type RequestCache = "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload";
type RequestCredentials = "include" | "omit" | "same-origin";
type RequestDestination = "" | "audio" | "audioworklet" | "document" | "embed" | "font" | "frame" | "iframe" | "image" | "manifest" | "object" | "paintworklet" | "report" | "script" | "sharedworker" | "style" | "track" | "video" | "worker" | "xslt";
type RequestMode = "cors" | "navigate" | "no-cors" | "same-origin";
type RequestPriority = "auto" | "high" | "low";
type RequestRedirect = "error" | "follow" | "manual";
type ResponseType = "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";
type TransferFunction = "hlg" | "pq" | "srgb";
type WriteCommandType = "seek" | "truncate" | "write";
type XMLHttpRequestBodyInit = string | Blob | BufferSource | FormData | URLSearchParams
type XMLHttpRequestResponseType = "" | "arraybuffer" | "blob" | "document" | "json" | "text";
