/**
 * Per-repository change counts for the diff panel's repository picker.
 *
 * Counted straight from the unified patch text rather than from the parsed,
 * highlighted render model: the picker only needs totals, and parsing a patch
 * for display is far more expensive than scanning it for `+`/`-` lines.
 */
import type { VcsWorkspaceRepository } from "@t3tools/contracts";

export interface RepositoryDiffStat {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

const DIFF_HEADER = "diff --git ";

/**
 * Pulls the new-side path out of `diff --git a/x b/x`. Git quotes paths
 * containing spaces, in which case the unquoted halves cannot be split
 * reliably; those files still count, they just fall back to the workspace root.
 */
function readHeaderPath(line: string): string | null {
  const rest = line.slice(DIFF_HEADER.length);
  const bIndex = rest.lastIndexOf(" b/");
  if (bIndex === -1) return null;
  return rest.slice(bIndex + 3);
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
 * Counts changes per repository root. Repositories with no files in the patch
 * are absent rather than zeroed, so callers can tell "no changes" apart from
 * "not covered by this patch".
 */
export function computeRepositoryDiffStats(
  patch: string,
  repositories: ReadonlyArray<VcsWorkspaceRepository>,
): ReadonlyMap<string, RepositoryDiffStat> {
  const totals = new Map<string, { filesChanged: number; additions: number; deletions: number }>();
  let current: string | null = null;

  const totalsFor = (root: string) => {
    const existing = totals.get(root);
    if (existing !== undefined) return existing;
    const created = { filesChanged: 0, additions: 0, deletions: 0 };
    totals.set(root, created);
    return created;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith(DIFF_HEADER)) {
      const path = readHeaderPath(line);
      current = path === null ? null : (findOwningRepository(path, repositories)?.root ?? null);
      if (current !== null) totalsFor(current).filesChanged += 1;
      continue;
    }
    if (current === null) continue;
    // `+++`/`---` are file headers, not content, and `--` ends the patch body.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) totalsFor(current).additions += 1;
    else if (line.startsWith("-")) totalsFor(current).deletions += 1;
  }

  return totals;
}

/** Renders as `12 files · +340 −87`, using a true minus sign to match the diff gutter. */
export function formatRepositoryDiffStat(stat: RepositoryDiffStat): string {
  const files = `${stat.filesChanged} ${stat.filesChanged === 1 ? "file" : "files"}`;
  return `${files} · +${stat.additions} −${stat.deletions}`;
}
