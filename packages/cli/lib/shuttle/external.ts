/**
 * The external plane: the one working position outside the fabric.
 *
 * The ambient data plane is the fabric, so a place outside it is named by an
 * explicit scheme (`docs/plans/shuttle/grammar.md`). That leaves a shell's
 * convenience — naming a nearby file without writing its whole path — needing
 * a position of its own, and this is it: `xcd` moves it and `xpwd` prints
 * it.
 *
 * The position stands on {@link FILE_SCHEME} and nowhere else, so it is
 * always a directory on this machine. A location is a {@link URL} all the
 * same: that is the form `where` prints, the form that reads back as the
 * same place, and the form the rest of the family will arrive in if a scheme
 * with a listing ever joins.
 *
 * A token is a path rather than a URL reference, and the two are not the
 * same language: a URL reads `#` as a fragment, `?` as a query and a leading
 * blank as nothing at all, where a directory may be named with any of them.
 * So a token is resolved as a path and converted at the end
 * ({@link toFileUrl}), which is the conversion's one home.
 *
 * Nothing here opens anything: where a token lands is decided before any of
 * it reaches disk, and the reading is the same whether the place is there or
 * not.
 *
 * Every plane in the family writes `/`, and so does this module: the home it
 * is handed is a path in that spelling, and the arithmetic below is posix
 * arithmetic. A platform whose own paths are written another way reaches here
 * with no home rather than with a home this cannot use, and every `~` it is
 * handed is refused with that as the reason. Making the plane read such a
 * platform's paths is a change to the shape of this module — the home stops
 * being a string and becomes a URL — rather than a fallback at the caller.
 */

import { fromFileUrl, resolve, toFileUrl } from "@std/path/posix";

import { holdsControlCharacter } from "./place.ts";
import { type RecordEntry } from "./record.ts";

/**
 * The one plane a location may stand on.
 *
 * `xcd` is a navigation verb, and a plane it can move through is one that
 * answers what stands under a path. `file:` is the only member of the family
 * that does: `https:` has no listing primitive and no traversal for `..` to
 * mean anything against, so a location set there could never be moved
 * through (`docs/plans/shuttle/README.md`, decision 30). A location is
 * therefore always a directory on this machine — which is also what gives a
 * local program somewhere to run.
 */
const FILE_SCHEME = "file";

/**
 * What moving the external location did: it landed somewhere, or it was
 * refused.
 */
export type Landing =
  /** The token names `at`, a place outside the fabric. */
  | { readonly kind: "external"; readonly at: URL }
  /** The token names no place, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The scheme a token opens with, matched at its start and nowhere else.
 *
 * It matches the scheme alone and leaves the rest to be taken by position. A
 * pattern that tried to carry the rest as a group would have to say what the
 * rest may hold, and the answer is anything at all — a group written `.*` is
 * a group that stops at a line break, which would leave a token carrying one
 * reading as though it named no scheme.
 */
const SCHEMED = /^[A-Za-z][A-Za-z0-9+.-]*:/;

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
  if (match === null) return undefined;
  return {
    scheme: match[0].slice(0, -1),
    rest: token.slice(match[0].length),
  };
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

/**
 * The refusal a scheme that is not {@link FILE_SCHEME} gets from `xcd`.
 *
 * It says what the plane cannot answer rather than that shuttle has not got
 * to it, because the two are different and only one of them will ever
 * change. A place is stood in by moving through it, and a plane with no
 * listing has nothing for a move to land on or climb out of; `https:` is a
 * read end, and a read names its place whole
 * (`docs/plans/shuttle/futures.md`).
 */
function cannotBeStoodIn(scheme: string): string {
  return `\`${scheme}:\` names no place to stand in: it answers a read ` +
    `and not what stands under a path, so there is nothing to move through. ` +
    `\`${FILE_SCHEME}:\` is the plane a location stands on.`;
}

/**
 * The refusal a `file:` token carrying a host gets.
 *
 * `file:` names a file on this machine, and `file://server/share` names one
 * on another — a place shuttle has no way to reach and, worse, one whose host
 * a conversion to a path drops in silence, leaving a location that looks like
 * the one asked for and is not.
 *
 * `file://localhost/tmp` is not one of these: the URL parser resolves that
 * host away, so what arrives here already names a local file.
 */
const NAMES_ANOTHER_MACHINE =
  "`file:` names a file on this machine, so a host after the separator " +
  "names a place shuttle does not reach. Write the path on its own.";

/**
 * The refusal a token holding a character a terminal acts on gets.
 *
 * No plane in the family names a place with one, and a parser that met one
 * would drop it rather than refuse it — leaving a location that is not the
 * one asked for and says nothing about the difference.
 */
const ACTS_ON_A_TERMINAL =
  "A place outside the fabric is not named with a character a terminal acts " +
  "on, so a token holding one names no place.";

/**
 * The refusal a path opening `~` gets where the expansion cannot be made.
 *
 * `~` is this run's own home and nothing else: no plane in the family spells
 * somebody else's, so the spelling is refused rather than guessed at. A run
 * whose environment named no home is the second way there is nothing to write
 * out, and it earns the same refusal for the same reason.
 */
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
   *
   * @throws Error if `at` is not on {@link FILE_SCHEME}, or holds an escape
   * no path can be made of. Every move below reads the location as a path,
   * so one that cannot be read that way would fail on a later line naming a
   * token the person did not type. `xcd` turns both down at the door, which
   * leaves only a caller building one directly, and that is a mistake in
   * this process rather than in a line somebody typed.
   */
  constructor(at: URL, home: string | undefined) {
    if (at.protocol !== `${FILE_SCHEME}:`) {
      throw new Error(
        `An external location stands on \`${FILE_SCHEME}:\`, and ` +
          `\`${at.protocol}\` is not one.`,
      );
    }
    // Throws where `at` holds an escape no path can be made of, which is the
    // same invariant read the same way: every move below converts the
    // location back to a path.
    fromFileUrl(at);
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
   * `token` is read on the external plane already, which is what lets a
   * plain path move the location without naming a scheme — `xcd ../foo` and
   * `xcd /tmp`. A scheme may be written, and must then name this plane and
   * an absolute path: there is nowhere else a location may stand, a place
   * being stood in by moving through it.
   *
   * A token holding a character a terminal acts on is refused first, as a
   * place refuses a part holding one (`place.ts`). It is the same rule for
   * the same reason on both planes, and it is what keeps the readings below
   * free of a class every one of them would otherwise have to allow for: a
   * line break inside a token is not a path a plane can hold, and a URL
   * parser drops one rather than refusing it.
   */
  xcd(token: string): Landing {
    if (holdsControlCharacter(token)) {
      return { kind: "refused", reason: ACTS_ON_A_TERMINAL };
    }
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
   * A scheme that is not {@link FILE_SCHEME} is refused here rather than
   * held: `xcd` moves through a plane, and the rest of the family answers no
   * question a move is made of (decision 30).
   *
   * What makes a path absolute is checked here and not by the URL parser,
   * which does not enforce it: `new URL("file:out.json")` answers with a
   * path of `/out.json`, turning a relative spelling into a place at the
   * root. A leading `/` is the whole of the test, and an authority carries
   * one after it.
   */
  #absolute(
    token: string,
    { scheme, rest }: { scheme: string; rest: string },
  ): Landing {
    // A scheme is case-insensitive, so the comparison is made on one case.
    if (scheme.toLowerCase() !== FILE_SCHEME) {
      return { kind: "refused", reason: cannotBeStoodIn(scheme) };
    }
    // An authority is a URL's own spelling, and `~` has no meaning inside
    // one, so that form is read by the parser rather than as a path.
    if (rest.startsWith("//")) {
      try {
        const at = new URL(`${scheme}:${rest}`);
        if (at.host !== "") {
          return { kind: "refused", reason: NAMES_ANOTHER_MACHINE };
        }
        // Read back as a path before it is taken. A URL may hold an escape
        // no path can be made of — `%FF` is well formed as an escape and
        // names no character — and every move from this location reads it
        // as a path, so one taken here would fail on the next line instead,
        // naming a token the person did not type.
        fromFileUrl(at);
        return { kind: "external", at };
      } catch {
        return { kind: "refused", reason: spellsNoPlace(token) };
      }
    }
    const path = expandHome(rest, this.#home);
    if (path === undefined) {
      return { kind: "refused", reason: NAMES_NO_HOME };
    }
    if (!path.startsWith("/")) {
      return { kind: "refused", reason: notAbsolute(token) };
    }
    // Total from here: the path opens with a separator by the check above,
    // and holds no character a terminal acts on, those being refused at the
    // door. A conversion that threw anyway would be reported by the prompt
    // as the line failing, which says more than a refusal this could not
    // name.
    return { kind: "external", at: toFileUrl(path) };
  }

  /**
   * Helper for {@link ExternalLocation.#landing}, which roots a path at the
   * location.
   *
   * An empty path names the location itself, which is what `xcd` with
   * nothing after it means.
   */
  #rooted(path: string): Landing {
    const expanded = expandHome(path, this.#home);
    if (expanded === undefined) {
      return { kind: "refused", reason: NAMES_NO_HOME };
    }
    // Total for the same reason, plus the one the constructor holds: the
    // location is on this plane, so reading it back as a path is a
    // conversion that has its input.
    return {
      kind: "external",
      at: toFileUrl(resolve(fromFileUrl(this.#at), expanded)),
    };
  }
}
