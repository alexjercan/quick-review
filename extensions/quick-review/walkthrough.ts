/** Parser and validator for the versioned walkthrough Markdown artifact. */

import { createHash } from "node:crypto";
import {
  ARTIFACT_VERSION,
  LIMITS,
  LINE_RANGE,
  SAFE_PATH,
  SECTION_ID,
  SHA,
  type Importance,
  type WalkthroughDocument,
  type WalkthroughSection,
} from "./contract.ts";

const DIRECTIVES = ["walkthrough", "change", "review"];
const IMPORTANCE: Importance[] = ["critical", "important", "supporting"];

function fields(text: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*): ([^\r\n]+)$/.exec(line);
    if (!match) return undefined;
    const key = match[1]!;
    if (key in result) return undefined;
    result[key] = match[2]!;
  }
  return result;
}

function exact(value: Record<string, string>, names: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...names].sort().join("\0");
}

function uint(value: string): number | undefined {
  return /^(?:0|[1-9][0-9]{0,8})$/.test(value) ? Number(value) : undefined;
}

/**
 * Parse the walkthrough artifact.
 *
 * Structural problems in one change are reported as warnings and the change is
 * dropped. Problems that make the artifact untrustworthy as a whole throw.
 */
export function parseWalkthrough(source: string): WalkthroughDocument {
  if (Buffer.byteLength(source, "utf8") > LIMITS.artifact)
    throw new Error(`walkthrough exceeds ${LIMITS.artifact / 1024} KiB`);
  const warnings: string[] = [];
  const top =
    /^# ([^\r\n]{1,200})\n[\s\S]*?^:::walkthrough\n([\s\S]*?)\n:::\s*$/m.exec(
      source,
    );
  if (!top) throw new Error("walkthrough metadata is missing");
  const metadata = fields(top[2]!);
  const expected = [
    "version",
    "status",
    "revision",
    "baseRevision",
    "files",
    "added",
    "removed",
  ];
  if (!metadata || !exact(metadata, expected))
    throw new Error(
      `walkthrough metadata must contain exactly: ${expected.join(", ")}`,
    );
  const version = uint(metadata.version!);
  const revision = metadata.revision!;
  const baseRevision = metadata.baseRevision!;
  const files = uint(metadata.files!);
  const added = uint(metadata.added!);
  const removed = uint(metadata.removed!);
  if (version !== ARTIFACT_VERSION)
    throw new Error(`unsupported walkthrough version: ${metadata.version}`);
  if (metadata.status !== "ready")
    throw new Error("walkthrough status must be ready");
  if (!SHA.test(revision) || !SHA.test(baseRevision))
    throw new Error("walkthrough revisions must be full 40-character SHAs");
  if (files === undefined || added === undefined || removed === undefined)
    throw new Error("walkthrough counters must be non-negative integers");

  for (const block of source.matchAll(
    /^:::([a-zA-Z][a-zA-Z0-9-]*)\n([\s\S]*?)\n:::\s*$/gm,
  ))
    if (!DIRECTIVES.includes(block[1]!))
      warnings.push(`Unsupported directive: ${block[1]}`);

  const sections: WalkthroughSection[] = [];
  const changes = [...source.matchAll(/^:::change\n([\s\S]*?)\n:::\s*$/gm)];
  for (const [index, change] of changes.entries()) {
    if (sections.length >= LIMITS.sections)
      throw new Error(`walkthrough has more than ${LIMITS.sections} changes`);
    const value = fields(change[1]!);
    if (
      !value ||
      !exact(value, ["id", "importance", "file", "lines"]) ||
      !SECTION_ID.test(value.id ?? "") ||
      !IMPORTANCE.includes(value.importance as Importance) ||
      !SAFE_PATH.test(value.file ?? "") ||
      Buffer.byteLength(value.file ?? "", "utf8") > 512 ||
      !LINE_RANGE.test(value.lines ?? "")
    ) {
      warnings.push(`Malformed change directive ${index + 1}`);
      continue;
    }
    if (sections.some((section) => section.id === value.id)) {
      warnings.push(`Duplicate change id: ${value.id}`);
      continue;
    }
    const start = (change.index ?? 0) + change[0].length;
    const end = changes[index + 1]?.index ?? source.length;
    const body = source.slice(start, end);
    const diffs = [...body.matchAll(/```diff\n([\s\S]*?)\n```/g)];
    const prompts = [...body.matchAll(/^:::review\n([\s\S]*?)\n:::\s*$/gm)];
    const diff = diffs[0]?.[1];
    const prompt = prompts[0]?.[1];
    if (
      diffs.length !== 1 ||
      prompts.length !== 1 ||
      !diff ||
      !prompt?.trim() ||
      Buffer.byteLength(prompt, "utf8") > LIMITS.prompt
    ) {
      warnings.push(`Change ${value.id} needs one diff and one review prompt`);
      continue;
    }
    sections.push({
      id: value.id!,
      importance: value.importance as Importance,
      file: value.file!,
      lines: value.lines!,
      markdown: body
        .replace(/```diff\n[\s\S]*?\n```/g, "")
        .replace(/^:::review\n[\s\S]*?\n:::\s*$/gm, "")
        .trim(),
      diff,
      prompt: prompt.trim(),
    });
  }
  if (sections.length === 0)
    throw new Error("walkthrough has no valid changes");

  const headingEnd = source.indexOf("\n") + 1;
  const summary = source
    .slice(headingEnd, source.indexOf(":::walkthrough", headingEnd))
    .trim();
  return {
    version: ARTIFACT_VERSION,
    title: top[1]!,
    summary: summary || "Review the changes below.",
    revision,
    baseRevision,
    files,
    added,
    removed,
    sections,
    warnings,
    identity: createHash("sha256").update(source).digest("hex"),
    source,
  };
}

/** Bind the artifact to the exact range it claims to describe. */
export function assertWalkthroughRange(
  document: WalkthroughDocument,
  revision: string,
  baseRevision: string,
): void {
  if (document.revision !== revision || document.baseRevision !== baseRevision)
    throw new Error("walkthrough revisions do not match the reviewed range");
}
