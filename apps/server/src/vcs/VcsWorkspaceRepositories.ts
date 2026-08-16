// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type {
  VcsError,
  VcsListWorkspaceRepositoriesInput,
  VcsListWorkspaceRepositoriesResult,
  VcsWorkspaceRepository,
} from "@t3tools/contracts";

import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const DISCOVERY_CACHE_CAPACITY = 256;
const DISCOVERY_CACHE_TTL = Duration.seconds(15);

/**
 * Bounds for the filesystem sweep that finds clones the root repository does
 * not know about. Registered submodules come from git itself and are not
 * subject to these limits.
 */
const MAX_NESTED_SCAN_DEPTH = 4;
export const MAX_WORKSPACE_REPOSITORIES = 32;

/**
 * Directory names never worth descending into while looking for repositories.
 * Dot-directories are skipped wholesale on top of this list.
 */
const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "tmp",
  "temp",
  "Pods",
  "DerivedData",
  "venv",
  "env",
  "__pycache__",
]);

class WorkspaceScanDirectoryError extends Data.TaggedError("WorkspaceScanDirectoryError")<{
  readonly dir: string;
  readonly cause: unknown;
}> {}

export class VcsWorkspaceRepositories extends Context.Service<
  VcsWorkspaceRepositories,
  {
    readonly list: (
      input: VcsListWorkspaceRepositoriesInput,
    ) => Effect.Effect<VcsListWorkspaceRepositoriesResult, VcsError>;
    readonly invalidate: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/vcs/VcsWorkspaceRepositories") {}

/**
 * Parses `git submodule status --recursive`. Each line is a status flag, an
 * object id, the superproject-relative path, and an optional `(describe)`
 * suffix. A `-` flag means the submodule has no working tree, so there is
 * nothing to diff and we drop it.
 */
export function parseSubmoduleStatus(stdout: string): ReadonlyArray<string> {
  const paths: Array<string> = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;

    const flag = line[0];
    if (flag === "-") continue;

    const afterFlag = flag === " " || flag === "+" || flag === "U" ? line.slice(1) : line;
    const separatorIndex = afterFlag.indexOf(" ");
    if (separatorIndex === -1) continue;

    let path = afterFlag.slice(separatorIndex + 1).trim();
    if (path.endsWith(")")) {
      const describeIndex = path.lastIndexOf(" (");
      if (describeIndex > 0) {
        path = path.slice(0, describeIndex).trim();
      }
    }
    if (path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const canonicalize = (value: string) =>
    fileSystem.realPath(path.resolve(value)).pipe(Effect.orElseSucceed(() => path.resolve(value)));

  const relativeToAnchor = (anchor: string, repositoryRoot: string) =>
    path.relative(anchor, repositoryRoot).split(path.sep).join("/");

  const hasGitMetadata = (candidate: string) =>
    fileSystem.exists(path.join(candidate, ".git")).pipe(Effect.orElseSucceed(() => false));

  /**
   * Breadth-first sweep for clones the root repository has no record of. Never
   * descends into a directory that is already a repository: a repository's own
   * submodules are enumerated by git, and its ignored build output is exactly
   * what we do not want to walk.
   */
  const scanNestedRepositories = Effect.fn("VcsWorkspaceRepositories.scanNestedRepositories")(
    function* (workspaceRoot: string, known: ReadonlySet<string>, remainingCapacity: number) {
      const found: Array<string> = [];
      let queue: ReadonlyArray<{ readonly dir: string; readonly depth: number }> = [
        { dir: workspaceRoot, depth: 0 },
      ];
      let truncated = false;

      while (queue.length > 0) {
        const nextQueue: Array<{ readonly dir: string; readonly depth: number }> = [];
        for (const { dir, depth } of queue) {
          if (depth >= MAX_NESTED_SCAN_DEPTH) continue;

          // An unreadable directory is normal here (permissions, a race with
          // the agent) and only means there is nothing to discover below it.
          const entries = yield* Effect.tryPromise({
            try: () => NodeFSP.readdir(dir, { withFileTypes: true }),
            catch: (cause) => new WorkspaceScanDirectoryError({ dir, cause }),
          }).pipe(Effect.orElseSucceed(() => []));

          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".")) continue;
            if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;

            const childPath = path.join(dir, entry.name);
            const isRepository = yield* hasGitMetadata(childPath);
            if (isRepository) {
              if (!known.has(childPath)) {
                if (found.length >= remainingCapacity) {
                  truncated = true;
                  continue;
                }
                found.push(childPath);
              }
              continue;
            }
            nextQueue.push({ dir: childPath, depth: depth + 1 });
          }
        }
        queue = nextQueue;
      }

      return { found, truncated };
    },
  );

  const discover = Effect.fn("VcsWorkspaceRepositories.discover")(function* (
    workspaceRoot: string,
  ) {
    const rootHandle = yield* registry
      .detect({ cwd: workspaceRoot, requestedKind: "auto" })
      .pipe(Effect.orElseSucceed(() => null));

    // Diff paths from the root repository are repository-relative, so nested
    // repositories have to be described relative to that same anchor for the
    // combined patch to line up.
    const anchor = rootHandle ? yield* canonicalize(rootHandle.repository.rootPath) : workspaceRoot;

    const repositories: Array<VcsWorkspaceRepository> = [];
    const known = new Set<string>();

    if (rootHandle) {
      repositories.push({
        root: anchor,
        relativePath: "",
        name: path.basename(anchor),
        kind: rootHandle.kind,
        linkage: "root",
        isPrimary: true,
      });
      known.add(anchor);
    }

    let truncated = false;

    if (rootHandle?.kind === "git") {
      const submoduleResult = yield* rootHandle.driver
        .execute({
          operation: "VcsWorkspaceRepositories.submoduleStatus",
          cwd: anchor,
          args: ["submodule", "status", "--recursive"],
          allowNonZeroExit: true,
        })
        .pipe(Effect.orElseSucceed(() => null));

      if (submoduleResult && submoduleResult.exitCode === 0) {
        for (const relativePath of parseSubmoduleStatus(submoduleResult.stdout)) {
          if (repositories.length >= MAX_WORKSPACE_REPOSITORIES) {
            truncated = true;
            break;
          }
          const root = path.resolve(anchor, relativePath);
          if (known.has(root)) continue;
          known.add(root);
          repositories.push({
            root,
            relativePath,
            name: relativePath,
            kind: "git",
            linkage: "submodule",
            isPrimary: false,
          });
        }
      }
    }

    const nested = yield* scanNestedRepositories(
      workspaceRoot,
      known,
      Math.max(0, MAX_WORKSPACE_REPOSITORIES - repositories.length),
    );
    truncated = truncated || nested.truncated;

    for (const root of nested.found) {
      if (known.has(root)) continue;
      known.add(root);
      const relativePath = relativeToAnchor(anchor, root);
      repositories.push({
        root,
        relativePath,
        name: relativePath,
        kind: "git",
        linkage: "nested",
        isPrimary: repositories.length === 0,
      });
    }

    const sorted = repositories.toSorted((left, right) => {
      if (left.linkage === "root") return -1;
      if (right.linkage === "root") return 1;
      return left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true });
    });

    return { repositories: sorted, truncated } satisfies VcsListWorkspaceRepositoriesResult;
  });

  const discoveryCache = yield* Cache.makeWith<
    string,
    VcsListWorkspaceRepositoriesResult,
    VcsError
  >((workspaceRoot) => discover(workspaceRoot), {
    capacity: DISCOVERY_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: () => DISCOVERY_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  });

  const list: VcsWorkspaceRepositories["Service"]["list"] = Effect.fn(
    "VcsWorkspaceRepositories.list",
  )(function* (input) {
    const workspaceRoot = yield* canonicalize(input.cwd);
    if (input.refresh === true) {
      yield* Cache.invalidate(discoveryCache, workspaceRoot);
    }
    return yield* Cache.get(discoveryCache, workspaceRoot);
  });

  const invalidate: VcsWorkspaceRepositories["Service"]["invalidate"] = Effect.fn(
    "VcsWorkspaceRepositories.invalidate",
  )(function* (cwd) {
    const workspaceRoot = yield* canonicalize(cwd);
    yield* Cache.invalidate(discoveryCache, workspaceRoot);
  });

  return VcsWorkspaceRepositories.of({ list, invalidate });
});

export const layer = Layer.effect(VcsWorkspaceRepositories, make);
