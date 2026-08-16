import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import type { BrowserImportPathContext } from "./Sources.ts";
import {
  BROWSER_IMPORT_SOURCES,
  cookieDatabasePath,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  sourcePathContext,
} from "./Sources.ts";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

/** A scratch home with the source's user-data directory already created. */
const withSourceHome = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-sources-" });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcessEnvironment, { HOME: home }),
    Effect.provideService(HostProcessPlatform, "darwin"),
  );
  yield* fileSystem.makeDirectory(userDataDirectory(context), { recursive: true });
  return context;
});

/** Every case here runs on darwin, where Helium always resolves a directory. */
const userDataDirectory = (context: BrowserImportPathContext) => {
  const root = helium.userDataDirectory(context);
  if (root === undefined) throw new Error("Helium has no macOS user-data directory");
  return root;
};

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("isSourceRunning", () => {
  it.effect("reads Chromium's dangling SingletonLock symlink as a running browser", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        assert.isFalse(yield* isSourceRunning(helium, context));

        // Chromium points the lock at `<host>-<pid>`, a target that never
        // exists on disk. A check that follows the link reports a running
        // browser as closed, letting an import read a live, mid-write database.
        yield* fileSystem.symlink(
          "host-that-does-not-exist-1234",
          `${userDataDirectory(context)}/SingletonLock`,
        );

        assert.isTrue(yield* isSourceRunning(helium, context));
      }),
    ),
  );
});

describe("isSourceInstalled", () => {
  it.effect("follows the presence of the user-data directory", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        assert.isTrue(yield* isSourceInstalled(helium, context));

        yield* fileSystem.remove(userDataDirectory(context), { recursive: true });
        assert.isFalse(yield* isSourceInstalled(helium, context));
      }),
    ),
  );
});

describe("listSourceProfiles", () => {
  it.effect("falls back to Default when Local State is absent", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withSourceHome();
        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );

  it.effect("reads the profile names the browser shows", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        yield* fileSystem.writeFileString(
          `${userDataDirectory(context)}/Local State`,
          `{"profile":{"info_cache":{"Default":{"name":"You"},"Profile 2":{"name":"  "}}}}`,
        );

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "You" },
          // Blank display name falls back to the directory rather than
          // rendering an empty row.
          { directory: "Profile 2", name: "Profile 2" },
        ]);
      }),
    ),
  );

  it.effect("falls back to Default when Local State is malformed", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        yield* fileSystem.writeFileString(`${userDataDirectory(context)}/Local State`, "{not-json");

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );
});

describe("cookieDatabasePath", () => {
  it.effect("places the database under the requested source profile", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withSourceHome();
        assert.equal(
          cookieDatabasePath(helium, context, "Profile 1"),
          `${context.home}/Library/Application Support/net.imput.helium/Profile 1/Cookies`,
        );
      }),
    ),
  );
});

const firefox = BROWSER_IMPORT_SOURCES.find((source) => source.id === "firefox")!;
const opera = BROWSER_IMPORT_SOURCES.find((source) => source.id === "opera")!;

describe("isSourceRunning for Firefox", () => {
  it.effect("finds the lock inside the profile, not at the root", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-" });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: home }),
          Effect.provideService(HostProcessPlatform, "darwin"),
        );
        const root = firefox.userDataDirectory(context)!;
        const profile = `${root}/Profiles/abcd.default-release`;
        yield* fileSystem.makeDirectory(profile, { recursive: true });

        assert.isFalse(yield* isSourceRunning(firefox, context));

        // Firefox keeps its locks per profile. A root-level lock is not one,
        // and looking there was why a running Firefox read as importable.
        yield* fileSystem.writeFileString(`${root}/lock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));

        yield* fileSystem.writeFileString(`${profile}/.parentlock`, "");
        assert.isTrue(yield* isSourceRunning(firefox, context));
      }),
    ),
  );
});

describe("Windows user-data directories", () => {
  it.effect("puts Opera under roaming AppData without a User Data level", () =>
    run(
      Effect.gen(function* () {
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, {
            USERPROFILE: "C:\\Users\\u",
            APPDATA: "C:\\Users\\u\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
          }),
          Effect.provideService(HostProcessPlatform, "win32"),
        );

        // Opera does not follow the local-AppData `User Data` convention its
        // Chromium relatives use, so deriving it that way never found it.
        assert.include(opera.userDataDirectory(context) ?? "", "Roaming");
        assert.include(opera.userDataDirectory(context) ?? "", "Opera Stable");
        assert.notInclude(opera.userDataDirectory(context) ?? "", "User Data");

        const chrome = BROWSER_IMPORT_SOURCES.find((source) => source.id === "chrome")!;
        assert.include(chrome.userDataDirectory(context) ?? "", "Local");
        assert.include(chrome.userDataDirectory(context) ?? "", "User Data");
      }),
    ),
  );
});
