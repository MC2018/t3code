import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, type ReviewDiffFileContentsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createGitDiffFileContentsLoader } from "./diffFileContents";

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "a/src/old-name.ts",
    name: "b/src/new-name.ts",
  } as FileDiffMetadata;
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads both sides with normalized paths and comparison-scoped cache keys", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).resolves.toEqual({
      oldFile: {
        name: "src/old-name.ts",
        contents: "before\n",
        cacheKey: "comparison-1:old:src/old-name.ts",
      },
      newFile: {
        name: "src/new-name.ts",
        contents: "after\n",
        cacheKey: "comparison-1:new:src/new-name.ts",
      },
    });
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace",
        sourceKind: "branch-range",
        changeType: "rename-changed",
        baseRef: "main",
        headRef: "feature",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });

  it("loads a pure rename from its one shared file", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "same\n", newContents: "same\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents: "same\n" },
    });
  });

  it("passes command failures through to Pierre's expansion handling", async () => {
    const failure = new Error("revision is not available locally");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});

describe("createGitDiffFileContentsLoader across repositories", () => {
  const REPOSITORIES = [
    {
      root: "/workspace",
      relativePath: "",
      name: "workspace",
      baseRef: "main",
      headRef: "feature",
    },
    {
      root: "/workspace/ShuffullApp",
      relativePath: "ShuffullApp",
      name: "ShuffullApp",
      baseRef: "develop",
      headRef: "expo-router",
    },
  ];

  it("reads a nested repository's file from that repository with its own refs", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, {
      ...SOURCE,
      repositories: REPOSITORIES,
    });

    await load({
      type: "change",
      name: "b/ShuffullApp/app/index.tsx",
    } as FileDiffMetadata);

    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace/ShuffullApp",
        sourceKind: "branch-range",
        changeType: "change",
        baseRef: "develop",
        headRef: "expo-router",
        oldPath: "app/index.tsx",
        newPath: "app/index.tsx",
      },
    });
  });

  it("keeps working-tree expansion comparing against the repository's HEAD", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, {
      ...SOURCE,
      sourceKind: "working-tree",
      baseRef: "HEAD",
      headRef: null,
      repositories: REPOSITORIES,
    });

    await load({
      type: "change",
      name: "b/ShuffullApp/app/index.tsx",
    } as FileDiffMetadata);

    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace/ShuffullApp",
        sourceKind: "working-tree",
        changeType: "change",
        baseRef: "HEAD",
        headRef: null,
        oldPath: "app/index.tsx",
        newPath: "app/index.tsx",
      },
    });
  });

  it("routes a workspace-root file to the root repository", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, {
      ...SOURCE,
      repositories: REPOSITORIES,
    });

    await load({ type: "change", name: "b/README.md" } as FileDiffMetadata);

    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace",
        sourceKind: "branch-range",
        changeType: "change",
        baseRef: "main",
        headRef: "feature",
        oldPath: "README.md",
        newPath: "README.md",
      },
    });
  });
});
