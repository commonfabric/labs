const SCRIPT_CDNS = [
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://esm.sh",
];

const STYLE_CDNS = [
  "https://fonts.googleapis.com",
];

const FONT_CDNS = [
  "https://fonts.gstatic.com",
];

// In Chromium browsers, "'self'" selects the top frame origin from
// null origins. In Firefox this does not apply. Instead, use
// the top frame origin explicitly.
export const HOST_ORIGIN =
  new URL(globalThis?.location?.href || "http://localhost").origin;

// This CSP directive uses 'unsafe-inline' to allow
// origin-less styles and scripts to be used, defeating
// many traditional uses of CSP.
export const CSP = `` +
  // Disable all fetch directives. Re-enable
  // each specific fetch directive as needed.
  `default-src 'none';` +
  // Scripts: Allow 1P, inline, and CDNs.
  `script-src ${HOST_ORIGIN} 'unsafe-inline' ${SCRIPT_CDNS.join(" ")};` +
  // Styles: Allow 1P, inline, Google Fonts.
  `style-src ${HOST_ORIGIN} 'unsafe-inline' ${STYLE_CDNS.join(" ")};` +
  // Fonts: Allow 1P, inline.
  `font-src ${HOST_ORIGIN} 'unsafe-inline' ${FONT_CDNS.join(" ")};` +
  // Images: Allow 1P, data URIs.
  `img-src ${HOST_ORIGIN} data:;` +
  // Disabling until we have a concrete case.
  `form-action 'none';` +
  // Disable <base> element
  `base-uri 'none';` +
  // Iframes/Workers: Use default (disabled)
  `child-src 'none';` +
  // Ping/XHR/Fetch/Sockets: Allow 1P only
  `connect-src 'self';` +
  // This is a deprecated/Chrome-only CSP directive.
  // This blocks `<link rel=`prefetch`>` and
  // the Chrome-only `<link rel=`prerender`>`.
  // `default-src` is used correctly as a fallback for
  // prefetch
  //`prefetch-src 'none';` +
  // Fonts: Use default (disabled)
  //`font-src 'none';` +
  // Media: Use default (disabled)
  //`media-src 'none';` +
  // Manifest: Use default (disabled)
  //`manifest-src 'none';` +
  // Object/Embeds: Use default (disabled)
  //`object-src 'none';` +
  ``;
