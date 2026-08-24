/** Argument parsing for `/quick-review`. */

export interface CommandOptions {
  baseRef?: string;
  targetRef?: string;
  repository?: string;
  open: boolean;
  help: boolean;
}

export const USAGE = `/quick-review [--base <ref>] [--target <ref>] [--repo <path>] [--no-open]

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
  const options: CommandOptions = { open: true, help: false };
  const tokens = tokenize(input);
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
    const key = VALUE_FLAGS[name];
    if (!key) throw new Error(`unknown option: ${token}\n\n${USAGE}`);
    const value = inlineValue ?? tokens[++index];
    if (!value) throw new Error(`${name} needs a value\n\n${USAGE}`);
    if (options[key] !== undefined) throw new Error(`${name} was given twice`);
    options[key] = value;
  }
  return options;
}
