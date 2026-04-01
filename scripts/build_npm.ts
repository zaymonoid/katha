import { build, emptyDir } from "@deno/dnt";

await emptyDir("./npm");

await build({
  entryPoints: [
    "./src/index.ts",
    { name: "./lit", path: "./src/lit.ts" },
    { name: "./react", path: "./src/react.ts" },
    { name: "./query", path: "./src/query.ts" },
    { name: "./query-devtools", path: "./src/query-devtools.ts" },
  ],
  outDir: "./npm",
  shims: {},
  scriptModule: false,
  typeCheck: false,
  test: false,
  compilerOptions: {
    lib: ["ESNext", "DOM", "DOM.Iterable"],
    target: "Latest",
    experimentalDecorators: true,
    useDefineForClassFields: false,
  },
  mappings: {
    "npm:react@^18.0.0": { name: "react", version: "^18.0.0 || ^19.0.0", peerDependency: true },
    "npm:lit@^3.0.0": { name: "lit", version: "^3.0.0", peerDependency: true },
    "npm:date-fns@^4.1.0": { name: "date-fns", version: "^4.1.0", peerDependency: true },
  },
  package: {
    name: "@zaymonoid/katha",
    version: Deno.args[0] ?? "0.1.0",
    description: "Saga-pattern state management built on Effect-TS structured concurrency",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/ZaymonFC/katha.git",
    },
    dependencies: {
      effect: "^3.0.0",
      "fast-equals": "^6.0.0",
    },
    peerDependencies: {
      react: "^18.0.0 || ^19.0.0",
      lit: "^3.0.0",
      "date-fns": "^4.1.0",
    },
    peerDependenciesMeta: {
      react: { optional: true },
      lit: { optional: true },
      "date-fns": { optional: true },
    },
    publishConfig: {
      access: "public",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");

    // dnt auto-adds peer deps to dependencies too — remove the duplicates
    const pkgPath = "npm/package.json";
    const pkg = JSON.parse(Deno.readTextFileSync(pkgPath));
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      delete pkg.dependencies?.[name];
    }
    Deno.writeTextFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  },
});
