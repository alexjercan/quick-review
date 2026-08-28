/** Exact HEAD and diff planning for progressive project graphs. */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewInputs } from "./contract.ts";
import { GRAPH_LIMITS, type GraphScope } from "./graph-contract.ts";
import * as git from "./git.ts";
import {
  planReview,
  reviewStateRoot,
  verifyRange,
  withReviewDirectory,
  type ReviewPlan,
} from "./review.ts";

export interface InventoryEntry {
  file: string;
  language: string;
  overlay: "unchanged" | "added" | "modified" | "deleted";
}

export interface ProjectInventory {
  revision: string;
  files: InventoryEntry[];
  manifests: string[];
  languages: Record<string, number>;
  truncated: boolean;
}

export interface GraphPlan {
  scope: GraphScope;
  inputs: ReviewInputs;
  baseExplicit: boolean;
  files: number;
  added: number;
  removed: number;
  subject: string;
  dirty: boolean;
  directory: string;
  artifactPath: string;
  statePath: string;
  patchPath: string;
  completionPath: string;
  inventoryPath: string;
  patch: string;
  inventory: ProjectInventory;
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "flake.nix",
  "Makefile",
  "CMakeLists.txt",
]);

function language(file: string): string {
  const name = file.split("/").at(-1) ?? file;
  if (MANIFEST_NAMES.has(name)) return "manifest";
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    rs: "rust",
    go: "go",
    py: "python",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    sh: "shell",
    nix: "nix",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
  };
  return extension ? (languages[extension] ?? extension) : "other";
}

export async function buildInventory(
  repository: string,
  revision: string,
  baseRevision?: string,
  signal?: AbortSignal,
): Promise<ProjectInventory> {
  const tracked = await git.trackedFiles(repository, revision, signal);
  const changed =
    baseRevision && baseRevision !== revision
      ? await git.changedPaths(repository, baseRevision, revision, signal)
      : [];
  const overlay = new Map(changed.map((item) => [item.file, item.status]));
  const all = [...new Set([...tracked, ...changed.map((item) => item.file)])];
  all.sort((left, right) => {
    const leftManifest = MANIFEST_NAMES.has(left.split("/").at(-1) ?? "");
    const rightManifest = MANIFEST_NAMES.has(right.split("/").at(-1) ?? "");
    return (
      Number(rightManifest) - Number(leftManifest) || left.localeCompare(right)
    );
  });
  let truncated = all.length > GRAPH_LIMITS.inventoryFiles;
  const files: InventoryEntry[] = [];
  for (const file of all) {
    if (Buffer.byteLength(file, "utf8") > 512) {
      truncated = true;
      continue;
    }
    const entry: InventoryEntry = {
      file,
      language: language(file),
      overlay: overlay.get(file) ?? "unchanged",
    };
    if (
      files.length >= GRAPH_LIMITS.inventoryFiles ||
      Buffer.byteLength(JSON.stringify([...files, entry]), "utf8") >
        GRAPH_LIMITS.inventory - 4096
    ) {
      truncated = true;
      break;
    }
    files.push(entry);
  }
  const languages: Record<string, number> = {};
  for (const item of files)
    languages[item.language] = (languages[item.language] ?? 0) + 1;
  return {
    revision,
    files,
    manifests: files
      .filter((item) => item.language === "manifest")
      .map((item) => item.file),
    languages,
    truncated,
  };
}

function writeNew(path: string, value: string): void {
  writeFileSync(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function attachGraphPaths(
  plan: ReviewPlan,
  inventory: ProjectInventory,
  scope: GraphScope,
): GraphPlan {
  const graph: GraphPlan = {
    ...plan,
    scope,
    artifactPath: join(plan.directory, "graph.json"),
    statePath: join(plan.directory, "graph-state.json"),
    inventoryPath: join(plan.directory, "inventory.json"),
    inventory,
  };
  writeNew(graph.inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return graph;
}

export interface AnalysisOptions {
  cwd: string;
  scope: GraphScope;
  repository?: string;
  baseRef?: string;
  targetRef?: string;
}

export async function planAnalysis(
  options: AnalysisOptions,
): Promise<GraphPlan> {
  if (options.scope === "diff") {
    const plan = await planReview(options);
    try {
      const inventory = await buildInventory(
        plan.inputs.repository,
        plan.inputs.revision,
        plan.inputs.baseRevision,
      );
      return attachGraphPaths(plan, inventory, "diff");
    } catch (error) {
      const { rmSync } = await import("node:fs");
      rmSync(plan.directory, { recursive: true, force: true });
      throw error;
    }
  }

  const repository = await git.resolveRepository(
    options.repository ?? options.cwd,
  );
  const targetRef = options.targetRef ?? "HEAD";
  const revision = await git.resolveCommit(repository, targetRef);
  const subject = await git.subject(repository, revision);
  const dirty = await git.isDirty(repository);
  const inventory = await buildInventory(repository, revision);
  return withReviewDirectory(
    reviewStateRoot(),
    () => `${revision.slice(0, 12)}-${randomBytes(8).toString("hex")}`,
    (directory) => {
      const inputs: ReviewInputs = {
        repository,
        baseRef: targetRef,
        targetRef,
        baseRevision: revision,
        revision,
      };
      const patchPath = join(directory, "patch.diff");
      writeNew(patchPath, "");
      const plan: ReviewPlan = {
        inputs,
        baseExplicit: true,
        files: inventory.files.length,
        added: 0,
        removed: 0,
        subject,
        dirty,
        directory,
        artifactPath: join(directory, "walkthrough.md"),
        statePath: join(directory, "state.json"),
        patchPath,
        completionPath: join(directory, "completion.json"),
        patch: "",
      };
      return attachGraphPaths(plan, inventory, "head");
    },
  );
}

export async function verifyAnalysis(
  plan: GraphPlan,
  signal?: AbortSignal,
): Promise<void> {
  if (plan.scope === "diff") {
    await verifyRange(plan, signal);
    return;
  }
  const current = await git.resolveCommit(
    plan.inputs.repository,
    plan.inputs.targetRef,
    signal,
  );
  if (current !== plan.inputs.revision)
    throw new Error("the analyzed HEAD changed; run /quick-review again");
  const second = await git.resolveCommit(
    plan.inputs.repository,
    plan.inputs.targetRef,
    signal,
  );
  if (second !== plan.inputs.revision)
    throw new Error("the analyzed HEAD changed; run /quick-review again");
}
