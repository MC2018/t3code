import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsWorkspaceRepositories from "../vcs/VcsWorkspaceRepositories.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const workspaceRepositories = yield* VcsWorkspaceRepositories.VcsWorkspaceRepositories;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  /**
   * The roots a review is allowed to read from: the server's own working
   * directory, the worktrees it manages, and every registered project. A
   * project can live anywhere on disk — the server's working directory is
   * wherever it happened to be launched from and says nothing about which
   * projects the user has added — so the project list is what makes a path
   * legitimate.
   */
  const allowedReviewRoots = Effect.fn("ReviewService.allowedReviewRoots")(function* () {
    const projectRoots = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.map((snapshot) => snapshot.projects.map((project) => project.workspaceRoot)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );
    return yield* Effect.all(
      [config.cwd, config.worktreesDir, ...projectRoots].map(canonicalizePath),
      { concurrency: "unbounded" },
    );
  });

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents",
    cwd: string,
  ) {
    const [candidate, allowedRoots] = yield* Effect.all([
      canonicalizePath(cwd),
      allowedReviewRoots(),
    ]);

    if (allowedRoots.some((root) => isWithinRoot(candidate, root))) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within a registered project or the configured workspace root."
          : "Review diff file contents cwd must stay within a registered project or the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    // A workspace can hold several repositories — a superproject with
    // submodules, or a directory of independent clones — and each one owns
    // changes the others cannot see. Discovery runs first so a workspace whose
    // own root is not a repository still reviews the repositories inside it.
    const workspace = yield* workspaceRepositories.list({ cwd: input.cwd });
    const allGitRepositories = workspace.repositories.filter(
      (repository) => repository.kind === "git",
    );

    // Scoping to one repository reports its diffs unprefixed, so the review
    // reads exactly as it would for a workspace holding only that repository.
    if (input.repositoryRoot !== undefined) {
      yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.repositoryRoot);
      const scoped = allGitRepositories.find(
        (repository) => repository.root === input.repositoryRoot,
      );
      return yield* git.getReviewDiffPreviewForRepositories(input, [
        {
          root: input.repositoryRoot,
          relativePath: "",
          name: scoped?.name ?? path.basename(input.repositoryRoot),
          isPrimary: true,
        },
      ]);
    }

    const gitRepositories = allGitRepositories;

    if (gitRepositories.length > 1) {
      return yield* git.getReviewDiffPreviewForRepositories(
        input,
        gitRepositories.map((repository) => ({
          root: repository.root,
          relativePath: repository.relativePath,
          name: repository.name,
          isPrimary: repository.isPrimary,
        })),
      );
    }

    // Discovery reports repository top-levels. Running git there rather than at
    // the request cwd keeps tracked and untracked paths in the same coordinate
    // system: `git diff` reports repository-relative paths while `git ls-files
    // --others` reports them relative to the working directory.
    const [onlyRepository] = gitRepositories;
    if (onlyRepository) {
      return yield* git.getReviewDiffPreviewForRepositories(input, [
        {
          root: onlyRepository.root,
          relativePath: onlyRepository.relativePath,
          name: onlyRepository.name,
          isPrimary: true,
        },
      ]);
    }

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
        repositories: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
