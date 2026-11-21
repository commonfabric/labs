/**
 * SPIKE(boardgame-trusted-components). Not for merging.
 *
 * Loads one extra script of custom element definitions into the shell page,
 * beside the `cf-*` set, when the shell was built with
 * `CF_SPIKE_TRUSTED_COMPONENTS` naming it (see `felt.config.ts`).
 *
 * The renderer creates whatever tag a pattern's JSX names, and a tag with no
 * definition is an inert element. So the one thing that admits an element
 * into a pattern's view today is that the page defined it. This module is
 * that admission, decided by whoever starts the shell.
 *
 * What a real version needs and this does not have: a record of which sets a
 * user admitted, a check of the script against a digest that record holds,
 * a namespace each set is confined to (a set here could define `cf-button`
 * first), and an entry for each element's props in the reconciler's
 * remote-load and text-integrity tables.
 */
declare global {
  var $SPIKE_TRUSTED_COMPONENTS: string | undefined;
}

const script = typeof $SPIKE_TRUSTED_COMPONENTS === "string"
  ? $SPIKE_TRUSTED_COMPONENTS
  : undefined;

if (script !== undefined) {
  // A script element rather than `import()`: this entry is one unsplit
  // bundle, and the set is a separate file on purpose.
  const element = document.createElement("script");
  element.type = "module";
  element.src = script;
  document.head.append(element);
}

export {};
