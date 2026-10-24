import { dirname } from "@std/path/dirname";
import { fromFileUrl } from "@std/path/from-file-url";
import { join } from "@std/path/join";

import { Command } from "@cliffy/command";
import { getCompilerOptions } from "@commonfabric/js-compiler/typescript";
import { Engine } from "@commonfabric/runner";
import { StaticCache } from "@commonfabric/static";

export const init = new Command()
  .name("init")
  .description(
    "Initialize a TypeScript environment for evaluating patterns in external tools.",
  )
  .action(() => {
    return initWorkspace(Deno.cwd());
  });

function createTsConfig() {
  const filterProps = [
    "jsx",
    "jsxFactory",
    "jsxFragmentFactory",
    // Should migrate runtime options to also use `noLib` and
    // manually provide types
    "lib",
    // External tools will resolve on their own
    "noResolve",
    // "target" tsc lib types are different than tsconfig types
    "target",
    // "module" tsc lib types are different than tsconfig types
    "module",
  ];
  const compilerOptions = Object.entries(getCompilerOptions()).reduce(
    (output, [key, value]) => {
      if (!filterProps.includes(key)) {
        output[key] = value;
      }
      return output;
    },
    {} as Record<string, unknown>,
  );

  return {
    "compilerOptions": Object.assign({}, compilerOptions, {
      // Disable all libraries. Strictly only use
      // types provided by the runtime.
      "noLib": true,
      "types": ["cf-env"],
      "typeRoots": ["./.cf-types"],

      "jsx": "react-jsx",
      "target": "ES2023",
      "module": "amd",

      // This is specifically for `turndown` which has a
      // strange way of exporting itself -- TBD if
      // this needs to be added to the runtime TSC config,
      // but maybe that's handled with the __esDefault flag?
      "allowSyntheticDefaultImports": true,
      // TBD why this is needed here and not in our runtime options
      "allowImportingTsExtensions": true,
      // If we allowImportingTsExtensions, then we alos need noEmit
      "noEmit": true,
    }),
    "exclude": [
      "node_modules",
      "**/node_modules/*",
    ],
  };
}

// Creates the necessary type definitions
// in CWD so that patterns can be successfully parsed
// and typed against a typical typescript environment in e.g. VSCode.
//
// This is achieved by creating a `node_modules/@types/` directory
// containing types for the imported stdlib (`commonfabric`), the
// implicitly loaded jsx-runtime (`react/jsx-runtime`) and the
// environment types (`cf-env`) loaded by the `tsconfig.json`.
//
// Also copies pattern documentation from docs/common to .cf-docs for reference.
async function initWorkspace(cwd: string) {
  const cache = StaticCache.fromFileSystem();
  const runtimeModuleTypes = await Engine.getRuntimeModuleTypes(
    cache,
  );
  const { dom, es2023, jsx } = await Engine.getEnvironmentTypes(cache);

  // Concatenate all environment types into a single "lib",
  // which will be referred to as "cf-env" in the typescript config
  const cfEnv = Object.values({ dom, es2023 }).reduce((env, types) => {
    env += `${env}\n${types}`;
    return env;
  }, "");

  // The JSX types needs a different type of declaration'
  // to be used within a vanilla typescript environment
  const jsxRuntime = jsx.replace(
    `declare global`,
    `declare module "react/jsx-runtime"`,
  );

  const types = {
    "commonfabric": runtimeModuleTypes.commonfabric,
    "turndown": runtimeModuleTypes.turndown,
    "cf-env": cfEnv,
    "react/jsx-runtime": jsxRuntime,
  };

  for (const [name, typeDef] of Object.entries(types)) {
    const path = join(cwd, ".cf-types", name);
    await Deno.mkdir(path, {
      recursive: true,
    });
    await Deno.writeTextFile(join(path, "index.d.ts"), typeDef);
  }
  await Deno.writeTextFile(
    join(cwd, "tsconfig.json"),
    JSON.stringify(createTsConfig(), null, 2),
  );

  // Copy pattern documentation files to .cf-docs folder
  try {
    const cfDocsPath = join(cwd, ".cf-docs");
    await Deno.mkdir(cfDocsPath, { recursive: true });

    // In compiled binary, docs are bundled and accessible relative to the binary location
    const currentDir = dirname(fromFileUrl(import.meta.url));
    const docsCommonPath = join(currentDir, "..", "..", "..", "docs", "common");

    // Copy each documentation file dynamically
    try {
      for await (const entry of Deno.readDir(docsCommonPath)) {
        if (entry.isFile) {
          const sourcePath = join(docsCommonPath, entry.name);
          const targetPath = join(cfDocsPath, entry.name);
          const content = await Deno.readTextFile(sourcePath);
          await Deno.writeTextFile(targetPath, content);
        }
      }
    } catch (dirError) {
      console.warn(
        "Warning: Could not read docs directory:",
        dirError instanceof Error ? dirError.message : String(dirError),
      );
    }
  } catch (error) {
    console.warn(
      "Warning: Could not copy pattern documentation:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
