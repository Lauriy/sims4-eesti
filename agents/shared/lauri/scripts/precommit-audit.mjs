/**
 * Audit what a commit would publish, before it is published.
 *
 * Reports: how many files a commit would include, their total size, any file
 * over half a megabyte, any binary file, credential-shaped strings, and paths
 * that leak the current machine's layout. Run from the repository root.
 *
 * Read-only apart from running `git add -A` to stage the working tree, which is
 * what a commit would do anyway. Personal-path patterns come from %USERPROFILE%
 * (or $HOME), so this works on any machine without editing.
 *
 * Usage:  node agents/shared/lauri/scripts/precommit-audit.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

execFileSync("git", ["add", "-A"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const listed = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

console.log(`files a commit would include: ${listed.length}\n`);

const home = process.env.USERPROFILE || process.env.HOME || "";
const homeWindows = home.replace(/\//g, "\\");
const homePosix = home.replace(/\\/g, "/");

const patterns = [
  [/ghp_[A-Za-z0-9]{20,}/, "GitHub PAT"],
  [/gho_[A-Za-z0-9]{20,}/, "GitHub OAuth token"],
  [/ghs_[A-Za-z0-9]{20,}/, "GitHub server token"],
  [/sk-[A-Za-z0-9]{20,}/, "API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/ANTHROPIC_AUTH_TOKEN\s*=\s*["'`]?[A-Za-z0-9_-]{16,}/, "auth token assignment"],
];
if (homeWindows) patterns.push([new RegExp(escapeRegExp(homeWindows), "i"), "personal absolute path"]);
if (homePosix && homePosix !== homeWindows) {
  patterns.push([new RegExp(escapeRegExp(homePosix), "i"), "personal absolute path (forward slashes)"]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let total = 0;
const flagged = [];
const big = [];

for (const file of listed) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  total += size;
  if (size > 512 * 1024) big.push(`${file} (${(size / 1024 / 1024).toFixed(2)} MiB)`);

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) {
    flagged.push([file, "binary file"]);
    continue;
  }
  for (const [pattern, label] of patterns) {
    const match = text.match(pattern);
    if (match) flagged.push([file, `${label}: ${match[0].slice(0, 40)}`]);
  }
}

console.log(`total size: ${(total / 1024).toFixed(0)} KiB`);
console.log(`files over 512 KiB: ${big.length}${big.length ? "\n  " + big.join("\n  ") : ""}`);
console.log("\nflagged:");
if (flagged.length === 0) console.log("  (none)");
for (const [file, why] of flagged) console.log(`  ${file}: ${why}`);

console.log("");
for (const dir of ["work/", "dist/", "node_modules/"]) {
  console.log(`${listed.some((file) => file.startsWith(dir)) ? "LEAK" : "ok  "}  ${dir} not committed`);
}
console.log(`${listed.includes(".env") ? "LEAK" : "ok  "}  .env not committed`);
