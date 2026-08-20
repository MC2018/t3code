import { describe, expect, it } from "vite-plus/test";
import type { VcsWorkspaceRepository } from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/types";

import { computeRepositoryDiffStats, formatRepositoryDiffStat } from "./diffPanelRepositoryStats";

function repository(relativePath: string, name: string): VcsWorkspaceRepository {
  return {
    root: `/w/${relativePath === "" ? "root" : relativePath}`,
    relativePath,
    name,
    kind: "git",
    linkage: relativePath === "" ? "root" : "nested",
    isPrimary: relativePath === "",
  };
}

function fileDiff(name: string, additions: number, deletions: number): FileDiffMetadata {
  return {
    name,
    hunks: [{ additionLines: additions, deletionLines: deletions }],
  } as unknown as FileDiffMetadata;
}

const ROOT = repository("", "workspace");
const API = repository("api", "api");
const WEB = repository("web", "web");

describe("computeRepositoryDiffStats", () => {
  it("counts files and lines per repository", () => {
    const stats = computeRepositoryDiffStats(
      [
        fileDiff("api/src/a.ts", 10, 2),
        fileDiff("api/src/b.ts", 5, 1),
        fileDiff("web/x.tsx", 3, 9),
      ],
      [ROOT, API, WEB],
    );

    expect(stats.get(API.root)).toEqual({ filesChanged: 2, additions: 15, deletions: 3 });
    expect(stats.get(WEB.root)).toEqual({ filesChanged: 1, additions: 3, deletions: 9 });
  });

  it("gives a nested repository its files instead of the workspace root", () => {
    const stats = computeRepositoryDiffStats([fileDiff("api/src/a.ts", 1, 1)], [ROOT, API]);

    expect(stats.get(API.root)?.filesChanged).toBe(1);
    expect(stats.has(ROOT.root)).toBe(false);
  });

  it("attributes unprefixed files to the workspace root", () => {
    const stats = computeRepositoryDiffStats([fileDiff("README.md", 4, 0)], [ROOT, API]);

    expect(stats.get(ROOT.root)).toEqual({ filesChanged: 1, additions: 4, deletions: 0 });
  });

  it("omits repositories absent from the patch rather than reporting zero", () => {
    // A panel scoped to one repository loads only that repository's patch, and
    // a zero would read as "no changes" instead of "not measured here".
    const stats = computeRepositoryDiffStats([fileDiff("api/src/a.ts", 1, 0)], [ROOT, API, WEB]);

    expect(stats.has(WEB.root)).toBe(false);
  });

  it("ignores files belonging to no known repository", () => {
    const stats = computeRepositoryDiffStats([fileDiff("api/src/a.ts", 1, 0)], [API, WEB]);

    expect(stats.size).toBe(1);
    expect(stats.get(API.root)?.filesChanged).toBe(1);
  });

  it("does not treat a sibling with a shared prefix as nested", () => {
    const apiDocs = repository("api-docs", "api-docs");
    const stats = computeRepositoryDiffStats(
      [fileDiff("api-docs/readme.md", 2, 0)],
      [API, apiDocs],
    );

    expect(stats.get(apiDocs.root)?.filesChanged).toBe(1);
    expect(stats.has(API.root)).toBe(false);
  });
});

describe("formatRepositoryDiffStat", () => {
  it("formats counts with a singular file label", () => {
    expect(formatRepositoryDiffStat({ filesChanged: 1, additions: 3, deletions: 0 })).toBe(
      "1 file · +3 −0",
    );
  });

  it("formats counts with a plural file label", () => {
    expect(formatRepositoryDiffStat({ filesChanged: 12, additions: 340, deletions: 87 })).toBe(
      "12 files · +340 −87",
    );
  });
});
