/**
 * The mount flag vocabulary shared by every `cf fuse mount` spawn path.
 *
 * A mount travels through up to three processes: the `cf fuse mount` command
 * spawns a supervisor, and the supervisor spawns the FUSE child that owns
 * libfuse. Each hop passes the mount flags along on the command line, and the
 * spawned process may be either a `deno run` of a module or a subcommand of the
 * compiled `cf` binary. The tables below name each flag once, and both the argv
 * builders and the supervisor's argv parser read them.
 */

/** Mount flags the FUSE daemon accepts. */
export interface FuseMountFlags {
  mountpoint: string;
  apiUrl: string;
  identity: string;
  execCli: string;
  logFile?: string;
  spaces?: string[];
  debug?: boolean;
  allowOther?: boolean;
  noattrcache?: boolean;
  attrcacheTimeout?: string;
  cfcMode?: string;
  cfcAnnotations?: boolean;
  cfcXattrNamespace?: string;
  cfcWritebackXattrs?: boolean;
  cfcWritebackState?: string;
  dangerouslyAllowIncompatibleSchema?: boolean;
  supervisorStatusPath?: string;
}

/**
 * Mount flags the supervisor accepts: everything the daemon takes, plus the
 * mount state file the supervisor fills in once it knows the child's PID.
 */
export interface FuseSupervisorFlags extends FuseMountFlags {
  statePath?: string;
}

/** How a flag carries its field's value on the command line. */
type FlagArity =

  /** Present with a following value when the field is set. */
  | "value"
  /** Present without a value when the field is true. */
  | "switch"
  /** Repeated once per element of the field's array. */
  | "repeated";

interface FlagSpec {
  flag: string;
  arity: FlagArity;

  /** Single-dash form the supervisor parser also accepts. */
  alias?: string;

  /** Placeholder for the value in help output. */
  valueLabel?: string;

  help: string;
}

/**
 * One spec per flag field. Keying by field name makes a field with no spec a
 * type error, so a new mount flag reaches every hop or fails to compile.
 */
type FlagSpecs<Flags> = {
  readonly [Field in keyof Required<Omit<Flags, "mountpoint">>]: FlagSpec;
};

const MOUNT_FLAG_SPECS: FlagSpecs<FuseMountFlags> = {
  apiUrl: {
    flag: "--api-url",
    arity: "value",
    valueLabel: "<url>",
    help: "URL of the fabric server instance",
  },
  identity: {
    flag: "--identity",
    arity: "value",
    valueLabel: "<path>",
    help: "Path to an identity keyfile",
  },
  execCli: {
    flag: "--exec-cli",
    arity: "value",
    valueLabel: "<path>",
    help: "Path to the cf exec shim",
  },
  logFile: {
    flag: "--log-file",
    arity: "value",
    valueLabel: "<path>",
    help: "Path to the FUSE child log file",
  },
  debug: {
    flag: "--debug",
    arity: "switch",
    help: "Enable FUSE debug output",
  },
  allowOther: {
    flag: "--allow-other",
    arity: "switch",
    help: "Pass allow_other through to the FUSE child",
  },
  noattrcache: {
    flag: "--noattrcache",
    arity: "switch",
    help: "Pass noattrcache through to the FUSE child",
  },
  attrcacheTimeout: {
    flag: "--attrcache-timeout",
    arity: "value",
    valueLabel: "<seconds>",
    help: "Pass attrcache-timeout through to the FUSE child",
  },
  cfcMode: {
    flag: "--cfc-mode",
    arity: "value",
    valueLabel: "<mode>",
    help: "FUSE-side CFC mode",
  },
  cfcAnnotations: {
    flag: "--cfc-annotations",
    arity: "switch",
    help: "Publish CFC annotation xattrs",
  },
  cfcXattrNamespace: {
    flag: "--cfc-xattr-namespace",
    arity: "value",
    valueLabel: "<ns>",
    help: "CFC xattr namespace",
  },
  cfcWritebackXattrs: {
    flag: "--cfc-writeback-xattrs",
    arity: "switch",
    help: "Enable CFC writeback xattrs",
  },
  cfcWritebackState: {
    flag: "--cfc-writeback-state",
    arity: "value",
    valueLabel: "<path>",
    help: "CFC writeback state path",
  },
  dangerouslyAllowIncompatibleSchema: {
    flag: "--dangerously-allow-incompatible-schema",
    arity: "switch",
    help: "Allow incompatible source schema updates",
  },
  supervisorStatusPath: {
    flag: "--supervisor-status",
    arity: "value",
    valueLabel: "<path>",
    help: "Child readiness and heartbeat status file",
  },
  spaces: {
    flag: "--space",
    arity: "repeated",
    alias: "-s",
    valueLabel: "<name>",
    help: "Space(s) to connect",
  },
};

const SUPERVISOR_FLAG_SPECS: FlagSpecs<FuseSupervisorFlags> = {
  ...MOUNT_FLAG_SPECS,
  statePath: {
    flag: "--state-path",
    arity: "value",
    valueLabel: "<path>",
    help: "Mount state file to update with child PID",
  },
};

function encodeFlags(
  flags: FuseSupervisorFlags,
  specs: Record<string, FlagSpec>,
): string[] {
  const values = flags as unknown as Record<string, unknown>;
  const args: string[] = [];
  for (const [field, spec] of Object.entries(specs)) {
    const value = values[field];
    switch (spec.arity) {
      case "switch":
        if (value) args.push(spec.flag);
        break;
      case "value":
        if (value) args.push(spec.flag, String(value));
        break;
      case "repeated":
        for (const item of (value as string[] | undefined) ?? []) {
          args.push(spec.flag, item);
        }
        break;
    }
  }
  return args;
}

/** Encode the mount flags the FUSE daemon accepts. */
export function mountFlagArgs(flags: FuseMountFlags): string[] {
  return encodeFlags(flags, MOUNT_FLAG_SPECS);
}

/** Encode the mount flags the supervisor accepts. */
export function supervisorFlagArgs(flags: FuseSupervisorFlags): string[] {
  return encodeFlags(flags, SUPERVISOR_FLAG_SPECS);
}

export interface ParsedSupervisorArgs {
  options: FuseSupervisorFlags;
  help: boolean;
}

const SUPERVISOR_FLAG_LOOKUP: ReadonlyMap<
  string,
  { field: string; spec: FlagSpec }
> = new Map(
  Object.entries(SUPERVISOR_FLAG_SPECS).flatMap(([field, spec]) => {
    const entries: [string, { field: string; spec: FlagSpec }][] = [
      [spec.flag, { field, spec }],
    ];
    if (spec.alias) entries.push([spec.alias, { field, spec }]);
    return entries;
  }),
);

/** Decode a supervisor argv into the flags the supervisor runs with. */
export function parseSupervisorArgs(rawArgs: string[]): ParsedSupervisorArgs {
  const options: FuseSupervisorFlags = {
    mountpoint: "",
    apiUrl: "",
    identity: "",
    execCli: "",
    logFile: "",
    spaces: [],
  };
  const values = options as unknown as Record<string, unknown>;
  let help = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const match = SUPERVISOR_FLAG_LOOKUP.get(arg);
    if (match) {
      switch (match.spec.arity) {
        case "switch":
          values[match.field] = true;
          break;
        case "value":
          values[match.field] = requireValue(rawArgs, ++i, arg);
          break;
        case "repeated":
          (values[match.field] as string[]).push(
            requireValue(rawArgs, ++i, arg),
          );
          break;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown fuse supervisor option: ${arg}`);
    }
    if (options.mountpoint) {
      throw new Error(`Unexpected fuse supervisor argument: ${arg}`);
    }
    options.mountpoint = arg;
  }

  if (!help && !options.mountpoint) {
    throw new Error("Missing mountpoint for fuse supervisor.");
  }

  return { options, help };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/** Column the help descriptions start at, counted from the line start. */
const HELP_DESCRIPTION_COLUMN = 34;

function helpLine(label: string, help: string): string {
  const labeled = `  ${label}`;
  if (labeled.length + 1 > HELP_DESCRIPTION_COLUMN) {
    return `${labeled}\n${" ".repeat(HELP_DESCRIPTION_COLUMN)}${help}`;
  }
  return `${labeled.padEnd(HELP_DESCRIPTION_COLUMN)}${help}`;
}

export function supervisorHelp(): string {
  const lines = Object.values(SUPERVISOR_FLAG_SPECS).map((spec) => {
    const flags = spec.alias ? `${spec.alias}, ${spec.flag}` : spec.flag;
    const label = spec.valueLabel ? `${flags} ${spec.valueLabel}` : flags;
    return helpLine(label, spec.help);
  });
  lines.push(helpLine("-h, --help", "Show this help"));

  return `Usage: fuse-supervisor <mountpoint> [options]

Internal: supervise a background FUSE child process.

Options:
${lines.join("\n")}
`;
}
