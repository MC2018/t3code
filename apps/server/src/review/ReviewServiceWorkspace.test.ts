// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsWorkspaceRepositories from "../vcs/VcsWorkspaceRepositories.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ReviewService from "./ReviewService.ts";

/**
 * The workspace root doubles as the server's configured cwd so the review
 * boundary check accepts the repositories discovered underneath it.
 */
function makeTestLayer(workspaceRoot: string) {
  const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
  const registryLayer = VcsDriverRegistry.layer.pipe(Layer.provide(vcsProcessLayer));
  const gitDriverLayer = GitVcsDriver.layer.pipe(
    Layer.provide(vcsProcessLayer),
    Layer.provide(ServerConfig.layerTest(workspaceRoot, workspaceRoot)),
    Layer.provide(NodeServices.layer),
  );
  const workspaceRepositoriesLayer = VcsWorkspaceRepositories.layer.pipe(
    Layer.provide(registryLayer),
    Layer.provide(NodeServices.layer),
  );
  // The workspace under test stands in for a registered project, which is what
  // makes its path a legitimate review target.
  const projectionSnapshotQueryLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: [
          {
            id: ProjectId.make("00000000-0000-4000-8000-000000000000"),
            title: "workspace",
            workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        threads: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
  });
  return ReviewService.layer.pipe(
    Layer.provideMerge(gitDriverLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(workspaceRepositoriesLayer),
    Layer.provideMerge(projectionSnapshotQueryLayer),
    Layer.provideMerge(vcsProcessLayer),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, workspaceRoot)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "ReviewServiceWorkspace.test.git",
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
  fileName: string,
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
    yield* fileSystem.writeFileString(NodePath.join(cwd, fileName), "original\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function makeWorkspaceDir(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
    return yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
  });
}

describe("ReviewService multi-repository previews", () => {
  it.effect("prefixes each repository's diff with its workspace directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* makeWorkspaceDir();
      const alpha = NodePath.join(workspace, "alpha");
      const beta = NodePath.join(workspace, "beta");
      yield* fileSystem.makeDirectory(alpha, { recursive: true });
      yield* fileSystem.makeDirectory(beta, { recursive: true });

      yield* Effect.provide(
        Effect.gen(function* () {
          yield* initRepoWithCommit(alpha, "alpha.txt");
          yield* initRepoWithCommit(beta, "beta.txt");
          yield* fileSystem.writeFileString(NodePath.join(alpha, "alpha.txt"), "changed\n");
          yield* fileSystem.writeFileString(NodePath.join(beta, "beta.txt"), "changed\n");

          const review = yield* ReviewService.ReviewService;
          const preview = yield* review.getDiffPreview({ cwd: workspace });

          const workingTree = preview.sources.find((source) => source.kind === "working-tree");
          expect(workingTree).toBeDefined();
          // Both repositories contribute, each under its own directory, so the
          // patch reads against paths the user recognises in the workspace.
          expect(workingTree?.diff).toContain("a/alpha/alpha.txt");
          expect(workingTree?.diff).toContain("b/beta/beta.txt");
          expect(preview.repositories.map((repository) => repository.relativePath)).toEqual([
            "alpha",
            "beta",
          ]);
        }),
        makeTestLayer(workspace),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("scopes a preview to one repository without prefixing paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* makeWorkspaceDir();
      const alpha = NodePath.join(workspace, "alpha");
      const beta = NodePath.join(workspace, "beta");
      yield* fileSystem.makeDirectory(alpha, { recursive: true });
      yield* fileSystem.makeDirectory(beta, { recursive: true });

      yield* Effect.provide(
        Effect.gen(function* () {
          yield* initRepoWithCommit(alpha, "alpha.txt");
          yield* initRepoWithCommit(beta, "beta.txt");
          yield* fileSystem.writeFileString(NodePath.join(alpha, "alpha.txt"), "changed\n");
          yield* fileSystem.writeFileString(NodePath.join(beta, "beta.txt"), "changed\n");

          const review = yield* ReviewService.ReviewService;
          const preview = yield* review.getDiffPreview({
            cwd: workspace,
            repositoryRoot: beta,
          });

          const workingTree = preview.sources.find((source) => source.kind === "working-tree");
          expect(workingTree?.diff).toContain("a/beta.txt");
          expect(workingTree?.diff).not.toContain("alpha");
          expect(preview.repositories).toHaveLength(1);
          expect(preview.repositories[0]?.relativePath).toEqual("");
        }),
        makeTestLayer(workspace),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reviews a lone repository inside a workspace that is not a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* makeWorkspaceDir();
      const app = NodePath.join(workspace, "app");
      yield* fileSystem.makeDirectory(app, { recursive: true });

      yield* Effect.provide(
        Effect.gen(function* () {
          yield* initRepoWithCommit(app, "app.txt");
          yield* fileSystem.writeFileString(NodePath.join(app, "app.txt"), "changed\n");

          const review = yield* ReviewService.ReviewService;
          const preview = yield* review.getDiffPreview({ cwd: workspace });

          const workingTree = preview.sources.find((source) => source.kind === "working-tree");
          expect(workingTree?.diff).toContain("a/app/app.txt");
          expect(preview.repositories[0]?.root).toEqual(app);
        }),
        makeTestLayer(workspace),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("ReviewService superproject workspaces", () => {
  it.effect("surfaces work a superproject's own status cannot see", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const base = yield* makeWorkspaceDir();
      const submoduleOrigin = NodePath.join(base, "origin-lib");
      const workspace = NodePath.join(base, "workspace");
      const standalone = NodePath.join(workspace, "apps", "standalone");
      yield* fileSystem.makeDirectory(submoduleOrigin, { recursive: true });
      yield* fileSystem.makeDirectory(workspace, { recursive: true });

      yield* Effect.provide(
        Effect.gen(function* () {
          yield* initRepoWithCommit(submoduleOrigin, "lib.ts");
          yield* initRepoWithCommit(workspace, "README.md");
          yield* git(workspace, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            submoduleOrigin,
            "vendored",
          ]);
          yield* git(workspace, ["commit", "-m", "add submodule"]);
          // `ignore = dirty` is what a real superproject uses to keep submodule
          // noise out of its own status. It must not hide the work itself.
          yield* git(workspace, [
            "config",
            "-f",
            ".gitmodules",
            "submodule.vendored.ignore",
            "dirty",
          ]);
          yield* git(workspace, ["add", ".gitmodules"]);
          yield* git(workspace, ["commit", "-m", "ignore dirty"]);

          // An independent clone the superproject has no record of at all.
          yield* fileSystem.makeDirectory(standalone, { recursive: true });
          yield* initRepoWithCommit(standalone, "main.js");

          yield* fileSystem.writeFileString(NodePath.join(workspace, "README.md"), "root edit\n");
          yield* fileSystem.writeFileString(
            NodePath.join(workspace, "vendored", "lib.ts"),
            "submodule edit\n",
          );
          yield* fileSystem.writeFileString(
            NodePath.join(standalone, "main.js"),
            "standalone edit\n",
          );

          const review = yield* ReviewService.ReviewService;
          const preview = yield* review.getDiffPreview({ cwd: workspace });
          const workingTree = preview.sources.find((source) => source.kind === "working-tree");

          expect(workingTree?.diff).toContain("b/README.md");
          expect(workingTree?.diff).toContain("submodule edit");
          expect(workingTree?.diff).toContain("b/vendored/lib.ts");
          expect(workingTree?.diff).toContain("standalone edit");
          expect(workingTree?.diff).toContain("b/apps/standalone/main.js");
          expect(
            preview.repositories.map((repository) => repository.relativePath).toSorted(),
          ).toEqual(["", "apps/standalone", "vendored"]);
        }),
        makeTestLayer(workspace),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("ReviewService path coordinates", () => {
  it.effect("reports tracked and untracked paths in the same coordinates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* makeWorkspaceDir();
      const nested = NodePath.join(workspace, "packages", "app");
      yield* fileSystem.makeDirectory(nested, { recursive: true });

      yield* Effect.provide(
        Effect.gen(function* () {
          yield* initRepoWithCommit(workspace, "tracked.txt");
          yield* fileSystem.writeFileString(NodePath.join(nested, "kept.txt"), "kept\n");
          yield* git(workspace, ["add", "."]);
          yield* git(workspace, ["commit", "-m", "add nested file"]);

          yield* fileSystem.writeFileString(NodePath.join(nested, "kept.txt"), "edited\n");
          yield* fileSystem.writeFileString(NodePath.join(nested, "fresh.txt"), "new\n");

          const review = yield* ReviewService.ReviewService;
          // Requesting from a subdirectory: `git diff` reports paths from the
          // repository root while `git ls-files --others` reports them from the
          // working directory, so an untracked file used to lose its leading
          // directories and point at a path that does not exist.
          const preview = yield* review.getDiffPreview({ cwd: nested });
          const workingTree = preview.sources.find((source) => source.kind === "working-tree");

          expect(workingTree?.diff).toContain("b/packages/app/kept.txt");
          expect(workingTree?.diff).toContain("b/packages/app/fresh.txt");
          expect(workingTree?.diff).not.toContain("b/fresh.txt\n");
        }),
        makeTestLayer(workspace),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
