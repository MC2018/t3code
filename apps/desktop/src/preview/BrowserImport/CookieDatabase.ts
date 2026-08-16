/**
 * Shared pieces of cookie extraction: the shape both engines produce, and the
 * snapshot every reader takes before touching a live database.
 *
 * @module CookieDatabase
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** A cookie in the shape Electron's `session.cookies.set` accepts. */
export interface ImportedCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Seconds since the UNIX epoch, or undefined for a session cookie. */
  readonly expirationDate: number | undefined;
  readonly sameSite: "no_restriction" | "lax" | "strict";
}

/**
 * Copies a cookie database, and its write-ahead sidecars, to a temporary
 * directory before reading, and returns the copy's path.
 *
 * Both engines keep the file open with WAL while the browser runs, so reading
 * in place can observe a torn write. Copying also guarantees we never open the
 * browser's own file for writing.
 *
 * Scoped: the temporary directory goes away when the caller's scope closes.
 */
export const snapshotCookieDatabase = Effect.fn("CookieDatabase.snapshotCookieDatabase")(function* (
  cookiePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-cookie-import-",
  });
  const target = path.join(directory, path.basename(cookiePath));
  yield* fileSystem.copyFile(cookiePath, target);
  // A sidecar only exists while the browser holds the database open, so an
  // absent one is normal. Anything else — a permission error, a partial read
  // — is not: SQLite would then open the snapshot without the write-ahead
  // log and quietly return a cookie set missing its newest transactions.
  yield* Effect.forEach(["-wal", "-shm"], (suffix) =>
    fileSystem.copyFile(`${cookiePath}${suffix}`, `${target}${suffix}`).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    ),
  );
  return target;
});
