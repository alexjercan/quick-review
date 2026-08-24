/** Best-effort browser launch for the loopback review page. */

import { spawn } from "node:child_process";

const OPENERS: Record<string, [string, string[]]> = {
  darwin: ["open", []],
  win32: ["cmd", ["/c", "start", ""]],
};

/** Returns false when opening was skipped or unavailable. */
export function openBrowser(url: string): boolean {
  if (process.env.QUICK_REVIEW_NO_OPEN) return false;
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/[A-Za-z0-9_-]+\/$/.test(url))
    throw new Error("refusing to open an unexpected review URL");
  const [command, args] = OPENERS[process.platform] ?? ["xdg-open", []];
  try {
    const child = spawn(command, [...args, url], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
