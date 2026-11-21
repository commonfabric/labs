# @commonfabric/felt

**F**ront**e**nd **L**ightweight **T**ooling

A lightweight frontend build tool.

## Config

Configuration is stored in a project root's `felt.config.ts` file. Only
`entries` and `outDir` are required. `interface.ts` documents every field.

```ts
// felt.config.ts
export default {
  // Each entry's `in` is relative to the project root, and its `out` is
  // relative to `outDir`, without the extension.
  entries: [{ in: "src/index.ts", out: "scripts/index" }],
  outDir: "dist",
  hostname: "127.0.0.1",
  port: 5173,
  publicDir: "public",
  watchDir: "src",
  esbuild: {
    sourcemap: true,
    minify: false,
    // https://esbuild.github.io/api/#external
    external: ["some-package-that-cant-be-resolved"],
    // Global variables to be replaced with static values.
    define: {
      "$DEBUG": Deno.env.get("DEBUG"),
    },
    // https://esbuild.github.io/api/#supported
    supported: {
      using: false,
    },
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: false,
        experimentalDecorators: true,
      },
    },
  },
};
```

## Commands

- `felt build .`: Build current project.
- `felt serve .`: Serve current project.
- `felt dev .`: Serves current project, rebuilding and reloading on source
  change. A change made while a build runs causes one more build when it
  finishes.

`serve` and `dev` exit with status 3 when the port is already in use.
