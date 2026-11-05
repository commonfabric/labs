/**
 * The outer frame's document: the Content Security Policy the guest
 * inherits, and the script that loads each guest into an inner frame of its
 * own and talks to the host. The script is a file of its own, imported as
 * text and inlined here.
 */

import { CSP, HOST_ORIGIN } from "./csp.ts";
import script from "./outer-frame-script.js" with { type: "text" };

/**
 * Returns the outer frame's document with `script` inlined as its script. The
 * script's text lands inside a `<script>` element, whose content ends at the
 * first `</script>` however it got there, so a `script` carrying one is
 * refused rather than trusted. The script reads the host's origin off its own
 * element's `data-host-origin` attribute; an origin is scheme, host and port,
 * none of which needs escaping in an attribute.
 */
export function outerFrameDocument(script: string): string {
  if (/<\/script/i.test(script)) {
    throw new Error("The outer frame's script must not contain `</script`.");
  }

  return `
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<style>
html, body {
  padding: 0;
  margin: 0;
  height: 100vh;
  overflow: hidden;
  background-color: #ddd;
}

* {
  box-sizing: border-box;
}

iframe {
  padding: 0;
  margin: 0;
  height: 100vh;
  width: 100vw;
  border: none;
}
</style>
</head>
<body>
<script data-host-origin="${HOST_ORIGIN}">
${script}
</script>
</body>
</html>
`;
}

/** The outer frame's document, with `outer-frame-script.js` as its script. */
export default outerFrameDocument(script);
