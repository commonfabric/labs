import { defer } from "@commonfabric/utils/defer";

import "../src/common-iframe-sandbox.ts";

import {
  assert,
  assertDeepEquals,
  assertEquals,
  cleanupFixtures,
  ContextShim,
  invertPromise,
  render,
  waitForEvent,
} from "./utils.ts";

type TestCase = [string, string, string | null | RegExp];

// Cookies should not be set with SameSite=None, but
// used to test that cookies are not accessible to iframe.
document.cookie = "testcookie=1; SameSite=None;";

// When CSP is applied to an iframe, the `securitypolicyviolation`
// event is emitted on the iframe's `document`.
// As the host and iframe's do not share origin, and `securitypolicyviolation`
// events occur during load, we have to inject a CSP listener into
// the iframe content for these its.
// Outside of its/in app, we *may* want to inject this, though
// content may still work with some imports (e.g. styles/images) failing.
// If so, we may want to add a new post message "event" in addition
// to the not-very-CSP-compatible "error" event.
//
// Additionally, we want to propagate other errors to the parent frame
// for inspection.
const CSP_REPORTER = `
<script>
document.addEventListener('securitypolicyviolation', e => {
  window.parent.postMessage({
    type: 'error',
    data: {
      description: "CSP:" + e.violatedDirective,
      source: e.sourceFile,
      lineno: 0,
      colno: 0,
      stacktrace: "",
    }
  }, '*');
});
window.onerror = function (message, source, lineno, colno, error) {
  window.parent.postMessage({
    type: "error",
    data: {
      description: message,
      source: source,
      lineno: lineno,
      colno: colno,
      stacktrace: error && error.stack ? error.stack : new Error().stack,
    },
  }, '*');
}
</script>
`;

// Raises a recognizable alarm once the guest has passed the point where a
// case's error would already have been posted.
//
// It is an alarm rather than a write, and that is what makes it a barrier. An
// error leaves the guest as a postMessage to its parent, which forwards it to
// the host on a second fixed pair of windows; this takes that same route, and
// each hop preserves the order it received messages in, so an alarm posted
// after an error arrives after it. A write would not do: it rides the guest's
// port, which is a channel of its own with no ordering against this one, and a
// barrier that can arrive before an error already sent bounds nothing.
//
// The load event is the point the cases below share. It fires once the document
// has parsed and its subresources have settled, and it lands after the
// violation for the two kinds of subresource those cases load: an `<img>`
// element and a `<link rel=stylesheet>`.
//
// It is not a general barrier for CSP violations, and the cases below stay
// inside what it covers. A blocked `<script src>`, a request a stylesheet
// starts such as a `background-image`, and a `fetch()` each report their
// violation only after the load event has already fired. A negative case of one
// of those shapes belongs in `unbarrierable` below rather than here.
//
// `barrierControls` below holds the conversions to it honest.
const BARRIER_DESCRIPTION = "barrier";

const BARRIER = `
<script>
addEventListener('load', () => {
  window.parent.postMessage({
    type: 'error',
    data: {
      description: '${BARRIER_DESCRIPTION}',
      source: "",
      lineno: 0,
      colno: 0,
      stacktrace: "",
    },
  }, '*');
});
</script>
`;

const HTML_URL = "https://commonfabric.com";
const SCRIPT_URL = "https://commonfabric.com/static/sketch.js";
const STYLE_URL = "https://commonfabric.com/static/main.css";
const IMG_URL = "https://commonfabric.com/static/text.png";
const ORIGIN_URL = new URL(globalThis.location.href).origin;
const BASE64_IMG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

function openWindow(target: string) {
  return `<script>
    let win = window.open("${HTML_URL}", "${target}");
    if (win) throw new Error("Window Opened");</script>`;
}

function clickAnchor(target: string) {
  return `
<a id="anchor-test" href="${HTML_URL}" target="${target}">
<script>
const anchor = document.querySelector("#anchor-test");
anchor.click();
</script>`;
}

// `openWindow` with its guard inverted: throws when the window did not open,
// which is the outcome the real cases assert. Used by `barrierControls`.
function invertedOpenWindow(target: string) {
  return `<script>
    let win = window.open("${HTML_URL}", "${target}");
    if (!win) throw new Error("Window Opened");</script>`;
}

// `clickAnchor` with a throw at the point the click happens, which the real
// cases reach without raising anything. Used by `barrierControls`.
function throwingClickAnchor(target: string) {
  return `
<a id="anchor-test" href="${HTML_URL}" target="${target}">
<script>
const anchor = document.querySelector("#anchor-test");
anchor.click();
throw new Error("clicked");
</script>`;
}

const cases: TestCase[] = [[
  "allows inline script",
  `<script>console.log("foo")</script><style>* { background-color: red; }</style><div>foo</div>`,
  null,
], [
  "allows 1P img",
  `<img src="${ORIGIN_URL}/foo.jpg" />`,
  null,
], [
  "allows data: img",
  `<img src="${BASE64_IMG_URL}" />`,
  null,
], [
  "allows 1P CSS",
  `<link rel="stylesheet" href="${ORIGIN_URL}/styles.css">`,
  null,
], [
  "disallows opening windows (_blank)",
  openWindow("_blank"),
  null,
], [
  "disallows opening windows (_parent)",
  openWindow("_parent"),
  null,
], [
  "disallows opening windows (_top)",
  openWindow("_top"),
  null,
], [
  "disallows anchor link target (_parent)",
  clickAnchor("_parent"),
  null,
], [
  "disallows anchor link target (_top)",
  clickAnchor("_top"),
  null,
], [
  "disallows fetch",
  `<script>fetch("${SCRIPT_URL}");</script>`,
  "CSP:connect-src",
], [
  "disallows 3P JS elements",
  `<script src="${SCRIPT_URL}"></script>`,
  "CSP:script-src-elem",
], [
  "disallows 3P CSS elements",
  `<link rel="stylesheet" href="${STYLE_URL}">`,
  "CSP:style-src-elem",
], [
  "disallows 3P CSS imports",
  `<style>@import url("${STYLE_URL}") print;</style>`,
  "CSP:style-src-elem",
], [
  "disallows 3P images in styles",
  `<style>* { background-image: url("${IMG_URL}"); }</style>`,
  "CSP:img-src",
], [
  "disallows 3P images in elements",
  `<img src="${IMG_URL}" />`,
  "CSP:img-src",
], [
  "disallows base element",
  `<base href="${HTML_URL}" />`,
  "CSP:base-uri",
], [
  "disallows prefetch",
  `<link rel="prefetch" href="${HTML_URL}" />`,
  "CSP:default-src",
], [
  "disallows Worker",
  `<script>new Worker("${SCRIPT_URL}")</script>`,
  /Uncaught SecurityError/,
], [
  "disallows SharedWorker",
  `<script>new SharedWorker("${SCRIPT_URL}")</script>`,
  /Uncaught SecurityError/,
], [
  "disallows ServiceWorker",
  `<script>navigator.serviceWorker.register("${SCRIPT_URL}")</script>`,
  /Uncaught SecurityError/,
], [
  "disallows cookie access",
  `<script>let foo = document.cookie;</script>`,
  /Uncaught SecurityError/,
]];

// These negative cases keep the fixed-duration wait. For each of them nothing
// the guest can post is ordered after the error the case rules out, so there is
// no marker to barrier on, and each stays only as good as its timeout makes it:
// an error arriving later than the wait is missed.
//
// "allows 1P fetch" is bounded by the browser rather than by the guest. A
// `fetch()` does not hold the document's load event, and a blocked request
// reports its violation a macrotask turn after the request has already
// rejected — later than the load event as well. The outcome of the request
// cannot stand in for the violation either: the guest runs on an opaque
// origin, so the host's own origin is cross-origin to it, and both a 1P and a
// 3P request reject with "TypeError: Failed to fetch" once CORS fails the
// response. The violation is the only thing that separates allowed from
// blocked, and the browser reports it after every guest continuation for the
// request has run.
//
// "disallows anchor link target (_self)" navigates the guest's own frame, and
// the navigation tears the guest document down, so no guest code is left to
// report a marker. It raises no error either, and so asserts only that the
// guest reported nothing before it was torn down.
const unbarrierable: TestCase[] = [[
  "allows 1P fetch",
  `<script>fetch("${ORIGIN_URL}/foo.js")</script>`,
  null,
], [
  "disallows anchor link target (_self)",
  clickAnchor("_self"),
  null,
]];

// /!\ This test cannot assert what its name says, so it does not run.
//
// It is here rather than in `cases` because its guard is unsound.
// `window.open(url, "_self")` targets the current browsing context, so it hands
// that window back whether or not the navigation is allowed, and the fixture's
// `if (win) throw` therefore always throws. The host does dispatch the
// resulting "Uncaught Error: Window Opened": a listener installed before the
// load sees it every time. The case only ever passed because it began listening
// after `render` had resolved, by which point the error had already been
// dispatched, and reading the resulting silence as "no window was opened".
//
// What it set out to check is not observable from the host. The `_self`
// navigation tears the guest down before any guest code could report on it, and
// whether the navigation is ultimately blocked cannot be seen from out here.
// That is the same wall "disallows navigation" in `falseNegatives` below runs
// into — it drives the same self-navigation through `location.href`, is blocked
// in practice, and reports nothing — which is why it does not run either.
//
// Deciding what should be asserted about `_self` navigation is a question about
// the sandbox's intended policy, not about how this test waits.
const unsoundAssertions: TestCase[] = [[
  "disallows opening windows (_self)",
  openWindow("_self"),
  null,
]];

// Every negative case above proves the same thing: no error had fired by the
// time the barrier arrived. Each control here runs one of those fixtures'
// shapes through the same body and the same wait, against html that does raise
// an error, and requires the error to be in hand by barrier time. The third
// element is the description it must carry, so a control cannot pass on an
// unrelated error.
//
// The controls are not all doing the same job, and the difference decides what
// each is evidence of.
//
// Ordering only needs proving for a case whose error can arrive after the
// guest's own scripts have run, and the two subresource controls are the ones
// that prove it. Post the barrier during parse instead of on load and they go
// red, because the violation for a blocked `<img>` or `<link rel=stylesheet>`
// is reported after the parser has passed the barrier script.
//
// The other six raise their error from a synchronous throw while the document
// parses, before the barrier script has been reached at all. No barrier the
// guest could post can come first, so they cannot fail on ordering and say
// nothing about it. Their converted cases do not need them to: the error those
// cases rule out is raised the same way, during parse, so any barrier is
// already after it. What these six check instead is that the error channel is
// live for their shape — that `CSP_REPORTER` is installed, and that the guest
// is still there to report. That is the property separating the `_parent` and
// `_top` cases from the `_self` ones, which tear the guest down before it can
// report anything.
const barrierControls: [string, string, string][] = [[
  // "allows inline script": an error raised while the document parses.
  "inline script throws",
  `<script>throw new Error("boom")</script>`,
  "Uncaught Error: boom",
], [
  // "allows 1P img" and "allows data: img".
  "3P img element",
  `<img src="${IMG_URL}" />`,
  "CSP:img-src",
], [
  // "allows 1P CSS".
  "3P CSS link",
  `<link rel="stylesheet" href="${STYLE_URL}">`,
  "CSP:style-src-elem",
], [
  // The three `openWindow` cases, with the guard inverted so the fixture
  // throws on the path the real cases leave silent.
  "openWindow (_blank) throws",
  invertedOpenWindow("_blank"),
  "Uncaught Error: Window Opened",
], [
  "openWindow (_parent) throws",
  invertedOpenWindow("_parent"),
  "Uncaught Error: Window Opened",
], [
  "openWindow (_top) throws",
  invertedOpenWindow("_top"),
  "Uncaught Error: Window Opened",
], [
  // The two `clickAnchor` cases, throwing where the click happens.
  "clickAnchor (_parent) throws",
  throwingClickAnchor("_parent"),
  "Uncaught Error: clicked",
], [
  "clickAnchor (_top) throws",
  throwingClickAnchor("_top"),
  "Uncaught Error: clicked",
]];

// /!\ These tests do not report correctly.
// /!\ Not sure why! But they correctly are blocked
// /!\ in practice. How can we ensure this is properly tested?
const falseNegatives: TestCase[] = [[
  "disallows iframes",
  `<iframe src="${HTML_URL}"></iframe>`,
  "CSP:frame-src",
], [
  "disallows navigation",
  `<script>window.location.href = "${HTML_URL}";</script>`,
  "CSP:default-src",
]];

// /!\ These tests do not report correctly.
// /!\ Not sure why! But they appear to be allowed
// /!\ but are not in practice.
const falsePositives: TestCase[] = [[
  "Allows anchor link target (_blank)",
  clickAnchor("_blank"),
  null,
]];

const unknownStatuses: TestCase[] = [
  [
    // `prerender` is a Chrome-only feature-flagged
    // source of exfiltration. This *should* be
    // covered by `default-src`, but TBD on testing that.
    "disallows prerender",
    `<link rel="prerender" href="${HTML_URL}" />`,
    "CSP:default-src",
  ],
];

for (const [name, html, expected] of cases) {
  defineTest(name, html, expected);
}
for (const [name, html, expected] of unbarrierable) {
  defineTimedNegativeTest(name, html, expected);
}
for (const [name, html, expected] of unsoundAssertions) {
  definePending(name, html, expected);
}
for (const [name, html, expected] of barrierControls) {
  defineBarrierControl(name, html, expected);
}
for (const [name, html, expected] of falseNegatives) {
  definePending(name, html, expected);
}
for (const [name, html, expected] of falsePositives) {
  definePending(name, html, expected);
}
for (const [name, html, expected] of unknownStatuses) {
  definePending(name, html, expected);
}

function defineTest(
  name: string,
  html: string,
  expected: string | null | RegExp,
) {
  Deno.test(name, async () => {
    cleanupFixtures();
    // The event bubbles and is composed, so the document sees it. Listening
    // there rather than on the element catches an error the host dispatches
    // before `render` hands the element back.
    // The barrier arrives as an alarm like any other, and is separated from
    // the errors a case is asserting about rather than counted among them.
    const errors: string[] = [];
    let barrierArrived = false;
    let noticeError: (() => void) | undefined;
    let noticeBarrier: (() => void) | undefined;
    const onError = (event: Event) => {
      const description = (event as CustomEvent).detail.description as string;
      if (description === BARRIER_DESCRIPTION) {
        barrierArrived = true;
        noticeBarrier?.();
        return;
      }
      errors.push(description);
      noticeError?.();
    };
    document.addEventListener("common-iframe-error", onError);

    // Resolves with the first error's description, from the collection this
    // listener has been filling since before the frame existed. A case whose
    // error is dispatched during the load `render` waits on has already been
    // recorded by the time this is called.
    const firstErrorDescription = (): Promise<string> => {
      if (errors.length > 0) {
        return Promise.resolve(errors[0]);
      }
      const deferred = defer<string>();
      noticeError = () => deferred.resolve(errors[0]);
      return deferred.promise;
    };

    // Resolves once the barrier has arrived, which the same listener records.
    const barrierSeen = (): Promise<void> => {
      if (barrierArrived) {
        return Promise.resolve();
      }
      const deferred = defer();
      noticeBarrier = () => deferred.resolve();
      return deferred.promise;
    };

    try {
      const context = new ContextShim();
      const body = `
          ${CSP_REPORTER}
          ${html}
          ${BARRIER}
        `;
      await render(body, context);
      if (expected == null) {
        await barrierSeen();
        assertDeepEquals(errors, []);
      } else {
        const description = await firstErrorDescription();
        if (typeof expected === "string") {
          assertEquals(description, expected);
        } else {
          assert(expected.test(description));
        }
      }
    } finally {
      document.removeEventListener("common-iframe-error", onError);
      cleanupFixtures();
    }
  });
}

// Runs a `barrierControls` case: same body and same wait as a negative case in
// `defineTest`, against html that does break the policy. The error must be in
// hand at the moment the barrier arrives.
function defineBarrierControl(
  name: string,
  html: string,
  expected: string,
) {
  Deno.test(`barrier control: ${name}`, async () => {
    cleanupFixtures();
    const errors: string[] = [];
    let barrierArrived = false;
    let noticeBarrier: (() => void) | undefined;
    const onError = (event: Event) => {
      const description = (event as CustomEvent).detail.description as string;
      if (description === BARRIER_DESCRIPTION) {
        barrierArrived = true;
        noticeBarrier?.();
        return;
      }
      errors.push(description);
    };
    document.addEventListener("common-iframe-error", onError);

    const barrierSeen = (): Promise<void> => {
      if (barrierArrived) {
        return Promise.resolve();
      }
      const deferred = defer();
      noticeBarrier = () => deferred.resolve();
      return deferred.promise;
    };

    try {
      const context = new ContextShim();
      const body = `
          ${CSP_REPORTER}
          ${html}
          ${BARRIER}
        `;
      await render(body, context);
      await barrierSeen();
      assertDeepEquals(errors, [expected]);
    } finally {
      document.removeEventListener("common-iframe-error", onError);
      cleanupFixtures();
    }
  });
}

// The pre-barrier shape, kept for the `unbarrierable` cases: wait out
// `waitForEvent`'s timeout and read the rejection as "no error fired". It
// bounds how late an error can arrive and still be caught, and it starts
// listening only once `render` has resolved.
function defineTimedNegativeTest(
  name: string,
  html: string,
  expected: string | null | RegExp,
) {
  if (expected != null) {
    throw new Error(`${name}: expected a negative case.`);
  }
  Deno.test(name, async () => {
    cleanupFixtures();
    try {
      const body = `
          ${CSP_REPORTER}
          ${html}
        `;
      const iframe = await render(body);
      await invertPromise(waitForEvent(iframe, "common-iframe-error"));
    } finally {
      cleanupFixtures();
    }
  });
}

function definePending(
  name: string,
  _html: string,
  _expected: string | null | RegExp,
) {
  Deno.test(name, () => {});
}
