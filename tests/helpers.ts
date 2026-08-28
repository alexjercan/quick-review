/** Shared fixtures: isolated git repositories and walkthrough artifacts. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Quick Review Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Quick Review Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY, HOME: repository },
  }).trim();
}

export function write(repository: string, path: string, content: string): void {
  const target = join(repository, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

export function commit(repository: string, message: string): string {
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

export interface Fixture {
  path: string;
  base: string;
  head: string;
  cleanup(): void;
}

/** A repository with one committed change on top of `main`. */
export function repository(): Fixture {
  const path = mkdtempSync(join(tmpdir(), "quick-review-"));
  git(path, "init", "-q", "-b", "main");
  write(path, "src/app.js", "export function greet() {\n  return 'hi';\n}\n");
  write(path, "README.md", "# demo\n");
  const base = commit(path, "Add the greeting");
  git(path, "checkout", "-q", "-b", "feature");
  write(
    path,
    "src/app.js",
    "export function greet(name) {\n  return `hi ${name}`;\n}\n",
  );
  const head = commit(path, "Greet by name");
  return {
    path,
    base,
    head,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function projectGraph(
  revision: string,
  baseRevision: string,
  scope: "head" | "diff" = "diff",
): string {
  return JSON.stringify({
    version: 1,
    title: "Greeting architecture",
    summary: "A small greeting component.",
    scope,
    revision,
    baseRevision,
    roots: ["greeting"],
    nodes: [
      {
        id: "greeting",
        parentId: null,
        kind: "component",
        title: "Greeting",
        summary: "Formats the caller's greeting.",
        confidence: "confirmed",
        overlay: scope === "diff" ? "modified" : "unchanged",
        expandable: true,
        file: "src/app.js",
        lines: "1-3",
        language: "javascript",
        evidence: [
          {
            file: "src/app.js",
            lines: "1-3",
            revision,
            confidence: "confirmed",
          },
        ],
      },
    ],
    edges: [],
    guidance: [],
  });
}

export function graphDelta(revision: string): string {
  return JSON.stringify({
    version: 1,
    revision,
    parentId: "greeting",
    nodes: [
      {
        id: "greeting.format",
        parentId: "greeting",
        kind: "symbol",
        title: "greet",
        summary: "Interpolates the supplied name.",
        confidence: "confirmed",
        overlay: "modified",
        expandable: false,
        file: "src/app.js",
        lines: "1-3",
        language: "javascript",
        evidence: [
          {
            file: "src/app.js",
            lines: "1-3",
            revision,
            confidence: "confirmed",
          },
        ],
      },
    ],
    edges: [
      {
        id: "greeting-contains-format",
        source: "greeting",
        target: "greeting.format",
        kind: "contains",
        confidence: "confirmed",
      },
    ],
  });
}

export interface SectionFixture {
  id: string;
  importance?: string;
  file?: string;
  lines?: string;
  prose?: string;
  diff?: string;
  prompt?: string;
}

export function walkthrough(
  revision: string,
  baseRevision: string,
  sections: SectionFixture[] = [{ id: "greet-by-name" }],
  overrides: Record<string, string> = {},
): string {
  const metadata = {
    version: "1",
    status: "ready",
    revision,
    baseRevision,
    files: "1",
    added: "2",
    removed: "2",
    ...overrides,
  };
  const head = [
    "# Greet by name",
    "",
    "The greeting now takes a name.",
    "",
    ":::walkthrough",
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`),
    ":::",
    "",
  ];
  const body = sections.flatMap((section) => [
    ":::change",
    `id: ${section.id}`,
    `importance: ${section.importance ?? "critical"}`,
    `file: ${section.file ?? "src/app.js"}`,
    `lines: ${section.lines ?? "1-3"}`,
    ":::",
    "",
    section.prose ?? "The helper now interpolates the caller name.",
    "",
    "```diff",
    section.diff ?? "-  return 'hi';\n+  return `hi ${name}`;",
    "```",
    "",
    ":::review",
    section.prompt ?? "Does the helper handle an empty name?",
    ":::",
    "",
  ]);
  return [...head, ...body].join("\n");
}
