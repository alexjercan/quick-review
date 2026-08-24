/** Review state: creation, validation, transitions, and durable storage. */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  bounded,
  LIMITS,
  RECORD_ID,
  STATE_VERSION,
  type ReviewComment,
  type ReviewState,
  type SectionState,
  type WalkthroughDocument,
} from "./contract.ts";

const SECTION_STATES: SectionState[] = [
  "not-reviewed",
  "viewed",
  "needs-explanation",
];
const OUTCOMES = ["open", "approved", "changes-requested"];
const STATE_KEYS = [
  "version",
  "identity",
  "revision",
  "baseRevision",
  "sections",
  "viewed",
  "questions",
  "comments",
  "outcome",
];

function keys(value: object): string {
  return Object.keys(value).sort().join("\0");
}

function text(value: unknown, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  );
}

export function initialState(document: WalkthroughDocument): ReviewState {
  return {
    version: STATE_VERSION,
    identity: document.identity,
    revision: document.revision,
    baseRevision: document.baseRevision,
    sections: Object.fromEntries(
      document.sections.map((section) => [section.id, "not-reviewed"]),
    ),
    viewed: Object.fromEntries(
      document.sections.map((section) => [section.id, false]),
    ),
    questions: [],
    comments: [],
    outcome: "open",
  };
}

/** Validate untrusted state against the exact artifact it must belong to. */
export function validateState(
  document: WalkthroughDocument,
  value: unknown,
): ReviewState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("review state is not an object");
  const state = value as ReviewState;
  if (
    keys(state) !== [...STATE_KEYS].sort().join("\0") ||
    state.version !== STATE_VERSION ||
    state.identity !== document.identity ||
    state.revision !== document.revision ||
    state.baseRevision !== document.baseRevision ||
    !OUTCOMES.includes(state.outcome) ||
    !state.sections ||
    typeof state.sections !== "object" ||
    !state.viewed ||
    typeof state.viewed !== "object" ||
    !Array.isArray(state.questions) ||
    !Array.isArray(state.comments)
  )
    throw new Error("review state does not match the artifact");

  const ids = document.sections.map((section) => section.id).sort();
  if (
    Object.keys(state.sections).sort().join("\0") !== ids.join("\0") ||
    Object.keys(state.viewed).sort().join("\0") !== ids.join("\0") ||
    Object.values(state.viewed).some((item) => typeof item !== "boolean") ||
    Object.values(state.sections).some((item) => !SECTION_STATES.includes(item))
  )
    throw new Error("review section state is invalid");

  if (
    state.questions.length > LIMITS.questions ||
    state.questions.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        keys(item) !== "answer\0question\0sectionId" ||
        !(item.sectionId in state.sections) ||
        !text(item.question, LIMITS.comment) ||
        !text(item.answer, LIMITS.answer),
    )
  )
    throw new Error("review questions are invalid");

  const byId = new Map(
    document.sections.map((section) => [section.id, section]),
  );
  if (
    state.comments.length > LIMITS.sections ||
    new Set(state.comments.map((item) => item?.id)).size !==
      state.comments.length ||
    state.comments.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        keys(item) !== "body\0file\0id\0lines\0sectionId" ||
        !RECORD_ID.test(item.id) ||
        byId.get(item.sectionId)?.file !== item.file ||
        byId.get(item.sectionId)?.lines !== item.lines ||
        !text(item.body, LIMITS.comment),
    )
  )
    throw new Error("review comments are invalid");

  if (state.outcome === "approved" && !isApprovable(state))
    throw new Error("approved review has unviewed sections");
  return state;
}

export function isApprovable(state: ReviewState): boolean {
  return Object.values(state.viewed).every(Boolean);
}

export function setViewed(
  state: ReviewState,
  sectionId: string,
  viewed: boolean,
): void {
  if (!(sectionId in state.sections)) throw new Error("unknown review section");
  state.viewed[sectionId] = viewed;
  if (viewed) {
    if (state.sections[sectionId] === "not-reviewed")
      state.sections[sectionId] = "viewed";
  } else if (state.sections[sectionId] === "viewed")
    state.sections[sectionId] = "not-reviewed";
}

export function addComment(
  document: WalkthroughDocument,
  state: ReviewState,
  sectionId: string,
  body: string,
): ReviewComment {
  const section = document.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error("unknown review section");
  if (!body.trim()) throw new Error("a comment needs text");
  if (state.comments.length >= LIMITS.sections)
    throw new Error("review comments exceed the bounded review limit");
  const comment: ReviewComment = {
    id: randomBytes(12).toString("hex"),
    sectionId,
    file: section.file,
    lines: section.lines,
    body: body.trim(),
  };
  state.comments.push(comment);
  return comment;
}

export function recordQuestion(
  state: ReviewState,
  sectionId: string,
  question: string,
  answer: string,
): void {
  if (!(sectionId in state.sections)) throw new Error("unknown review section");
  if (state.questions.length >= LIMITS.questions)
    throw new Error("review questions exceed the bounded review limit");
  state.questions.push({
    sectionId,
    question: bounded(question.trim(), LIMITS.comment),
    answer: bounded(answer.trim(), LIMITS.answer),
  });
  state.sections[sectionId] = "needs-explanation";
}

export function saveState(path: string, state: ReviewState): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("review state is not a regular file");
    const encoded = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > LIMITS.state)
      throw new Error("review state exceeds the bounded review limit");
    writeFileSync(descriptor, encoded, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function loadState(
  path: string,
  document: WalkthroughDocument,
): ReviewState {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > LIMITS.state)
      throw new Error("review state file is invalid");
    return validateState(
      document,
      JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
    );
  } finally {
    closeSync(descriptor);
  }
}
