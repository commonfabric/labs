/**
 * The external plane: the one working position outside the fabric.
 *
 * The ambient data plane is the fabric, so a place outside it is named by an
 * explicit scheme (`docs/plans/shuttle/grammar.md`). That leaves a shell's
 * convenience — naming a nearby file without writing its whole path — needing
 * a position of its own, and this is it: `xcd` moves it and `xpwd` prints
 * it.
 *
 * A location is a {@link URL}, which is what lets one position stand for a
 * place on either plane and what gives a relative move its arithmetic on the
 * plane that has no paths of its own.
 *
 * On the `file:` plane a token is a path rather than a URL reference, and the
 * two are not the same language: a URL reads `#` as a fragment, `?` as a
 * query and a leading blank as nothing at all, where a directory may be named
 * with any of them. So a token there is resolved as a path and converted at
 * the end ({@link toFileUrl}), which is the conversion's one home. On every
 * other plane a token is a URL reference and is resolved as one, because
 * that is the language those planes are written in.
 *
 * Nothing here opens anything: where a token lands is decided before any of
 * it reaches disk, and the reading is the same whether the place is there or
 * not.
 */

import { fromFileUrl, resolve, toFileUrl } from "@std/path/posix";

import { type RecordEntry } from "./record.ts";

/**
 * The plane a `~` is written out against, which is the one that has a home.
 *
 * A location is held as a URL and so is not confined to it —
 * `xcd https://foo.com/a/b/` sets one — but `~` is a path the operating
 * system spells, and only the plane that reads a path off disk has one.
 */
const HOME_SCHEME = "file";

/**
 * What moving the external location did: it landed somewhere, or it was
 * refused.
 */
export type Landing =
  /** The token names `at`, a place outside the fabric. */
  | { readonly kind: "external"; readonly at: URL }
  /** The token names no place, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/** Where a scheme ends in a token that carries one. */
const SCHEMED = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;

/**
 * Returns the scheme `token` is written with and the rest of it, or
 * `undefined` where it carries no scheme.
 *
 * A Windows drive letter would read as a scheme here and does not reach this
 * module: a path is written the way the plane it is on writes one, and every
 * plane in the family writes `/`.
 */
function schemeOf(token: string): { scheme: string; rest: string } | undefined {
  const match = SCHEMED.exec(token);
  return match === null ? undefined : { scheme: match[1], rest: match[2] };
}

/**
 * Returns `path` with the home directory written out where it opens with
 * `~`, or `undefined` where it names a home this cannot spell — somebody
 * else's, or this run's where the environment named none.
 *
 * `file:~/…` counts as absolute, so the expansion happens here rather than at
 * the open: a location is arithmetic from the moment it is set — `xcd ../foo`
 * walks up out of it — and `..` over an unexpanded `~` would be a walk out of
 * a root nothing had placed. `~user` names somebody else's home, which no
 * plane in the family spells and which this refuses rather than guesses.
 */
function expandHome(
  path: string,
  home: string | undefined,
): string | undefined {
  if (!path.startsWith("~")) return path;
  if (home === undefined) return undefined;
  if (path === "~") return home;
  if (!path.startsWith("~/")) return undefined;
  return `${home}${path.slice(1)}`;
}

/**
 * The refusal a scheme on a path that is not absolute gets, `token` being the
 * spelling that earned it.
 *
 * It names both ways out, because a person who wrote the scheme meant one of
 * them: the whole path, or the relative one read against where this already
 * stands.
 */
function notAbsolute(token: string): string {
  return `A scheme is legal only on an absolute complete path, so ` +
    `\`${token}\` names no place. Write the path whole, or write it relative ` +
    `and let it be read against the location this already stands at.`;
}

/**
 * The refusal a path opening `~` gets where the expansion cannot be made.
 *
 * `~` is this run's own home and nothing else: no plane in the family spells
 * somebody else's, so the spelling is refused rather than guessed at. A run
 * whose environment named no home is the second way there is nothing to write
 * out, and it earns the same refusal for the same reason.
 */
/**
 * The refusal a token gets that names a scheme and an absolute path and still
 * spells no place, `token` being that spelling.
 *
 * It is separate from {@link notAbsolute} because it answers a different
 * question. `file://[bad/x` is absolute and is refused anyway — the authority
 * after the separator is not one the plane can write — and telling somebody
 * to make it absolute would send them looking at the half that is already
 * right.
 */
function spellsNoPlace(token: string): string {
  return `\`${token}\` spells no place: it names a scheme and a path, and ` +
    `what is written between them is not an address that scheme can carry.`;
}

const NAMES_NO_HOME =
  "`~` names this run's own home and nobody else's, so a path opening `~` " +
  "with a name after it names no place — and neither does one opening `~` " +
  "at all where this run was given no home.";

/**
 * Returns `path` ending in a separator, which is what makes a location read
 * as the container a relative path is resolved against rather than as a file
 * beside it.
 */
function asContainer(at: URL): URL {
  if (at.pathname.endsWith("/")) return at;
  const container = new URL(at.href);
  container.pathname = `${at.pathname}/`;
  return container;
}

/**
 * The one working position outside the fabric: what `xcd` moves and `xpwd`
 * prints.
 *
 * It stands beside the place rather than inside it because the two move
 * independently — `cd` leaves it where it was, and `xcd` leaves the place
 * where it was — and because a fabric place is a position in a space, which
 * nothing outside the fabric has.
 */
export class ExternalLocation {
  #at: URL;
  readonly #home: string | undefined;

  /**
   * Constructs an instance standing at `at`, resolving `~` against `home`.
   *
   * The home directory arrives as a value rather than being read from the
   * environment here, which is what lets a case drive the whole of this
   * module with a home of its own. A run that was given none passes
   * `undefined`, and every `~` it is handed is refused rather than expanded
   * against a guess.
   */
  constructor(at: URL, home: string | undefined) {
    this.#at = asContainer(at);
    this.#home = home;
  }

  /** What `xpwd` prints, which is the location's one spelling. */
  render(): string {
    return this.#at.href;
  }

  /** The dimension this is of the ambient record, which `where` prints. */
  entries(): readonly RecordEntry[] {
    return [{ label: "external", value: this.render() }];
  }

  /**
   * Moves as `token` says, and returns what that did. The location changes
   * only where the move lands, so a refusal leaves it where it was.
   *
   * `token` is read on the external plane already, which is what lets a plain
   * path move the location without naming a scheme — `xcd ../foo` and
   * `xcd /tmp` both land on whatever plane the location stands on. A scheme
   * moves it to another plane, and is legal only on an absolute complete
   * path.
   */
  xcd(token: string): Landing {
    const landing = this.#landing(token);
    if (landing.kind === "external") this.#at = asContainer(landing.at);
    return landing;
  }

  /**
   * Helper for {@link ExternalLocation.xcd}, which is the whole of the
   * reading and none of the adoption.
   *
   * It is separate so that a token this refuses leaves the location where it
   * stood: the move is the last thing that happens, after every way the
   * reading could have failed.
   */
  #landing(token: string): Landing {
    const schemed = schemeOf(token);
    return schemed === undefined
      ? this.#rooted(token)
      : this.#absolute(token, schemed);
  }

  /**
   * Helper for {@link ExternalLocation.#landing}, which lands a token that
   * named a scheme.
   *
   * The scheme-absolute rule is checked here and not by the URL parser, which
   * does not enforce it: `new URL("file:out.json")` answers with a path of
   * `/out.json`, turning a relative spelling into a place at the root. What
   * makes a path absolute is the separator the family writes, and an
   * authority (`file://localhost/tmp`, `https://foo.com/a`) carries one after
   * it.
   */
  #absolute(
    token: string,
    { scheme, rest }: { scheme: string; rest: string },
  ): Landing {
    // An authority is a URL's own spelling wherever it appears, so the `//`
    // form is read as one on either plane and `~` has no meaning inside it.
    const onFilePlane = scheme === HOME_SCHEME && !rest.startsWith("//");
    const path = onFilePlane ? expandHome(rest, this.#home) : rest;
    if (path === undefined) {
      return { kind: "refused", reason: NAMES_NO_HOME };
    }
    if (!path.startsWith("/")) {
      return { kind: "refused", reason: notAbsolute(token) };
    }
    try {
      return {
        kind: "external",
        at: onFilePlane ? toFileUrl(path) : new URL(`${scheme}:${path}`),
      };
    } catch {
      return { kind: "refused", reason: spellsNoPlace(token) };
    }
  }

  /**
   * Helper for {@link ExternalLocation.#landing}, which roots a path at the
   * location.
   *
   * An empty path names the location itself, which is what `xcd` with
   * nothing after it means.
   */
  #rooted(path: string): Landing {
    try {
      if (this.#at.protocol !== `${HOME_SCHEME}:`) {
        return { kind: "external", at: new URL(path, this.#at) };
      }
      const expanded = expandHome(path, this.#home);
      if (expanded === undefined) {
        return { kind: "refused", reason: NAMES_NO_HOME };
      }
      return {
        kind: "external",
        at: toFileUrl(resolve(fromFileUrl(this.#at), expanded)),
      };
    } catch {
      return {
        kind: "refused",
        reason: `\`${path}\` names no place under \`${this.render()}\`.`,
      };
    }
  }
}
