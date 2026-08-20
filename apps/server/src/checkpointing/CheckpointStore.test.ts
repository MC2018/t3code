// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsWorkspaceRepositories from "../vcs/VcsWorkspaceRepositories.ts";
import * as ServerConfig from "../config.ts";

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const VcsWorkspaceRepositoriesTestLayer = VcsWorkspaceRepositories.layer.pipe(
  Layer.provide(VcsDriverTestLayer),
  Layer.provide(NodeServices.layer),
);
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(VcsWorkspaceRepositoriesTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
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
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStore.layer", (it) => {
  describe("isGitRepository", () => {
    it.effect("returns false when no Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("returns true when a Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );
  });
});

it.layer(TestLayer)("CheckpointStore.layer multi-repository workspaces", (it) => {
  it.effect("captures and diffs work inside a nested repository", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTmpDir("checkpoint-store-workspace-");
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = NodePath.join(workspace, "nested");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* initRepoWithCommit(workspace);
      yield* initRepoWithCommit(nested);

      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");
      const baseRef = checkpointRefForThreadTurn(threadId, 0);
      const turnRef = checkpointRefForThreadTurn(threadId, 1);

      yield* checkpointStore.captureCheckpoint({ cwd: workspace, checkpointRef: baseRef });
      // A superproject records a nested repository as a commit id, so this edit
      // is invisible to a checkpoint taken only at the workspace root.
      yield* writeTextFile(NodePath.join(nested, "README.md"), "# nested edit\n");
      yield* checkpointStore.captureCheckpoint({ cwd: workspace, checkpointRef: turnRef });

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: workspace,
        fromCheckpointRef: baseRef,
        toCheckpointRef: turnRef,
        ignoreWhitespace: false,
      });

      expect(diff).toContain("a/nested/README.md");
      expect(diff).toContain("# nested edit");
    }),
  );

  it.effect("restores a nested repository along with the workspace root", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTmpDir("checkpoint-store-workspace-");
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = NodePath.join(workspace, "nested");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* initRepoWithCommit(workspace);
      yield* initRepoWithCommit(nested);

      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      const threadId = ThreadId.make("22222222-2222-4222-8222-222222222222");
      const checkpointRef = checkpointRefForThreadTurn(threadId, 1);
      yield* checkpointStore.captureCheckpoint({ cwd: workspace, checkpointRef });

      yield* writeTextFile(NodePath.join(nested, "README.md"), "# drifted\n");
      const restored = yield* checkpointStore.restoreCheckpoint({ cwd: workspace, checkpointRef });

      expect(restored).toBe(true);
      const contents = yield* fileSystem.readFileString(NodePath.join(nested, "README.md"));
      expect(contents).toBe("# test\n");
    }),
  );

  it.effect("reports a workspace holding only nested repositories as checkpointable", () =>
    Effect.gen(function* () {
      const workspace = yield* makeTmpDir("checkpoint-store-workspace-");
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = NodePath.join(workspace, "app");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* initRepoWithCommit(nested);

      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      expect(yield* checkpointStore.isGitRepository(workspace)).toBe(true);
    }),
  );
});
