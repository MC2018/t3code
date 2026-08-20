import type { FileDiffContentsLoader } from "@pierre/diffs";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestRef,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewRepository,
  ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";
import { findRepositoryForDiffPath, toRepositoryRelativeDiffPath } from "@t3tools/shared/git";

import { resolveFileDiffPath } from "./diffRendering";

interface GitDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** The comparison identity Pierre carries into its hydrated render cache. */
  readonly cacheKey: string;
  /**
   * Repositories the preview was stitched from. With more than one, a file's
   * contents have to be read from the repository that owns it rather than from
   * the workspace root.
   */
  readonly repositories?: ReadonlyArray<ReviewDiffPreviewRepository>;
}

interface PullRequestDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly commit: string | null;
  readonly cacheKey: string;
}

type GetDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

type GetPullRequestDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestDiffFileContentsInput;
}) => Promise<AtomCommandResult<PullRequestDiffFileContentsResult, E>>;

function createDiffFileContentsLoader(
  load: (input: {
    readonly changeType: PullRequestDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
  }) => Promise<{ readonly oldContents: string; readonly newContents: string }>,
  cacheKey: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const contents = await load({ changeType: fileDiff.type, oldPath, newPath });
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") {
      return { oldFile: null, newFile };
    }
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}

/** Turns the host's Git file-content RPC into the full-file loader Pierre uses for hunk expansion. */
export function createGitDiffFileContentsLoader<E>(
  getDiffFileContents: GetDiffFileContents<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    // Git has to run inside the repository that owns the file: the workspace
    // root may hold several repositories, or may not be a repository at all.
    const repository = findRepositoryForDiffPath(source.repositories ?? [], newPath);
    const target = repository
      ? {
          cwd: repository.root,
          // Working-tree expansion compares against that repository's HEAD, so
          // only a branch comparison wants the repository's own refs.
          baseRef: source.sourceKind === "branch-range" ? repository.baseRef : source.baseRef,
          headRef: source.sourceKind === "branch-range" ? repository.headRef : source.headRef,
          oldPath: toRepositoryRelativeDiffPath(repository, oldPath),
          newPath: toRepositoryRelativeDiffPath(repository, newPath),
        }
      : {
          cwd: source.cwd,
          baseRef: source.baseRef,
          headRef: source.headRef,
          oldPath,
          newPath,
        };
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: target.cwd,
        sourceKind: source.sourceKind,
        changeType,
        baseRef: target.baseRef,
        headRef: target.headRef,
        oldPath: target.oldPath,
        newPath: target.newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}

/** Loads host-backed PR files, which may name revisions this checkout has never fetched. */
export function createPullRequestDiffFileContentsLoader<E>(
  getDiffFileContents: GetPullRequestDiffFileContents<E>,
  source: PullRequestDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        ...source.reference,
        ...(source.commit === null ? {} : { commit: source.commit }),
        changeType,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}
