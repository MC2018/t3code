/**
 * Per-repository change counts for the diff panel's repository picker.
 *
 * Derived from the patch the panel has already parsed rather than asked of the
 * server, which keeps the numbers consistent with what selecting that
 * repository actually shows: same scope, same base ref, same truncation, and no
 * extra git work or websocket payload.
 */
import type { VcsWorkspaceRepository } from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/types";

import { getDiffLineStat, resolveFileDiffPath } from "../lib/diffRendering";

export interface RepositoryDiffStat {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Combined diffs report each file under its repository's workspace-relative
 * prefix, so the longest matching prefix wins: a nested repository claims its
 * own files before the workspace root can.
 */
function findOwningRepository(
  filePath: string,
  repositories: ReadonlyArray<VcsWorkspaceRepository>,
): VcsWorkspaceRepository | undefined {
  let owner: VcsWorkspaceRepository | undefined;
  for (const repository of repositories) {
    const prefix = repository.relativePath;
    const matches = prefix === "" || filePath === prefix || filePath.startsWith(`${prefix}/`);
    if (!matches) continue;
    if (owner === undefined || prefix.length > owner.relativePath.length) {
      owner = repository;
    }
  }
  return owner;
}

/**
 * Counts changes per repository root. Repositories with no files in the loaded
 * patch are absent rather than zeroed, so callers can tell "no changes" apart
 * from "not covered by this patch" — the latter happens whenever the panel is
 * scoped to a single repository.
 */
export function computeRepositoryDiffStats(
  files: ReadonlyArray<FileDiffMetadata>,
  repositories: ReadonlyArray<VcsWorkspaceRepository>,
): ReadonlyMap<string, RepositoryDiffStat> {
  const filesByRoot = new Map<string, FileDiffMetadata[]>();
  for (const file of files) {
    const owner = findOwningRepository(resolveFileDiffPath(file), repositories);
    if (owner === undefined) continue;
    const bucket = filesByRoot.get(owner.root);
    if (bucket === undefined) filesByRoot.set(owner.root, [file]);
    else bucket.push(file);
  }

  const stats = new Map<string, RepositoryDiffStat>();
  for (const [root, ownedFiles] of filesByRoot) {
    const lineStat = getDiffLineStat(ownedFiles);
    stats.set(root, {
      filesChanged: ownedFiles.length,
      additions: lineStat.additions,
      deletions: lineStat.deletions,
    });
  }
  return stats;
}

/** Renders as `12 files · +340 −87`, using a true minus sign to match the diff gutter. */
export function formatRepositoryDiffStat(stat: RepositoryDiffStat): string {
  const files = `${stat.filesChanged} ${stat.filesChanged === 1 ? "file" : "files"}`;
  return `${files} · +${stat.additions} −${stat.deletions}`;
}
