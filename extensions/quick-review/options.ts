/** Argument parsing for `/quick-review`. */

import type { GraphScope } from "./graph-contract.ts";

export interface CommandOptions {
  baseRef?: string;
  targetRef?: string;
  repository?: string;
  scope: GraphScope;
  open: boolean;
  help: boolean;
}

export const USAGE = `/quick-review [--scope head|diff] [--base <ref>] [--target <ref>] [--repo <path>] [--no-open]

  --scope <scope>  Analyze committed HEAD or a diff. Defaults to diff.
  --base <ref>     Base of the reviewed range. Defaults to the merge base with
                   the repository default branch.
  --target <ref>   Target of the reviewed range. Defaults to HEAD.
  --repo <path>    Repository to review. Defaults to the session directory.
  --no-open        Do not open a browser for the review page.`;

type ValueOption = "baseRef" | "targetRef" | "repository";

const VALUE_FLAGS: Record<string, ValueOption> = {
  "--base": "baseRef",
  "--target": "targetRef",
  "--repo": "repository",
};

/** Split on whitespace, honouring single and double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern))
    tokens.push(match[1] ?? match[2] ?? match[3]!);
  return tokens;
}

export function parseOptions(input: string): CommandOptions {
  const options: CommandOptions = { scope: "diff", open: true, help: false };
  const tokens = tokenize(input);
  let scopeSeen = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--no-open") {
      options.open = false;
      continue;
    }
    const [name, inlineValue] =
      token.startsWith("--") && token.includes("=")
        ? [
            token.slice(0, token.indexOf("=")),
            token.slice(token.indexOf("=") + 1),
          ]
        : [token, undefined];
    if (name === "--scope") {
      const value = inlineValue ?? tokens[++index];
      if (value !== "head" && value !== "diff")
        throw new Error(`--scope must be head or diff\n\n${USAGE}`);
      if (scopeSeen) throw new Error("--scope was given twice");
      scopeSeen = true;
      options.scope = value;
      continue;
    }
    const key = VALUE_FLAGS[name];
    if (!key) throw new Error(`unknown option: ${token}\n\n${USAGE}`);
    const value = inlineValue ?? tokens[++index];
    if (!value) throw new Error(`${name} needs a value\n\n${USAGE}`);
    if (options[key] !== undefined) throw new Error(`${name} was given twice`);
    options[key] = value;
  }
  return options;
}
