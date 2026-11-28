/**
 * Writes the pattern that wraps an iframe-first guest, from the contract that
 * declares its data, and the guest's files beside it: the bundle of the
 * guest's source as `guest.js`, and, unless `--html` names the guest's own
 * document, a default one as `guest.html`. The wrapper reads both, and any
 * assets the contract names, with `dataFile()`, whose strings a piece's result
 * document links to rather than holds a copy of
 * (`docs/specs/iframe-static-assets.md`, parts 1 and 6).
 */

import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  toFileUrl,
} from "@std/path";

import { build } from "@commonfabric/felt";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  dataFileAssets,
  dataFileMediaType,
  isAssetName,
} from "@commonfabric/text/data-file";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_RESOURCES = new Set(["input", "state", "output"]);

/** The asset names setup refuses as keys of the record it stores. */
const RESERVED_ASSET_NAMES = new Set(["__proto__", "constructor"]);

/** The file the guest's bundle is written to, beside the wrapper. */
const GUEST_SCRIPT_FILE = "guest.js";

/** The file the default guest document is written to, beside the wrapper. */
const GUEST_HTML_FILE = "guest.html";

type Scope = "space" | "user" | "session";

type DatabaseConfig = {
  scope?: Scope;
  tables: Record<string, Record<string, string>>;
};

/** The resource whose field a presence room is derived from. */
type PresenceField = "state" | "output";

/**
 * The images, fonts, and sounds the guest is handed: a directory, whose assets
 * the wrapper reads with `dataFile.urls()`, or a record from an asset name to a
 * file the wrapper reads with `dataFile.url()`. In the contract, a path is
 * relative to the contract; in the wrapper, to the wrapper.
 */
type AssetsConfig = string | Record<string, string>;

type PatternConfig = {
  name: string;
  displayName?: string;
  stateScope?: Scope;
  outputScope?: Scope;
  frameHeight?: string;
  databases?: Record<string, DatabaseConfig>;
  presence?: Record<string, PresenceField>;
  streams?: readonly string[];
  assets?: AssetsConfig;
};

type Options = {
  contract?: string;
  guest?: string;
  out?: string;
  html?: string;
  force: boolean;
  help: boolean;
  react: boolean;
};

function usage(): string {
  return `Write the generated Common Fabric wrapper for an iframe-first pattern,
and the guest's bundle as ${GUEST_SCRIPT_FILE} beside it.

Usage:
  deno run -A scripts/write-iframe-wrapper.ts \\
    --contract <contract.ts> --guest <guest.ts|guest.tsx> --out <main.tsx>

Options:
  --contract <path>  Module exporting IFRAME_PATTERN and DEFAULT_INPUT/STATE/OUTPUT
  --guest <path>     Browser entry bundled into ${GUEST_SCRIPT_FILE} beside --out
  --out <path>       Generated pattern wrapper
  --html <path>      The guest's document, which the wrapper reads in place;
                     without it, a default document is written to
                     ${GUEST_HTML_FILE} beside --out
  --react            Compile TSX with the React instance imported by the guest
  --force            Replace existing output files
  --help             Show this help

The wrapper reads the document and ${GUEST_SCRIPT_FILE} with dataFile(). cf-iframe
runs ${GUEST_SCRIPT_FILE} as the document's last module script, so the document
holds no <script> for it.
`;
}

function parseArgs(args: string[]): Options {
  const options: Options = { force: false, help: false, react: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--force") {
      options.force = true;
    } else if (argument === "--react") {
      options.react = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (
      argument === "--contract" || argument === "--guest" ||
      argument === "--out" || argument === "--html"
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new TypeError(`${argument} requires a path.`);
      }
      const key = argument.slice(2) as "contract" | "guest" | "out" | "html";
      options[key] = value;
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value, false)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function scope(value: unknown, label: string): Scope {
  if (value === undefined) return "space";
  if (value === "space" || value === "user" || value === "session") {
    return value;
  }
  throw new TypeError(`${label} must be "space", "user", or "session".`);
}

/**
 * Helper for `validateConfig()`, which validates `IFRAME_PATTERN.assets`: a
 * directory path, or a record from an asset name to the path of a file whose
 * extension `dataFile.url()` reads. Returns `undefined` when it is absent.
 */
function assetsConfig(value: unknown): AssetsConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value;
  if (!isPlainObject(value, false)) {
    throw new TypeError(
      "IFRAME_PATTERN.assets must be a directory path or a record from an asset name to a file path.",
    );
  }
  const files: Record<string, string> = Object.create(null);
  for (const [name, path] of Object.entries(value)) {
    if (!isAssetName(name)) {
      throw new TypeError(
        `Asset name ${
          JSON.stringify(name)
        } must be made of letters, digits, "_", and "-", such as glaze.`,
      );
    }
    refuseReservedAssetName(name);
    if (typeof path !== "string" || path.trim() === "") {
      throw new TypeError(
        `Asset ${JSON.stringify(name)} must have a file path string.`,
      );
    }
    if (dataFileMediaType(path) === undefined) {
      throw new TypeError(
        `Asset ${
          JSON.stringify(name)
        } must name an image, font, or sound file that dataFile.url() reads, such as a .png, .woff2, or .mp3; found ${
          JSON.stringify(path)
        }.`,
      );
    }
    files[name] = path;
  }
  return files;
}

/** Throws for an asset name setup refuses as a record key. */
function refuseReservedAssetName(name: string): void {
  if (RESERVED_ASSET_NAMES.has(name)) {
    throw new TypeError(
      `Asset name ${
        JSON.stringify(name)
      } is reserved: setup refuses "__proto__" and "constructor" as keys of the record it stores.`,
    );
  }
}

/**
 * Validates the contract's `IFRAME_PATTERN`, and returns it with every
 * optional field filled in except `assets`, which stays absent when the
 * contract declares none. Throws, naming the field, for one it cannot take.
 */
function validateConfig(value: unknown):
  & Required<
    Pick<
      PatternConfig,
      "name" | "displayName" | "stateScope" | "outputScope" | "frameHeight"
    >
  >
  & {
    databases: Record<string, Required<DatabaseConfig>>;
    presence: Record<string, PresenceField>;
    streams: string[];
    assets: AssetsConfig | undefined;
  } {
  const source = record(value, "IFRAME_PATTERN");
  if (typeof source.name !== "string" || !IDENTIFIER.test(source.name)) {
    throw new TypeError(
      "IFRAME_PATTERN.name must be a TypeScript identifier such as QuickNotes.",
    );
  }
  const displayName = source.displayName ?? source.name;
  if (typeof displayName !== "string" || displayName.trim() === "") {
    throw new TypeError(
      "IFRAME_PATTERN.displayName must be a non-empty string.",
    );
  }
  const frameHeight = source.frameHeight ?? "100vh";
  if (typeof frameHeight !== "string" || frameHeight.trim() === "") {
    throw new TypeError(
      "IFRAME_PATTERN.frameHeight must be a non-empty string.",
    );
  }

  const databases: Record<string, Required<DatabaseConfig>> = Object.create(
    null,
  );
  const databaseSource = source.databases === undefined
    ? {}
    : record(source.databases, "IFRAME_PATTERN.databases");
  for (const [name, databaseValue] of Object.entries(databaseSource)) {
    if (name.length === 0 || RESERVED_RESOURCES.has(name)) {
      throw new TypeError(
        `Database name ${
          JSON.stringify(name)
        } must be non-empty and distinct from input, state, and output.`,
      );
    }
    const database = record(databaseValue, `Database ${JSON.stringify(name)}`);
    const tablesSource = record(
      database.tables,
      `Database ${JSON.stringify(name)} tables`,
    );
    const tables: Record<string, Record<string, string>> = Object.create(null);
    for (const [tableName, tableValue] of Object.entries(tablesSource)) {
      const columnsSource = record(
        tableValue,
        `Table ${JSON.stringify(tableName)} columns`,
      );
      const columns: Record<string, string> = Object.create(null);
      for (const [columnName, columnValue] of Object.entries(columnsSource)) {
        if (typeof columnValue !== "string" || columnValue.trim() === "") {
          throw new TypeError(
            `Column ${JSON.stringify(columnName)} in table ${
              JSON.stringify(tableName)
            } must have a SQL type string.`,
          );
        }
        columns[columnName] = columnValue;
      }
      tables[tableName] = columns;
    }
    databases[name] = {
      scope: scope(database.scope, `Database ${JSON.stringify(name)} scope`),
      tables,
    };
  }

  const presence: Record<string, PresenceField> = Object.create(null);
  const presenceSource = source.presence === undefined
    ? {}
    : record(source.presence, "IFRAME_PATTERN.presence");
  for (const [name, field] of Object.entries(presenceSource)) {
    if (
      name.length === 0 || RESERVED_RESOURCES.has(name) || name in databases
    ) {
      throw new TypeError(
        `Presence room name ${
          JSON.stringify(name)
        } must be non-empty and distinct from input, state, output, and every database.`,
      );
    }
    if (field !== "state" && field !== "output") {
      throw new TypeError(
        `Presence room ${
          JSON.stringify(name)
        } must name "state" or "output", the resource whose field it follows.`,
      );
    }
    presence[name] = field;
  }

  const streamSource = source.streams === undefined ? [] : source.streams;
  if (!Array.isArray(streamSource)) {
    throw new TypeError("IFRAME_PATTERN.streams must be an array of names.");
  }
  const streams: string[] = [];
  for (const name of streamSource) {
    // A stream's name is also a field of the generated input interface and a
    // destructured parameter, so it is an identifier; `__proto__` would
    // destructure the input's prototype rather than a field.
    if (
      typeof name !== "string" || !IDENTIFIER.test(name) ||
      name === "__proto__"
    ) {
      throw new TypeError(
        `Stream name ${
          JSON.stringify(name)
        } must be a TypeScript identifier such as addItem.`,
      );
    }
    if (
      RESERVED_RESOURCES.has(name) || name in databases || name in presence ||
      streams.includes(name)
    ) {
      throw new TypeError(
        `Stream name ${
          JSON.stringify(name)
        } must be distinct from input, state, output, every database, every presence room, and every other stream.`,
      );
    }
    streams.push(name);
  }

  return {
    name: source.name,
    displayName,
    stateScope: scope(source.stateScope, "IFRAME_PATTERN.stateScope"),
    outputScope: scope(source.outputScope, "IFRAME_PATTERN.outputScope"),
    frameHeight,
    databases,
    presence,
    streams,
    assets: assetsConfig(source.assets),
  };
}

/**
 * Returns the path of `target` relative to the directory holding `fromFile`,
 * with the leading `./` or `../` that an import specifier needs and that keeps
 * a `dataFile()` path from reading as one grounded at the package root.
 */
function relativePath(fromFile: string, target: string): string {
  const path = relative(dirname(fromFile), target).replaceAll("\\", "/");
  return path === ".." || path.startsWith("../") ? path : `./${path}`;
}

function htmlText(value: string): string {
  return value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * `text` made safe inside a block comment: a `*\/` in it would end the
 * comment early.
 */
function docCommentText(text: string): string {
  return text.replaceAll("*/", "*\\/");
}

/**
 * Returns the default guest document: a full-size `#root` for the guest to
 * draw into, titled with the pattern's display name, and no script, since
 * `cf-iframe` runs the guest's bundle after the document.
 */
function defaultGuestHtml(displayName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlText(displayName)}</title>
  <style>html,body,#root{box-sizing:border-box;width:100%;height:100%;margin:0}</style>
</head>
<body>
  <div id="root"></div>
</body>
</html>
`;
}

function scopedCellType(
  typeName: string,
  defaultName: string,
  valueScope: Exclude<Scope, "space">,
): string {
  const wrapper = valueScope === "user" ? "PerUser" : "PerSession";
  return `${wrapper}<Writable<Default<${typeName}, typeof ${defaultName}>>>`;
}

function objectEntries(value: Record<string, string>, indent: string): string {
  return Object.entries(value).map(([key, member]) =>
    `${indent}[${JSON.stringify(key)}]: ${JSON.stringify(member)},`
  ).join("\n");
}

function databaseVariable(index: number): string {
  return `iframeDatabase${index}`;
}

function databaseSource(
  databases: Record<string, Required<DatabaseConfig>>,
): string {
  if (Object.keys(databases).length === 0) return "";
  const declarations = Object.entries(databases).map(([, database], index) => {
    const variable = databaseVariable(index);
    const tablesVariable = `${variable}Tables`;
    const tables = Object.entries(database.tables).map(([tableName, columns]) =>
      `    [${JSON.stringify(tableName)}]: table({\n${
        objectEntries(columns, "      ")
      }\n    }),`
    ).join("\n");
    const annotation = database.scope === "space"
      ? ""
      : database.scope === "user"
      ? ": PerUser<SqliteDb>"
      : ": PerSession<SqliteDb>";
    return `  const ${tablesVariable} = {\n${tables}\n  };\n  const ${variable}${annotation} = sqliteDatabase({ tables: ${tablesVariable} });`;
  }).join("\n");
  return `  const { table } = cfSqlite;\n${declarations}\n`;
}

function streamVariable(index: number): string {
  return `iframeStream${index}`;
}

// A verb's declared result is no concern of the guest, whose send resolves
// with no value, so the frame takes a stream whatever result it declares.
function streamType(name: string): string {
  return `Stream<IframeStreamEvents[${JSON.stringify(name)}], unknown>`;
}

/** Where the files the wrapper names are, each relative to the wrapper. */
interface WrapperPaths {
  /** The contract module. */
  contract: string;

  /** The guest's source, which the bundle is built from. */
  guest: string;

  /** The guest's document. */
  document: string;

  /** The guest's bundle. */
  script: string;

  /** The guest's assets; absent when the contract declares none. */
  assets: AssetsConfig | undefined;
}

/**
 * Helper for `wrapperSource()`, which returns the declaration of the guest's
 * assets: a directory's assets read with `dataFile.urls()`, or each file read
 * with `dataFile.url()` under its asset name. Each name is a computed key, so
 * that `__proto__` is a property of the record rather than its prototype.
 */
function assetsSource(assets: AssetsConfig): string {
  const value = typeof assets === "string"
    ? `dataFile.urls(${JSON.stringify(assets)})`
    : Object.keys(assets).length === 0
    ? "{}"
    : `{\n${
      Object.entries(assets).map(([name, path]) =>
        `  [${JSON.stringify(name)}]: dataFile.url(${JSON.stringify(path)}),`
      ).join("\n")
    }\n}`;
  return `/** The guest's images, fonts, and sounds, by asset name. */
const GUEST_ASSETS = ${value};
`;
}

/** Returns the source of the wrapper pattern `config` describes. */
function wrapperSource(
  config: ReturnType<typeof validateConfig>,
  paths: WrapperPaths,
): string {
  const databases = Object.entries(config.databases);
  const streams = config.streams;
  const scopes = new Set<Scope>([
    ...(config.stateScope === "space" ? [] : [config.stateScope]),
    ...(config.outputScope === "space" ? [] : [config.outputScope]),
    ...databases.map(([, database]) => database.scope),
  ]);
  const constructsWritable = config.stateScope === "space" ||
    config.outputScope === "space";
  const imports = [
    ...(databases.length > 0 ? ["cfSqlite"] : []),
    "dataFile",
    "type Default",
    "NAME",
    "pattern",
    ...(scopes.has("session") ? ["type PerSession"] : []),
    ...(scopes.has("user") ? ["type PerUser"] : []),
    ...(databases.length > 0 ? ["sqliteDatabase", "type SqliteDb"] : []),
    ...(streams.length > 0 ? ["type Stream"] : []),
    "UI",
    "type VNode",
    constructsWritable ? "Writable" : "type Writable",
  ];
  // A presence room is the room of a field, so the context names the field's
  // cell a second time and the resource kind withholds its data.
  const presence = Object.entries(config.presence);
  const presenceFieldType = {
    state: "Writable<Default<IframeStateData, typeof DEFAULT_STATE>>",
    output: "Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>",
  };
  const contextResourceFields = [
    ...databases.map(([name]) => `  ${JSON.stringify(name)}: SqliteDb;`),
    ...presence.map(([name, field]) =>
      `  ${JSON.stringify(name)}: ${presenceFieldType[field]};`
    ),
    ...streams.map((name) => `  ${JSON.stringify(name)}: ${streamType(name)};`),
  ].join("\n");
  const contextResourceValues = [
    ...databases.map(([name], index) =>
      `    [${JSON.stringify(name)}]: ${databaseVariable(index)},`
    ),
    ...presence.map(([name, field]) =>
      `    [${JSON.stringify(name)}]: ${field},`
    ),
    ...streams.map((name, index) =>
      `    [${JSON.stringify(name)}]: ${streamVariable(index)},`
    ),
  ].join("\n");
  const resourceKinds = [
    '              input: "readonly",',
    ...databases.map(([name]) =>
      `              [${JSON.stringify(name)}]: "sqlite",`
    ),
    ...presence.map(([name]) =>
      `              [${JSON.stringify(name)}]: "presence",`
    ),
    ...streams.map((name) =>
      `              [${JSON.stringify(name)}]: "stream",`
    ),
  ].join("\n");
  // Each stream is a required input: the guest that sends to it has nothing
  // to send to without one. It is bound to a variable of its own, so its name
  // cannot shadow a name the wrapper's body uses.
  const streamInputFields = streams.map((name) =>
    `  ${name}: ${streamType(name)};\n`
  ).join("");
  const streamEventsImport = streams.length > 0
    ? "  type IframeStreamEvents,\n"
    : "";
  const streamParameters = streams.map((name, index) =>
    `  ${name}: ${streamVariable(index)},\n`
  ).join("");

  return `// Generated by scripts/write-iframe-wrapper.ts, as is the guest's bundle.
// Edit the contract or guest source and regenerate both.
/**
 * ${docCommentText(config.displayName)}, run as an iframe guest: the guest's
 * document and bundle in a \`cf-iframe\`, given the input, state and output
 * cells its contract declares.
 */
import {
${imports.map((name) => `  ${name},`).join("\n")}
} from "commonfabric";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
${streamEventsImport}} from ${JSON.stringify(paths.contract)};

export interface ${config.name}Input {
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;
${
    config.stateScope === "space" ? "" : `  state?: ${
      scopedCellType(
        "IframeStateData",
        "DEFAULT_STATE",
        config.stateScope,
      )
    };\n`
  }${
    config.outputScope === "space" ? "" : `  output?: ${
      scopedCellType(
        "IframeOutputData",
        "DEFAULT_OUTPUT",
        config.outputScope,
      )
    };\n`
  }${streamInputFields}}

export interface ${config.name}Output {
  [NAME]: string;
  [UI]: VNode;
  state: IframeStateData;
  output: IframeOutputData;
}

interface IframeContextInput {
  input: IframeInputData;
  state: Writable<Default<IframeStateData, typeof DEFAULT_STATE>>;
  output: Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>;
${contextResourceFields}
}

interface IframeContextOutput extends IframeContextInput {}

const IframeContext = pattern<IframeContextInput, IframeContextOutput>(
  (context) => context,
);

/** The guest's document. */
const GUEST_HTML = dataFile(${JSON.stringify(paths.document)});

/** The guest's bundle, built from \`${paths.guest}\`. */
const GUEST_SCRIPT = dataFile(${JSON.stringify(paths.script)});
${paths.assets === undefined ? "" : `\n${assetsSource(paths.assets)}`}
export default pattern<${config.name}Input, ${config.name}Output>(({
  input,
${config.stateScope === "space" ? "" : "  state,\n"}${
    config.outputScope === "space" ? "" : "  output,\n"
  }${streamParameters}}) => {
${
    config.stateScope === "space"
      ? "  const state = new Writable<IframeStateData>(DEFAULT_STATE);\n"
      : ""
  }${
    config.outputScope === "space"
      ? "  const output = new Writable<IframeOutputData>(DEFAULT_OUTPUT);\n"
      : ""
  }${
    databaseSource(config.databases)
  }  const iframeInput = input ?? DEFAULT_INPUT;
  const context = IframeContext({
    input: iframeInput,
    state,
    output,
${contextResourceValues}
  });

  return {
    [NAME]: ${JSON.stringify(config.displayName)},
    [UI]: (
      <div style={{ width: "100%", height: ${
    JSON.stringify(config.frameHeight)
  } }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
${
    paths.assets === undefined
      ? ""
      : "          assets={GUEST_ASSETS}\n"
  }          $context={context}
          resourceKinds={{
${resourceKinds}
          } as const}
        />
      </div>
    ),
    state,
    output,
  };
});
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function replaceFile(path: string, contents: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let present = false;
  try {
    await Deno.writeTextFile(temporary, contents, { createNew: true });
    present = true;
    // Replacing the directory entry rather than truncating `path` prevents a
    // forced regeneration from following an output symlink or hard link into
    // one of the authored source files.
    await Deno.rename(temporary, path);
    present = false;
  } catch (error) {
    if (present) {
      try {
        await Deno.remove(temporary);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Deno.errors.NotFound)) {
          throw new AggregateError(
            [error, cleanupError],
            `Could not write ${path} or remove its temporary file.`,
          );
        }
      }
    }
    throw error;
  }
}

/**
 * Helper for `main()`, which returns whether an entry of `kind` is at `path`,
 * following a symlink, and `false` when nothing is there.
 */
async function isEntry(
  path: string,
  kind: "file" | "directory",
): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return kind === "file" ? info.isFile : info.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * Helper for `main()`, which returns `assets`, whose paths are relative to the
 * contract at `contractPath`, with each path relative to the wrapper at
 * `outPath` instead. Throws for a directory or a file that is not there.
 */
async function wrapperAssets(
  assets: AssetsConfig,
  contractPath: string,
  outPath: string,
): Promise<AssetsConfig> {
  if (typeof assets === "string") {
    const directory = resolve(dirname(contractPath), assets);
    if (!await isEntry(directory, "directory")) {
      throw new TypeError(
        `IFRAME_PATTERN.assets names ${directory}, which is not a directory.`,
      );
    }
    // The build reads the directory by `dataFileAssets()`, so its refusals
    // are raised here, before anything is written.
    const names: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isFile || (entry.isSymlink && await isEntry(path, "file"))) {
        names.push(path);
      }
    }
    let held: Map<string, string>;
    try {
      held = dataFileAssets(directory, names);
    } catch (error) {
      throw new TypeError(
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const name of held.keys()) refuseReservedAssetName(name);
    return relativePath(outPath, directory);
  }
  const files: Record<string, string> = Object.create(null);
  for (const [name, path] of Object.entries(assets)) {
    const file = resolve(dirname(contractPath), path);
    if (!await isEntry(file, "file")) {
      throw new TypeError(
        `Asset ${JSON.stringify(name)} names ${file}, which is not a file.`,
      );
    }
    files[name] = relativePath(outPath, file);
  }
  return files;
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.contract || !options.guest || !options.out) {
    throw new TypeError(
      "--contract, --guest, and --out are required.\n\n" + usage(),
    );
  }

  const contractPath = resolve(options.contract);
  const guestPath = resolve(options.guest);
  const outPath = resolve(options.out);
  const htmlPath = options.html ? resolve(options.html) : undefined;
  const scriptPath = resolve(dirname(outPath), GUEST_SCRIPT_FILE);
  const documentPath = htmlPath ?? resolve(dirname(outPath), GUEST_HTML_FILE);

  // Every file the generator writes, in the order it writes them, each named
  // as a message about it names it.
  const outputs = [
    { path: scriptPath, label: `${GUEST_SCRIPT_FILE} beside --out` },
    ...(htmlPath === undefined
      ? [{ path: documentPath, label: `${GUEST_HTML_FILE} beside --out` }]
      : []),
    { path: outPath, label: "--out" },
  ];
  const sources = [contractPath, guestPath, ...(htmlPath ? [htmlPath] : [])];
  for (const { path, label } of outputs) {
    if (sources.includes(path)) {
      throw new TypeError(`${label} must not replace a source file.`);
    }
  }
  if (outputs.filter(({ path }) => path === outPath).length > 1) {
    throw new TypeError(
      `--out must not be ${
        basename(outPath)
      }, which the generator writes beside it.`,
    );
  }
  // A directory where an output goes cannot be replaced, and `--force` would
  // otherwise write the outputs before it and then fail at it.
  for (const { path, label } of outputs) {
    const info = await Deno.lstat(path).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    });
    if (info?.isDirectory) {
      throw new TypeError(`${label} names ${path}, which is a directory.`);
    }
  }
  if (!options.force) {
    for (const { path } of outputs) {
      if (!await exists(path)) continue;
      throw new TypeError(
        path === documentPath && htmlPath === undefined
          ? `${path} already exists; pass --force to regenerate it, or --html to read it as the guest's document.`
          : `${path} already exists; pass --force to regenerate it.`,
      );
    }
  }

  const contractModule = await import(
    `${toFileUrl(contractPath).href}?wrapper=${crypto.randomUUID()}`
  ) as Record<string, unknown>;
  for (const name of ["DEFAULT_INPUT", "DEFAULT_STATE", "DEFAULT_OUTPUT"]) {
    if (!Object.hasOwn(contractModule, name)) {
      throw new TypeError(`${contractPath} must export ${name}.`);
    }
  }
  const config = validateConfig(contractModule.IFRAME_PATTERN);
  if (htmlPath !== undefined && !await isEntry(htmlPath, "file")) {
    throw new TypeError(`--html names ${htmlPath}, which is not a file.`);
  }
  const assets = config.assets === undefined
    ? undefined
    : await wrapperAssets(config.assets, contractPath, outPath);

  const result = await build({
    entryPoints: [guestPath],
    ...(options.react
      ? {
        jsx: "transform" as const,
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
      }
      : {}),
    minify: true,
    sourcemap: false,
    target: ["es2022"],
    write: false,
  });
  if (!result.outputFiles || result.outputFiles.length !== 1) {
    throw new Error(
      "The guest build did not produce one self-contained script.",
    );
  }

  await replaceFile(scriptPath, result.outputFiles[0].text);
  if (htmlPath === undefined) {
    await replaceFile(documentPath, defaultGuestHtml(config.displayName));
  }
  await replaceFile(
    outPath,
    wrapperSource(config, {
      contract: relativePath(outPath, contractPath),
      guest: relativePath(outPath, guestPath),
      document: relativePath(outPath, documentPath),
      script: relativePath(outPath, scriptPath),
      assets,
    }),
  );
  for (const { path } of outputs) {
    console.log(
      `Wrote ${isAbsolute(options.out) ? path : relative(Deno.cwd(), path)}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
