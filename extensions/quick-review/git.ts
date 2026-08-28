/** Bounded git access for one review range. Every call is argument-array based. */

import { execFile } from "node:child_process";
import { LIMITS, SAFE_PATH, SHA } from "./contract.ts";

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitOptions {
  /** Reject output larger than this many bytes. */
  maxBytes?: number;
  timeout?: number;
  /** Throw when git exits non-zero. Defaults to true. */
  check?: boolean;
  /** Kill the child when this aborts, so a closing review stops its work. */
  signal?: AbortSignal;
}

export function run(
  repository: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      {
        cwd: repository,
        timeout: options.timeout ?? 30_000,
        maxBuffer: maxBytes + 1,
        encoding: "buffer",
        signal: options.signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      },
      (error, stdout, stderr) => {
        const detail = stderr.toString("utf8").trim();
        if (error?.name === "AbortError" || options.signal?.aborted) {
          reject(new Error("the review is closing"));
          return;
        }
        const failure = (error as NodeJS.ErrnoException | null)?.code;
        if (
          failure === "ENOBUFS" ||
          failure === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ) {
          reject(new Error(`git ${args[0]} output exceeds the review limit`));
          return;
        }
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        if (error && code === 0) {
          reject(new Error(`git ${args[0]} failed: ${error.message}`));
          return;
        }
        if (stdout.byteLength > maxBytes) {
          reject(new Error(`git ${args[0]} output exceeds the review limit`));
          return;
        }
        if (code !== 0 && (options.check ?? true)) {
          reject(new Error(`git ${args[0]} failed: ${detail || code}`));
          return;
        }
        resolve({ code, stdout, stderr: detail });
      },
    );
  });
}

async function line(
  repository: string,
  args: string[],
  options?: GitOptions,
): Promise<string> {
  const result = await run(repository, args, { maxBytes: 4096, ...options });
  return result.stdout.toString("utf8").trim();
}

/**
 * Reject anything that could be read as an option or a control sequence.
 * Revision expressions such as `HEAD~2` and `origin/main^` stay usable.
 */
export function assertRef(ref: string): string {
  if (
    !ref ||
    ref.startsWith("-") ||
    ref.length > LIMITS.ref ||
    /[\x00-\x20\x7f\\]/.test(ref)
  )
    throw new Error(`invalid git ref: ${JSON.stringify(ref)}`);
  return ref;
}

export async function resolveRepository(cwd: string): Promise<string> {
  const root = await line(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error("quick review needs a git repository");
  return root;
}

/** Resolve a ref to the exact commit it names now. */
export async function resolveCommit(
  repository: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const revision = await line(
    repository,
    [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${assertRef(ref)}^{commit}`,
    ],
    { check: false, signal },
  );
  if (!SHA.test(revision))
    throw new Error(`ref does not resolve to a commit: ${ref}`);
  return revision;
}

const FALLBACK_BRANCHES = ["main", "master", "trunk", "develop"];

/** Find the branch a review range should be measured against. */
export async function defaultBranch(repository: string): Promise<string> {
  const head = await line(
    repository,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { check: false },
  );
  if (head) return head;
  for (const branch of FALLBACK_BRANCHES) {
    const found = await line(
      repository,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `refs/heads/${branch}`,
      ],
      { check: false },
    );
    if (found) return branch;
  }
  throw new Error(
    "no default branch found; pass --base with an explicit base ref",
  );
}

export async function mergeBase(
  repository: string,
  base: string,
  target: string,
  signal?: AbortSignal,
): Promise<string> {
  const revision = await line(
    repository,
    ["merge-base", assertRef(base), assertRef(target)],
    { signal },
  );
  if (!SHA.test(revision))
    throw new Error(`no merge base between ${base} and ${target}`);
  return revision;
}

export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

export async function diffStat(
  repository: string,
  base: string,
  target: string,
): Promise<DiffStat> {
  const result = await run(
    repository,
    ["diff", "--no-ext-diff", "--numstat", base, target, "--"],
    { maxBytes: LIMITS.patch },
  );
  const stat: DiffStat = { files: 0, added: 0, removed: 0 };
  for (const row of result.stdout.toString("utf8").split("\n")) {
    if (!row.trim()) continue;
    const [added, removed] = row.split("\t");
    stat.files += 1;
    stat.added += Number(added) || 0;
    stat.removed += Number(removed) || 0;
  }
  return stat;
}

export async function patch(
  repository: string,
  base: string,
  target: string,
  context = 12,
): Promise<string> {
  const result = await run(
    repository,
    [
      "diff",
      "--no-ext-diff",
      "--no-color",
      `--unified=${context}`,
      base,
      target,
      "--",
    ],
    { maxBytes: LIMITS.patch },
  );
  return result.stdout.toString("utf8");
}

/** Read one file at an exact revision. Returns undefined when absent. */
export async function showFile(
  repository: string,
  revision: string,
  file: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!SAFE_PATH.test(file))
    throw new Error("context path must be a relative repository path");
  if (!SHA.test(revision)) throw new Error("context needs an exact revision");
  const result = await run(
    repository,
    ["show", "--textconv", `${revision}:${file}`],
    { maxBytes: LIMITS.context, check: false, signal },
  );
  if (result.code !== 0) return undefined;
  return result.stdout.toString("utf8");
}

export async function trackedFiles(
  repository: string,
  revision: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!SHA.test(revision))
    throw new Error("project inventory needs an exact revision");
  const result = await run(
    repository,
    ["ls-tree", "-r", "--name-only", "-z", revision, "--"],
    { maxBytes: 2 * LIMITS.context, signal },
  );
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => SAFE_PATH.test(file));
}

export interface ChangedPath {
  file: string;
  status: "added" | "modified" | "deleted";
}

export async function changedPaths(
  repository: string,
  base: string,
  target: string,
  signal?: AbortSignal,
): Promise<ChangedPath[]> {
  const result = await run(
    repository,
    ["diff", "--name-status", "-z", "--no-renames", base, target, "--"],
    { maxBytes: LIMITS.context, signal },
  );
  const fields = result.stdout.toString("utf8").split("\0").filter(Boolean);
  const changed: ChangedPath[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]![0];
    const file = fields[index + 1]!;
    if (!SAFE_PATH.test(file)) continue;
    changed.push({
      file,
      status:
        status === "A" ? "added" : status === "D" ? "deleted" : "modified",
    });
  }
  return changed;
}

export async function isDirty(repository: string): Promise<boolean> {
  const result = await run(repository, ["status", "--porcelain"], {
    maxBytes: 1024 * 1024,
  });
  return result.stdout.toString("utf8").trim().length > 0;
}

export async function subject(
  repository: string,
  revision: string,
): Promise<string> {
  return line(repository, ["log", "-1", "--format=%s", revision, "--"], {
    maxBytes: 8192,
  });
}
