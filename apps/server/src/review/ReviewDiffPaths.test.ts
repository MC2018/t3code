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
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ReviewService from "./ReviewService.ts";

function makeTestLayer(workspaceRoot: string) {
  const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
  const registryLayer = VcsDriverRegistry.layer.pipe(Layer.provide(vcsProcessLayer));
  const gitDriverLayer = GitVcsDriver.layer.pipe(
    Layer.provide(vcsProcessLayer),
    Layer.provide(ServerConfig.layerTest(workspaceRoot, workspaceRoot)),
    Layer.provide(NodeServices.layer),
  );
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
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
    Layer.provideMerge(projectionLayer),
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
      operation: "ReviewDiffPaths.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 20_000,
    });
    return result.stdout.trim();
  });
}

function makeWorkspaceDir(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-review-paths-" });
    return yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
  });
}

describe("ReviewService diff path coordinates", () => {
  it.effect("reports tracked and untracked paths in the same coordinates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* makeWorkspaceDir();
      const nested = NodePath.join(workspace, "packages", "app");
      yield* fileSystem.makeDirectory(nested, { recursive: true });

      yield* Effect.provide(
        Effect.gen(function* () {
          yield* git(workspace, ["init"]);
          yield* git(workspace, ["config", "user.email", "test@test.com"]);
          yield* git(workspace, ["config", "user.name", "Test"]);
          yield* fileSystem.writeFileString(NodePath.join(nested, "kept.txt"), "kept\n");
          yield* git(workspace, ["add", "."]);
          yield* git(workspace, ["commit", "-m", "initial commit"]);

          yield* fileSystem.writeFileString(NodePath.join(nested, "kept.txt"), "edited\n");
          yield* fileSystem.writeFileString(NodePath.join(nested, "fresh.txt"), "new\n");

          const review = yield* ReviewService.ReviewService;
          // Requested from a subdirectory: `git diff` reports repository-root
          // relative paths while `git ls-files --others` reports them relative
          // to the working directory, so the untracked file used to lose its
          // leading directories and name a path that does not exist.
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
