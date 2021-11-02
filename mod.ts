// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.

import { getCompilerScriptTarget, outputDiagnostics } from "./lib/compiler.ts";
import { colors, createProjectSync, path, ts, CodeBlockWriter } from "./lib/mod.deps.ts";
import { PackageJsonObject } from "./lib/types.ts";
import { glob } from "./lib/utils.ts";
import { SpecifierMappings, transform, TransformOutput } from "./transform.ts";
import * as compilerTransforms from "./lib/compiler_transforms.ts";
import { getPackageJson } from "./lib/package_json.ts";
import { ScriptTarget } from "./lib/compiler.ts";

export * from "./transform.ts";

export interface EntryPoint {
  /** Name of the entrypoint in the "exports". */
  name: string;
  /** Path to the entrypoint. */
  path: string | URL;
}

export interface BuildOptions {
  /** Entrypoint(s) to the Deno module. Ex. `./mod.ts` */
  entryPoints: (string | EntryPoint)[];
  /** Directory to output to. */
  outDir: string;
  /** Type check the output.
   * @default true
   */
  typeCheck?: boolean;
  /** Collect and run test files.
   * @default true
   */
  test?: boolean;
  /** Create declaration files.
   * @default true
   */
  declaration?: boolean;
  /** Output the canonical TypeScript in the output directory before type checking.
   *
   * This may be useful when debugging issues.
   * @default false
   */
  keepSourceFiles?: boolean;
  /** Keep the test files after tests run. */
  keepTestFiles?: boolean;
  /** Root directory to find test files in. Defaults to the cwd. */
  rootTestDir?: string;
  /** Glob pattern to use to find tests files. Defaults to `deno test`'s pattern. */
  testPattern?: string;
  /** Package to use for shimming the `Deno` namespace. Defaults to `deno.ns` */
  shimPackage?: {
    name: string;
    version: string;
  };
  /** Specifiers to map from and to. */
  mappings?: SpecifierMappings;
  /** Package.json output. You may override dependencies and dev dependencies in here. */
  package: PackageJsonObject;
  /** Optional compiler options. */
  compilerOptions?: {
    target?: ScriptTarget;
  }
}

/** Emits the specified Deno module to an npm package using the TypeScript compiler. */
export async function build(options: BuildOptions): Promise<void> {
  // set defaults
  options = {
    ...options,
    typeCheck: options.typeCheck ?? true,
    test: options.test ?? true,
    declaration: options.declaration ?? true,
  };
  const entryPoints: EntryPoint[] = options.entryPoints.map((e, i) => {
    if (typeof e === "string") {
      return {
        name: i === 0 ? "." : e.replace(/\.tsx?$/i, ".js"),
        path: e,
      };
    } else {
      return e;
    }
  });

  await Deno.permissions.request({ name: "write", path: options.outDir });

  const shimPackage = options.shimPackage ?? {
    name: "deno.ns",
    version: "0.6.1",
  };

  log("Transforming...");
  const transformOutput = await transformEntryPoints();
  for (const warning of transformOutput.warnings) {
    warn(warning);
  }

  const createdDirectories = new Set<string>();
  const writeFile = ((filePath: string, fileText: string) => {
    const dir = path.dirname(filePath);
    if (!createdDirectories.has(dir)) {
      Deno.mkdirSync(dir, { recursive: true });
      createdDirectories.add(dir);
    }
    Deno.writeTextFileSync(filePath, fileText);
  });

  createPackageJson();
  createNpmIgnore();

  // npm install in order to prepare for checking TS diagnostics
  log("Running npm install...");
  const npmInstallPromise = runNpmCommand(["install"]);
  if (options.typeCheck || options.declaration) {
    // Unfortunately this can't be run in parallel to building the project
    // in this case because TypeScript will resolve the npm packages when
    // creating the project.
    await npmInstallPromise;
  }

  log("Building project...");
  const esmOutDir = path.join(options.outDir, "esm");
  const umdOutDir = path.join(options.outDir, "umd");
  const typesOutDir = path.join(options.outDir, "types");
  const project = createProjectSync({
    compilerOptions: {
      outDir: typesOutDir,
      allowJs: true,
      stripInternal: true,
      strictNullChecks: true,
      declaration: options.declaration,
      esModuleInterop: false,
      isolatedModules: true,
      useDefineForClassFields: true,
      experimentalDecorators: true,
      jsx: ts.JsxEmit.React,
      jsxFactory: "React.createElement",
      jsxFragmentFactory: "React.Fragment",
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      module: ts.ModuleKind.ES2015,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      target: getCompilerScriptTarget(options.compilerOptions?.target),
      allowSyntheticDefaultImports: true,
      importHelpers: true,
    },
  });

  for (
    const outputFile of [
      ...transformOutput.main.files,
      ...transformOutput.test.files,
    ]
  ) {
    const outputFilePath = path.join(
      options.outDir,
      "src",
      outputFile.filePath,
    );
    project.createSourceFile(
      outputFilePath,
      outputFile.fileText,
    );
    if (options.keepSourceFiles) {
      writeFile(outputFilePath, outputFile.fileText);
    }
  }

  let program = project.createProgram();

  if (options.typeCheck) {
    log("Type checking...");
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      outputDiagnostics(diagnostics);
      Deno.exit(1);
    }
  }

  // emit only the .d.ts files
  if (options.declaration) {
    log("Emitting declaration files...");
    emit({ onlyDtsFiles: true });
  }

  // emit the esm files
  log("Emitting ESM package...");
  project.compilerOptions.set({
    declaration: false,
    outDir: esmOutDir,
  });
  program = project.createProgram();
  emit();
  writeFile(
    path.join(esmOutDir, "package.json"),
    `{\n  "type": "module"\n}\n`,
  );

  // emit the umd files
  log("Emitting CommonJs package...");
  project.compilerOptions.set({
    declaration: false,
    esModuleInterop: true,
    outDir: umdOutDir,
    module: ts.ModuleKind.UMD,
  });
  program = project.createProgram();
  emit({
    transformers: {
      before: [compilerTransforms.transformImportMeta],
    },
  });
  writeFile(
    path.join(umdOutDir, "package.json"),
    `{\n  "type": "commonjs"\n}\n`,
  );

  // ensure this is done before running tests
  await npmInstallPromise;

  if (options.test) {
    log("Running tests...");
    await createTestLauncherScript();
    await runNpmCommand(["run", "test"]);
    if (!options.keepTestFiles) {
      await deleteTestFiles();
    }
  }

  log("Complete!");

  function emit(
    opts?: { onlyDtsFiles?: boolean; transformers?: ts.CustomTransformers },
  ) {
    const emitResult = program.emit(
      undefined,
      (filePath, data, writeByteOrderMark) => {
        if (writeByteOrderMark) {
          data = "\uFEFF" + data;
        }
        writeFile(filePath, data);
      },
      undefined,
      opts?.onlyDtsFiles,
      opts?.transformers,
    );

    if (emitResult.diagnostics.length > 0) {
      outputDiagnostics(emitResult.diagnostics);
      Deno.exit(1);
    }
  }

  function createPackageJson() {
    const packageJsonObj = getPackageJson({
      entryPoints,
      shimPackage,
      transformOutput,
      package: options.package,
      testEnabled: options.test,
    });
    writeFile(
      path.join(options.outDir, "package.json"),
      JSON.stringify(packageJsonObj, undefined, 2),
    );
  }

  function createNpmIgnore() {
    const lines = [];
    if (options.keepSourceFiles) {
      lines.push("src/");
    }
    if (options.test) {
      for (const fileName of getTestFileNames()) {
        lines.push(fileName.replace(/^\.\//, ""));
      }
    }

    if (lines.length > 0) {
      const fileText = Array.from(lines).join("\n") + "\n";
      writeFile(
        path.join(options.outDir, ".npmignore"),
        fileText,
      );
    }
  }

  async function deleteTestFiles() {
    for (const file of getTestFileNames()) {
      await Deno.remove(path.join(options.outDir, file));
    }
  }

  function* getTestFileNames() {
    for (const file of transformOutput.test.files) {
      // ignore test declaration files as they won't show up in the emit
      if (/\.d\.ts$/i.test(file.filePath)) {
        continue;
      }

      const filePath = file.filePath.replace(/\.ts$/i, ".js");
      yield `./esm/${filePath}`;
      yield `./umd/${filePath}`;
    }
    yield "./test_runner.js";
  }

  async function transformEntryPoints(): Promise<TransformOutput> {
    return transform({
      entryPoints: entryPoints.map((e) => e.path),
      testEntryPoints: options.test
        ? await glob({
          pattern: getTestPattern(),
          rootDir: options.rootTestDir ?? Deno.cwd(),
          excludeDirs: [options.outDir],
        })
        : [],
      shimPackageName: shimPackage.name,
      mappings: options.mappings,
    });
  }

  function log(message: string) {
    console.log(`[dnt] ${message}`);
  }

  function warn(message: string) {
    console.warn(colors.yellow(`[dnt] ${message}`));
  }

  async function createTestLauncherScript() {
    const writer = createWriter();
    writer.writeLine(`const chalk = require("chalk");`)
      .writeLine(`const process = require("process");`);
    if (transformOutput.test.shimUsed) {
      writer.writeLine(`const { testDefinitions } = require("${shimPackage.name}/test-internals");`);
    }
    writer.blankLine();

    writer.writeLine("const filePaths = [");
    writer.indent(() => {
      for (const entryPoint of transformOutput.test.entryPoints) {
        writer.writeLine(`"${entryPoint.replace(/\.ts$/, ".js")}",`);
      }
    });
    writer.writeLine("];").newLine();

    writer.write("async function main()").block(() => {
      writer.write("for (const [i, filePath] of filePaths.entries())").block(() => {
        writer.write("if (i > 0)").block(() => {
          writer.writeLine(`console.log("");`);
        }).blankLine();

        writer.writeLine(`const umdPath = "./umd/" + filePath;`);
        writer.writeLine(`console.log("Running tests in " + chalk.underline(umdPath) + "...\\n");`);
        writer.writeLine(`process.chdir(__dirname + "/umd");`);
        writer.writeLine(`require(umdPath);`);
        if (transformOutput.test.shimUsed) {
          writer.writeLine("await runTestDefinitions();");
        }
        writer.blankLine();

        writer.writeLine(`const esmPath = "./esm/" + filePath;`);
        writer.writeLine(`process.chdir(__dirname + "/esm");`);
        writer.writeLine(`console.log("\\nRunning tests in " + chalk.underline(esmPath) + "...\\n");`);
        writer.writeLine(`await import(esmPath);`);
        if (transformOutput.test.shimUsed) {
          writer.writeLine("await runTestDefinitions();");
        }
      });
    });
    writer.blankLine();

    if (transformOutput.test.shimUsed) {
      writer.writeLine(`${getRunTestDefinitionsCode()}`);
      writer.blankLine();
    }

    writer.writeLine("main();");

    writeFile(
      path.join(options.outDir, "test_runner.js"),
      writer.toString(),
    );
  }

  async function runNpmCommand(args: string[]) {
    const cmd = getCmd();
    await Deno.permissions.request({ name: "run", command: cmd[0] });
    const process = Deno.run({
      cmd,
      cwd: options.outDir,
      stderr: "inherit",
      stdout: "inherit",
      stdin: "inherit",
    });

    try {
      const status = await process.status();
      if (!status.success) {
        throw new Error(
          `npm ${args.join(" ")} failed with exit code ${status.code}`,
        );
      }
    } finally {
      process.close();
    }

    function getCmd() {
      const cmd = ["npm", ...args];
      if (Deno.build.os === "windows") {
        return ["cmd", "/c", ...cmd];
      } else {
        return cmd;
      }
    }
  }

  function getTestPattern() {
    // * named `test.{ts, tsx, js, mjs, jsx}`,
    // * or ending with `.test.{ts, tsx, js, mjs, jsx}`,
    // * or ending with `_test.{ts, tsx, js, mjs, jsx}`
    return options.testPattern ??
      "**/{test.{ts,tsx,js,mjs,jsx},*.test.{ts,tsx,js,mjs,jsx},*_test.{ts,tsx,js,mjs,jsx}}";
  }
}

function getRunTestDefinitionsCode() {
  // todo: extract out for unit testing
  return `
async function runTestDefinitions() {
  const currentDefinitions = testDefinitions.splice(0, testDefinitions.length);
  const testFailures = [];
  for (const definition of currentDefinitions) {
    process.stdout.write("test " + definition.name + " ...");
    if (definition.ignored) {
     process.stdout.write(" ignored\\n");
     continue;
    }
    const context = getTestContext();
    let pass = false;
    try {
      await definition.fn(context);
      if (context.hasFailingChild) {
        testFailures.push({ name: definition.name, err: new Error("Had failing test step.") });
      } else {
        pass = true;
      }
    } catch (err) {
      testFailures.push({ name: definition.name, err });
    }
    const testStepOutput = context.getOutput();
    if (testStepOutput.length > 0) {
      process.stdout.write(testStepOutput);
    } else {
      process.stdout.write(" ");
    }
    process.stdout.write(getStatusText(pass ? "ok" : "fail"));
    process.stdout.write("\\n");
  }

  if (testFailures.length > 0) {
    console.log("\\nFAILURES\\n");
    for (const failure of testFailures) {
      console.log(failure.name);
      console.log(indentText((failure.err?.stack ?? err).toString(), 1));
      console.log("");
    }
    process.exit(1);
  }
}

function getTestContext() {
  return {
    name: undefined,
    status: "ok",
    children: [],
    get hasFailingChild() {
      return this.children.some(c => c.status === "fail" || c.status === "pending");
    },
    getOutput() {
      let output = "";
      if (this.name) {
        output += "test " + this.name + " ...";
      }
      if (this.children.length > 0) {
        output += "\\n" + this.children.map(c => indentText(c.getOutput(), 1)).join("\\n") + "\\n";
      } else if (!this.err) {
        output += " ";
      }
      if (this.name && this.err) {
        output += "\\n";
      }
      if (this.err) {
        output += indentText((this.err?.stack ?? this.err).toString(), 1);
        if (this.name) {
          output += "\\n";
        }
      }
      if (this.name) {
        output += getStatusText(this.status);
      }
      return output;
    },
    async step(nameOrTestDefinition, fn) {
      const definition = getDefinition();

      const context = getTestContext();
      context.status = "pending";
      context.name = definition.name;
      context.status = "pending";
      this.children.push(context);

      if (definition.ignored) {
        context.status = "ignored";
        return false;
      }

      try {
        await definition.fn(context);
        context.status = "ok";
        if (context.hasFailingChild) {
          context.status = "fail";
          return false;
        }
        return true;
      } catch (err) {
        context.status = "fail";
        context.err = err;
        return false;
      }

      function getDefinition() {
        if (typeof nameOrTestDefinition === "string") {
          if (!(fn instanceof Function)) {
            throw new TypeError("Expected function for second argument.");
          }
          return {
            name: nameOrTestDefinition,
            fn,
          };
        } else if (typeof nameOrTestDefinition === "object") {
          return nameOrTestDefinition;
        } else {
          throw new TypeError(
            "Expected a test definition or name and function.",
          );
        }
      }
    }
  };
}

function getStatusText(status) {
  switch (status) {
    case "ok":
      return chalk.green(status);
    case "fail":
    case "pending":
      return chalk.red(status);
    case "ignore":
      return chalk.gray(status);
    default:
      return status;
  }
}

function indentText(text, indentLevel) {
  if (text === undefined) {
    text = "[undefined]";
  } else if (text === null) {
    text = "[null]";
  } else {
    text = text.toString();
  }
  return text.split(/\\r?\\n/).map(line => "  ".repeat(indentLevel) + line).join("\\n");
}
`.trim();
}

function createWriter() {
  return new CodeBlockWriter({
    indentNumberOfSpaces: 2,
  });
}