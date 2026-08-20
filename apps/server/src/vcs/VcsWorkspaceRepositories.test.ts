// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsWorkspaceRepositories from "./VcsWorkspaceRepositories.ts";
import { parseSubmoduleStatus } from "./VcsWorkspaceRepositories.ts";

const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const TestLayer = VcsWorkspaceRepositories.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "workspace-repositories-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    // Temp roots are symlinked on macOS; the service canonicalises, so the test
    // compares against the canonical form too.
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    return yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "VcsWorkspaceRepositories.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 20_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["config", "protocol.file.allow", "always"]);
    yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

describe("parseSubmoduleStatus", () => {
  it("reads paths and skips uninitialised submodules", () => {
    const stdout = [
      " c3e2647065fd2a3d3e8a2795ea5d38a8688c5365 Shuffull (heads/enrichment)",
      "+bab30ef5f4bf0caf6d68e7fdab813295ab4e97ce ShuffullApp (heads/expo-router)",
      " adf52ebbd8b93f3fb5b9107e787a6f73b8f9d118 Shuffull/Shuffull.Metadata (heads/main)",
      "-4a3d440f694f90b1e823a698f06f70cae4b9ba01 NotInitialised",
      "",
    ].join("\n");

    expect(parseSubmoduleStatus(stdout)).toEqual([
      "Shuffull",
      "ShuffullApp",
      "Shuffull/Shuffull.Metadata",
    ]);
  });

  it("keeps paths that contain spaces and have no describe suffix", () => {
    const stdout = " 4a3d440f694f90b1e823a698f06f70cae4b9ba01 my modules/inner repo\n";
    expect(parseSubmoduleStatus(stdout)).toEqual(["my modules/inner repo"]);
  });
});

it.layer(TestLayer)("VcsWorkspaceRepositories.layer", (it) => {
  it.effect("reports a lone repository as the primary root", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir();
      yield* initRepoWithCommit(root);

      const repositories = yield* VcsWorkspaceRepositories.VcsWorkspaceRepositories;
      const result = yield* repositories.list({ cwd: root });

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]).toMatchObject({
        root,
        relativePath: "",
        linkage: "root",
        isPrimary: true,
        kind: "git",
      });
    }),
  );

  it.effect("finds submodules of the workspace root repository", () =>
    Effect.gen(function* () {
      const base = yield* makeTmpDir();
      const child = NodePath.join(base, "child-origin");
      const root = NodePath.join(base, "superproject");
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(child, { recursive: true });
      yield* fileSystem.makeDirectory(root, { recursive: true });
      yield* initRepoWithCommit(child);
      yield* initRepoWithCommit(root);
      yield* git(root, ["-c", "protocol.file.allow=always", "submodule", "add", child, "vendored"]);
      yield* git(root, ["commit", "-m", "add submodule"]);

      const repositories = yield* VcsWorkspaceRepositories.VcsWorkspaceRepositories;
      const result = yield* repositories.list({ cwd: root });

      expect(result.repositories.map((repository) => repository.relativePath)).toEqual([
        "",
        "vendored",
      ]);
      expect(result.repositories[1]).toMatchObject({
        root: NodePath.join(root, "vendored"),
        linkage: "submodule",
        isPrimary: false,
      });
    }),
  );

  it.effect("finds clones inside a workspace whose root is not a repository", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir();
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = NodePath.join(root, "projects", "app");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* initRepoWithCommit(nested);

      const repositories = yield* VcsWorkspaceRepositories.VcsWorkspaceRepositories;
      const result = yield* repositories.list({ cwd: root });

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]).toMatchObject({
        root: nested,
        relativePath: "projects/app",
        linkage: "nested",
        isPrimary: true,
      });
    }),
  );

  it.effect("skips build output directories while scanning", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir();
      const fileSystem = yield* FileSystem.FileSystem;
      const ignored = NodePath.join(root, "node_modules", "vendored");
      const hidden = NodePath.join(root, ".cache", "vendored");
      yield* fileSystem.makeDirectory(ignored, { recursive: true });
      yield* fileSystem.makeDirectory(hidden, { recursive: true });
      yield* initRepoWithCommit(ignored);
      yield* initRepoWithCommit(hidden);

      const repositories = yield* VcsWorkspaceRepositories.VcsWorkspaceRepositories;
      const result = yield* repositories.list({ cwd: root });

      expect(result.repositories).toEqual([]);
    }),
  );

  it.effect("does not descend into a repository it already found", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir();
      const fileSystem = yield* FileSystem.FileSystem;
      const outer = NodePath.join(root, "outer");
      const inner = NodePath.join(outer, "inner");
      yield* fileSystem.makeDirectory(inner, { recursive: true });
      yield* initRepoWithCommit(outer);
      yield* initRepoWithCommit(inner);

      const repositories = yield* VcsWorkspaceRepositories.VcsWorkspaceRepositories;
      const result = yield* repositories.list({ cwd: root });

      expect(result.repositories.map((repository) => repository.relativePath)).toEqual(["outer"]);
    }),
  );
});
