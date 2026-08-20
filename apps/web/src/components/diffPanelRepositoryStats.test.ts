import { describe, expect, it } from "vite-plus/test";
import type { VcsWorkspaceRepository } from "@t3tools/contracts";

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

/** One file's worth of unified diff, with the requested number of +/- lines. */
function filePatch(path: string, additions: number, deletions: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    ...Array.from({ length: additions }, (_, index) => `+added ${index}`),
    ...Array.from({ length: deletions }, (_, index) => `-removed ${index}`),
    " context",
  ].join("\n");
}

const ROOT = repository("", "workspace");
const API = repository("api", "api");
const WEB = repository("web", "web");

describe("computeRepositoryDiffStats", () => {
  it("counts files and lines per repository", () => {
    const patch = [
      filePatch("api/src/a.ts", 10, 2),
      filePatch("api/src/b.ts", 5, 1),
      filePatch("web/x.tsx", 3, 9),
    ].join("\n");

    const stats = computeRepositoryDiffStats(patch, [ROOT, API, WEB]);

    expect(stats.get(API.root)).toEqual({ filesChanged: 2, additions: 15, deletions: 3 });
    expect(stats.get(WEB.root)).toEqual({ filesChanged: 1, additions: 3, deletions: 9 });
  });

  it("does not count the +++/--- file headers as changed lines", () => {
    const stats = computeRepositoryDiffStats(filePatch("api/a.ts", 1, 1), [API]);

    expect(stats.get(API.root)).toEqual({ filesChanged: 1, additions: 1, deletions: 1 });
  });

  it("gives a nested repository its files instead of the workspace root", () => {
    const stats = computeRepositoryDiffStats(filePatch("api/src/a.ts", 1, 1), [ROOT, API]);

    expect(stats.get(API.root)?.filesChanged).toBe(1);
    expect(stats.has(ROOT.root)).toBe(false);
  });

  it("attributes unprefixed files to the workspace root", () => {
    const stats = computeRepositoryDiffStats(filePatch("README.md", 4, 0), [ROOT, API]);

    expect(stats.get(ROOT.root)).toEqual({ filesChanged: 1, additions: 4, deletions: 0 });
  });

  it("omits repositories absent from the patch rather than reporting zero", () => {
    const stats = computeRepositoryDiffStats(filePatch("api/src/a.ts", 1, 0), [ROOT, API, WEB]);

    expect(stats.has(WEB.root)).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as nested", () => {
    const apiDocs = repository("api-docs", "api-docs");
    const stats = computeRepositoryDiffStats(filePatch("api-docs/readme.md", 2, 0), [API, apiDocs]);

    expect(stats.get(apiDocs.root)?.filesChanged).toBe(1);
    expect(stats.has(API.root)).toBe(false);
  });

  it("answers empty for an empty patch", () => {
    expect(computeRepositoryDiffStats("", [ROOT, API]).size).toBe(0);
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
