/**
 * `cf profile`: create, list, rename, picture, attest, retire, restore,
 * locate, or inspect and repair a person's profiles. The create path is the CLI
 * equivalent of the shell's create form; `lib/profile.ts` says how it stands
 * in for that form's gesture.
 */

import { Command, ValidationError } from "@cliffy/command";

import { normalizeApiUrl } from "../lib/api-url.ts";
import { parseCellSelectionOptions } from "../lib/cell-selection.ts";
import { cliText } from "../lib/cli-name.ts";
import { getDidFromFile } from "../lib/identity.ts";
import {
  attestProfileName,
  createProfile,
  type ListedProfile,
  listProfiles,
  profileNameProblem,
  renameProfile,
  restoreProfile,
  retireProfile,
  setProfilePicture,
} from "../lib/profile.ts";
import { profileNameProtection } from "../lib/profile-name-protection.ts";
import {
  PROFILE_ROOT_REPAIR_REFUSAL_EXIT_CODES,
  PROFILE_ROOT_REPAIR_VERSION,
  profileSpaceRoot,
  ProfileSpaceRootRefusal,
} from "../lib/profile-space-root.ts";
import { render } from "../lib/render.ts";
import { absPath } from "../lib/utils.ts";
import { projectWishValue, readWish } from "../lib/wish.ts";
import { setQuietMode } from "./piece.ts";

/** Options every `cf profile` subcommand receives (cliffy flags plus env). */
export interface ProfileCommandOptions {
  apiUrl?: string;
  identity?: string;
  quiet?: boolean;
  json?: boolean;
}

/** Injectable effects so the action bodies are unit-testable in-process. */
export interface ProfileCommandDeps {
  attestProfileName: typeof attestProfileName;
  createProfile: typeof createProfile;
  listProfiles: typeof listProfiles;
  renameProfile: typeof renameProfile;
  restoreProfile: typeof restoreProfile;
  retireProfile: typeof retireProfile;
  setProfilePicture: typeof setProfilePicture;
  readWish: typeof readWish;
}

const defaultDeps: ProfileCommandDeps = {
  attestProfileName,
  createProfile,
  listProfiles,
  renameProfile,
  restoreProfile,
  retireProfile,
  setProfilePicture,
  readWish,
};

/**
 * The connection `options` describe, with the identity's home space as the
 * target: a profile belongs to the home root, so no `--space` is offered.
 *
 * @throws ValidationError when the identity or the API URL is missing.
 */
async function connection(options: ProfileCommandOptions): Promise<{
  apiUrl: string;
  identity: string;
  space: string;
}> {
  if (!options.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  if (!options.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }
  const identity = absPath(options.identity);
  return {
    apiUrl: normalizeApiUrl(options.apiUrl),
    identity,
    space: await getDidFromFile(identity),
  };
}

/**
 * `name` trimmed, as a profile's display name, checked before anything
 * connects.
 *
 * @throws ValidationError when it cannot be one (`profileNameProblem()`).
 */
function validProfileName(name: string): string {
  const problem = profileNameProblem(name);
  if (problem !== undefined) {
    throw new ValidationError(problem, { exitCode: 1 });
  }
  return name.trim();
}

/** The `cf profile create <name>` action body. */
export async function profileCreateAction(
  options: ProfileCommandOptions,
  name: string,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const trimmed = validProfileName(name);
  const created = await deps.createProfile({
    ...(await connection(options)),
    name: trimmed,
    jsonOutput: !!options.json,
  });
  if (options.json) {
    render(created, { json: true });
  } else {
    render(`Created profile "${created.name}" at ${created.address}`);
  }
}

/**
 * The number of bytes the `data:` URL `url` holds, counted without decoding
 * them: from the length of a base64 payload, or by counting each percent
 * escape of any other payload as one byte and each other character as its
 * UTF-8 length.
 */
export function dataUrlByteLength(url: string): number {
  const comma = url.indexOf(",");
  const payload = url.slice(comma + 1);
  if (/;base64$/i.test(url.slice(0, comma))) {
    const digits = payload.replace(/[\s=]/g, "").length;
    return Math.floor(digits * 3 / 4);
  }
  const escapes = payload.match(/%[0-9a-f]{2}/gi) ?? [];
  return escapes.length +
    new TextEncoder().encode(payload.replace(/%[0-9a-f]{2}/gi, "")).length;
}

/**
 * A listed profile as `cf profile list --json` prints it, which carries no
 * bytes: its picture as `{ size, byOwner }`, and its legacy avatar as
 * `{ text, byOwner }`, or, for a `data:` URL, as `{ size, byOwner }`, the
 * size being the bytes the URL holds.
 */
function profileJson(each: ListedProfile) {
  return {
    name: each.name,
    picture: each.picture === undefined
      ? null
      : { size: each.picture.length, byOwner: each.pictureByOwner },
    avatar: each.avatar === ""
      ? null
      : /^data:/i.test(each.avatar)
      ? { size: dataUrlByteLength(each.avatar), byOwner: each.avatarByOwner }
      : { text: each.avatar, byOwner: each.avatarByOwner },
    space: each.space,
    id: each.id,
    address: each.address,
    current: each.current,
  };
}

/**
 * The `cf profile list` action body: the identity's profiles, in the order
 * `#profile` answers in, one line each, or as JSON with `--json`
 * (`profileJson()`): the picture's bytes themselves are what
 * `cf profile get-picture` writes.
 */
export async function profileListAction(
  options: ProfileCommandOptions,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const listed = await deps.listProfiles(await connection(options));
  if (options.json) {
    render(listed.map(profileJson), { json: true });
  } else if (listed.length === 0) {
    render("No profiles.");
  } else {
    render(
      listed.map((each) =>
        `${each.current ? "*" : " "} ${each.space} ${
          each.name === "" ? "(no name)" : JSON.stringify(each.name)
        }${
          each.picture === undefined
            ? ""
            : each.pictureByOwner
            ? " (picture)"
            : " (picture not attested to its owner)"
        }`
      ).join("\n"),
    );
  }
}

/**
 * The `cf profile get-picture <space> <file>` action body: writes the bytes
 * of the picture of the listed profile in `<space>` to `<file>`, or to
 * standard output for `-`.
 *
 * @throws ValidationError when no listed profile lives in `<space>`, when it
 * has no picture, or when its picture is not attested to its owner
 * (`ListedProfile.pictureByOwner`).
 */
export async function profileGetPictureAction(
  options: ProfileCommandOptions,
  profileSpace: string,
  file: string,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const listed = (await deps.listProfiles(await connection(options))).find((
    each,
  ) => each.space === profileSpace);
  if (listed === undefined) {
    throw new ValidationError(
      `No listed profile lives in ${profileSpace}.`,
      { exitCode: 1 },
    );
  }
  if (listed.picture === undefined) {
    throw new ValidationError(
      `The profile in ${profileSpace} has no picture.`,
      { exitCode: 1 },
    );
  }
  if (!listed.pictureByOwner) {
    throw new ValidationError(
      `The picture of the profile in ${profileSpace} is not attested to ` +
        "its owner, so it is not written.",
      { exitCode: 1 },
    );
  }
  if (file === "-") {
    // The stream's writer writes the whole buffer, where a single `write()`
    // may write part of it.
    const writer = Deno.stdout.writable.getWriter();
    try {
      await writer.write(listed.picture);
    } finally {
      writer.releaseLock();
    }
  } else {
    await Deno.writeFile(absPath(file), listed.picture);
  }
}

/** The `cf profile retire <space>` action body. */
export async function profileRetireAction(
  options: ProfileCommandOptions,
  profileSpace: string,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  await deps.retireProfile({ ...(await connection(options)), profileSpace });
  render(
    options.json
      ? { retired: profileSpace }
      : `Retired profile ${profileSpace}`,
    { json: !!options.json },
  );
}

/** The `cf profile restore <space>` action body. */
export async function profileRestoreAction(
  options: ProfileCommandOptions,
  profileSpace: string,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  await deps.restoreProfile({ ...(await connection(options)), profileSpace });
  render(
    options.json
      ? { restored: profileSpace }
      : `Restored profile ${profileSpace}`,
    { json: !!options.json },
  );
}

/** The `cf profile rename <space> <name>` action body. */
export async function profileRenameAction(
  options: ProfileCommandOptions,
  profileSpace: string,
  name: string,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const trimmed = validProfileName(name);
  await deps.renameProfile({
    ...(await connection(options)),
    profileSpace,
    name: trimmed,
  });
  render(
    options.json
      ? { renamed: profileSpace, name: trimmed }
      : `Renamed profile ${profileSpace} to "${trimmed}"`,
    { json: !!options.json },
  );
}

/** The `cf profile attest-name <space>` action body. */
export async function profileAttestNameAction(
  options: ProfileCommandOptions & { apply?: boolean; expect?: string },
  profileSpace: string,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  if (!!options.apply !== (options.expect !== undefined)) {
    throw new ValidationError(
      "Use --apply and --expect <inspection> together.",
      { exitCode: 1 },
    );
  }
  setQuietMode(!!options.quiet);
  const outcome = await deps.attestProfileName({
    ...(await connection(options)),
    profileSpace,
    ...(options.expect === undefined
      ? {}
      : { expectedInspection: options.expect }),
  });
  const name = JSON.stringify(outcome.name);
  render(
    options.json
      ? { space: profileSpace, ...outcome }
      : outcome.status === "inspected"
      ? `The name of profile ${profileSpace} is ${name}. To attest it as ` +
        `yours, repeat with --apply --expect ${outcome.inspection}`
      : outcome.status === "already"
      ? `The name ${name} of profile ${profileSpace} is already attested to you`
      : `Attested the name ${name} of profile ${profileSpace}`,
    { json: !!options.json },
  );
}

/** The options `cf profile set-picture` takes. */
export type ProfilePictureOptions = ProfileCommandOptions & {
  /** Removes the picture instead of setting one. */
  clear?: boolean;

  /** Sets the picture already stored again, as the identity. */
  keepCurrent?: boolean;
};

/**
 * The `cf profile set-picture <space> [image-file]` action body: the
 * picture is the file's bytes, or, with `--keep-current` and no file, the
 * picture already stored, set again; or, with `--clear` and no file, it is
 * removed.
 *
 * @throws ValidationError unless given exactly one of a file, `--clear` and
 * `--keep-current`.
 */
export async function profileSetPictureAction(
  options: ProfilePictureOptions,
  profileSpace: string,
  file: string | undefined,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const given = [file !== undefined, !!options.clear, !!options.keepCurrent];
  if (given.filter((each) => each).length !== 1) {
    throw new ValidationError(
      "Give one of an image file, --clear to remove the picture, or " +
        "--keep-current to set the stored picture again.",
      { exitCode: 1 },
    );
  }
  const target = { ...(await connection(options)), profileSpace };
  await deps.setProfilePicture(
    file !== undefined
      ? { ...target, bytes: await Deno.readFile(absPath(file)) }
      : options.clear
      ? { ...target, clear: true }
      : { ...target, keepCurrent: true },
  );
  const cleared = !!options.clear;
  render(
    options.json
      ? { pictureSet: profileSpace, cleared }
      : cleared
      ? `Removed the picture of profile ${profileSpace}`
      : options.keepCurrent
      ? `Set the stored picture of profile ${profileSpace} again`
      : `Set the picture of profile ${profileSpace}`,
    { json: !!options.json },
  );
}

/**
 * The `cf profile show` action body: the profile `#profile` resolves to,
 * as its address and display name, through the same headless read `cf wish`
 * performs.
 */
export async function profileShowAction(
  options: ProfileCommandOptions,
  deps: ProfileCommandDeps = defaultDeps,
): Promise<void> {
  setQuietMode(!!options.quiet);
  const selection = await parseCellSelectionOptions({ select: "@,name" });
  const { result, error } = await deps.readWish({
    ...(await connection(options)),
    query: "#profile",
    jsonOutput: true,
    ...(selection === undefined ? {} : { selection }),
  });
  if (error && result === null) {
    throw new ValidationError(`wish "#profile": ${error}`, { exitCode: 1 });
  }
  render(projectWishValue(result), { json: true });
}

/** Inspects a named profile, or applies the exact receipt the owner reviewed. */
export async function profileRepairNameProtectionAction(
  options: ProfileCommandOptions & {
    cell: string;
    apply?: boolean;
    expect?: string;
  },
  run: typeof profileNameProtection = profileNameProtection,
): Promise<void> {
  if (!!options.apply !== (options.expect !== undefined)) {
    throw new ValidationError(
      "Use --apply and --expect <inspection> together.",
      { exitCode: 1 },
    );
  }
  setQuietMode(!!options.quiet);
  const connectionConfig = await connection(options);
  render(
    await run({
      ...connectionConfig,
      cell: options.cell,
      expectedInspection: options.expect,
      jsonOutput: true,
    }),
    { json: true },
  );
}

/**
 * Inspects every profile a store snapshot or the identity's own Home names,
 * or applies the plan whose receipt was reviewed. A run that refuses prints
 * its refusal as JSON and ends with that refusal's exit status.
 */
export async function profileRepairRootAction(
  options: ProfileCommandOptions & {
    fromSnapshot?: string;
    cell?: string[];
    apply?: boolean;
    expect?: string;
  },
  run: typeof profileSpaceRoot = profileSpaceRoot,
  setExitCode: (code: number) => void = (code) => {
    Deno.exitCode = code;
  },
): Promise<void> {
  if (!!options.apply !== (options.expect !== undefined)) {
    throw new ValidationError(
      "Use --apply and --expect <inspection> together.",
      { exitCode: 1 },
    );
  }
  if (options.fromSnapshot === undefined && options.cell !== undefined) {
    throw new ValidationError(
      "Use --cell only with --from-snapshot.",
      { exitCode: 1 },
    );
  }
  setQuietMode(!!options.quiet);
  const { space: home, ...connectionConfig } = await connection(options);
  let report;
  try {
    report = await run({
      ...connectionConfig,
      ...(options.fromSnapshot === undefined
        ? { home }
        : { snapshot: absPath(options.fromSnapshot) }),
      ...(options.cell === undefined ? {} : { cells: options.cell }),
      expectedInspection: options.expect,
      jsonOutput: true,
    });
  } catch (error) {
    if (!(error instanceof ProfileSpaceRootRefusal)) throw error;
    render({
      repairVersion: PROFILE_ROOT_REPAIR_VERSION,
      refused: {
        reason: error.reason,
        message: error.message,
        ...(error.space === undefined ? {} : { space: error.space }),
      },
    }, { json: true });
    setExitCode(PROFILE_ROOT_REPAIR_REFUSAL_EXIT_CODES[error.reason]);
    return;
  }
  render(report, { json: true });
}

/**
 * Connection flags shared by `cf profile` verbs. Create and show use the
 * identity's home space. `repair-name-protection` takes one profile's explicit
 * full address; `repair-root` takes its profiles from the identity's home
 * space, or from a store snapshot, or only the full addresses repeated
 * `--cell` flags name.
 */
// Typed as the other subcommand builders are: cliffy's `.command()` overloads
// take a `Command<any>`, and a builder returning the narrowed option type is
// refused by every one of them.
// deno-lint-ignore no-explicit-any
function connected(description: string): Command<any> {
  return new Command()
    .description(description)
    .env("CF_API_URL=<url:string>", "URL of the fabric server instance.", {
      prefix: "CF_",
    })
    .option("-a,--api-url <url:string>", "URL of the fabric server instance.")
    .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
      prefix: "CF_",
    })
    .option("-i,--identity <path:string>", "Path to an identity keyfile.")
    .option("-q,--quiet", "Suppress hints and next-step suggestions.")
    .option("--json", "Output machine-readable JSON.");
}

export const profile = new Command()
  .name("profile")
  .description(
    cliText(
      "Your profile: create, locate, or repair its stored name protection; or, as an operator, make every profile its space's root.",
    ),
  )
  .default("help")
  .command(
    "create",
    connected(
      cliText(
        `Create a profile named <name> in your home space.

The same act as the shell's create form: the profile is made by the home
pattern's own handler, in a space of its own, and appended to your profile
list. Prints the new profile's address.`,
      ),
    )
      .arguments("<name:string>")
      .example(
        cliText(`cf profile create "Ada Lovelace" -i ./ada.key -a <url>`),
        "Create a profile and print where it landed.",
      )
      .action(async (options: ProfileCommandOptions, name: string) => {
        await profileCreateAction(options, name);
      }),
  )
  .command(
    "list",
    connected(
      cliText(
        `Print your profiles, in the order '#profile' answers in, one line
each: a '*' on the one '#profile' answers with, its space, its name, and
whether it has a picture, and whether the picture is attested to its owner.
With --json, print each one's name, picture ({ size, byOwner }, or null;
'cf profile get-picture' writes the bytes), legacy avatar ({ text, byOwner }, or
{ size, byOwner } for a data: URL, or null), space, address, and whether
'#profile' answers with it. A retired profile is not listed.`,
      ),
    )
      .example(
        cliText(`cf profile list -i ./ada.key -a <url>`),
        "List your profiles.",
      )
      .action(async (options: ProfileCommandOptions) => {
        await profileListAction(options);
      }),
  )
  .command(
    "rename",
    connected(
      cliText(
        `Rename the profile that lives in space <space> to <name>, through
the profile's own name handler.`,
      ),
    )
      .arguments("<space:string> <name:string>")
      .example(
        cliText(`cf profile rename did:key:z6Mk… "Ada" -i ./ada.key -a <url>`),
        "Rename a profile.",
      )
      .action(
        async (options: ProfileCommandOptions, space: string, name: string) => {
          await profileRenameAction(options, space, name);
        },
      ),
  )
  .command(
    "attest-name",
    connected(
      cliText(
        `Attest the name of your profile that lives in space <space> as yours,
retired or not, when the name's value carries no label, as a name stored
before names were labeled does. Without --apply it prints the stored name and
an inspection receipt, and changes nothing. Review the name, then repeat with
--apply --expect <inspection>: the stored name is accepted, unchanged, under
the profile's own owner policy for its name, as you, and its value is then
labeled as yours. A name changed since the inspection is refused, and so is a
profile that is not yours.`,
      ),
    )
      .arguments("<space:string>")
      .option(
        "--apply",
        "Accept the inspected name as yours.",
      )
      .option(
        "--expect <inspection:string>",
        "Exact inspection receipt required with --apply.",
      )
      .example(
        cliText(`cf profile attest-name did:key:z6Mk… -i ./ada.key -a <url>`),
        "Show an older profile's name and its inspection receipt.",
      )
      .example(
        cliText(
          `cf profile attest-name did:key:z6Mk… --apply --expect <inspection> -i ./ada.key -a <url>`,
        ),
        "Attest the name that inspection showed.",
      )
      .action(
        async (
          options: ProfileCommandOptions & { apply?: boolean; expect?: string },
          space: string,
        ) => {
          await profileAttestNameAction(options, space);
        },
      ),
  )
  .command(
    "get-picture",
    connected(
      cliText(
        `Write the bytes of the picture of the profile that lives in space
<space> to <file>, or to standard output when <file> is '-'. A picture not
attested to the profile's owner is refused.`,
      ),
    )
      .arguments("<space:string> <file:string>")
      .example(
        cliText(
          `cf profile get-picture did:key:z6Mk… ./ada.png -i ./ada.key -a <url>`,
        ),
        "Save a profile's picture.",
      )
      .action(
        async (options: ProfileCommandOptions, space: string, file: string) => {
          await profileGetPictureAction(options, space, file);
        },
      ),
  )
  .command(
    "set-picture",
    connected(
      cliText(
        `Set the picture of the profile that lives in space <space> to the
bytes of <image-file>, a PNG, JPEG, GIF, WebP, AVIF or BMP image of at most
256 KiB, stored as they are: nothing crops or scales them. With --clear and no
file, remove the picture and the legacy avatar text. With --keep-current and no
file, set the picture already stored again, as you, which attests it to you: a
picture stored before writes to it were labeled carries no label, and is not
attested to its owner until its owner sets it again.`,
      ),
    )
      .arguments("<space:string> [image-file:string]")
      .option(
        "--clear",
        "Remove the picture, and the legacy avatar text, instead of setting one.",
      )
      .option(
        "--keep-current",
        "Set the picture already stored again, as you, so it is attested to you.",
      )
      .example(
        cliText(
          `cf profile set-picture did:key:z6Mk… ./ada.png -i ./ada.key -a <url>`,
        ),
        "Set a profile's picture.",
      )
      .example(
        cliText(
          `cf profile set-picture did:key:z6Mk… --clear -i ./ada.key -a <url>`,
        ),
        "Remove a profile's picture.",
      )
      .example(
        cliText(
          `cf profile set-picture did:key:z6Mk… --keep-current -i ./ada.key -a <url>`,
        ),
        "Attest a profile's stored picture to its owner.",
      )
      .action(
        async (
          options: ProfilePictureOptions,
          space: string,
          file?: string,
        ) => {
          await profileSetPictureAction(options, space, file);
        },
      ),
  )
  .command(
    "retire",
    connected(
      cliText(
        `Retire the profile that lives in space <space>, as the picker's
Remove does: it stops being one of your profiles, and '#profile' does not
answer with it, until 'cf profile restore' restores it. The profile's space
and data stay on the host. The profile '#profile' returns, which is your
default when you have one, cannot be retired, and neither can your last
profile. Set another profile as the default first.`,
      ),
    )
      .arguments("<space:string>")
      .example(
        cliText(`cf profile retire did:key:z6Mk… -i ./ada.key -a <url>`),
        "Retire a profile.",
      )
      .action(async (options: ProfileCommandOptions, space: string) => {
        await profileRetireAction(options, space);
      }),
  )
  .command(
    "restore",
    connected(
      cliText(
        `Restore the retired profile that lives in space <space>: it is one of
your profiles again, and '#profile' may answer with it.`,
      ),
    )
      .arguments("<space:string>")
      .example(
        cliText(`cf profile restore did:key:z6Mk… -i ./ada.key -a <url>`),
        "Restore a retired profile.",
      )
      .action(async (options: ProfileCommandOptions, space: string) => {
        await profileRestoreAction(options, space);
      }),
  )
  .command(
    "show",
    connected(
      cliText(
        `Print the profile '#profile' resolves to, as JSON: its address and
its display name.`,
      ),
    )
      .example(
        cliText(`cf profile show -i ./ada.key -a <url>`),
        "Read the active profile's address and display name as JSON.",
      )
      .action(async (options: ProfileCommandOptions) => {
        await profileShowAction(options);
      }),
  )
  .command(
    "repair-name-protection",
    connected(
      "Inspect a profile's stored name protection, or apply its reviewed repair. Always prints JSON.",
    )
      .option(
        "--cell <address:string>",
        "Full profile address including its space DID.",
        { required: true },
      )
      .option(
        "--apply",
        "Accept the inspected name and persist its missing protection.",
      )
      .option(
        "--expect <inspection:string>",
        "Exact inspection receipt required with --apply.",
      )
      .action(
        async (
          options: ProfileCommandOptions & {
            cell: string;
            apply?: boolean;
            expect?: string;
          },
        ) => {
          await profileRepairNameProtectionAction(options);
        },
      ),
  )
  .command(
    "repair-root",
    connected(
      cliText(
        `Make each existing profile its space's root.

Without --from-snapshot, the profiles are the ones your own Home lists, read
live. With it, this is an operator's command across a whole store: the
profiles come from a snapshot of the store's space databases, read offline:
each Home's profile list, with profiles no Home lists reported and skipped
unless named with --cell. Each profile is inspected live, as your own identity,
and the plan prints as JSON with an inspection receipt. Repeat with --apply
--expect <inspection> to apply it. Always prints JSON.
It refuses a server that runs server execution, or does not say whether it
does, exiting 4: serve the store with server execution off. An apply whose
receipt no longer matches refuses too, exiting 3. A refusal writes nothing and
prints its reason as JSON.`,
      ),
    )
      .option(
        "--from-snapshot <dir:string>",
        "Directory holding a snapshot of the store's space databases.",
      )
      .option(
        "--cell <address:string>",
        "Repair only this full profile address, with --from-snapshot. Repeatable.",
        { collect: true },
      )
      .option("--apply", "Apply the inspected plan.")
      .option(
        "--expect <inspection:string>",
        "Exact run inspection receipt required with --apply.",
      )
      .example(
        cliText(
          `cf profile repair-root --from-snapshot ./snapshot -i ./admin.key -a <url>`,
        ),
        "Inspect every profile the snapshot's Homes list.",
      )
      .example(
        cliText(`cf profile repair-root -i ./me.key -a <url>`),
        "Inspect every profile your own Home lists.",
      )
      .action(
        async (
          options: ProfileCommandOptions & {
            fromSnapshot?: string;
            cell?: string[];
            apply?: boolean;
            expect?: string;
          },
        ) => {
          await profileRepairRootAction(options);
        },
      ),
  );
