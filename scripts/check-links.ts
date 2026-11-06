// Checks local links and anchors in the README and docs, offline. External links are opened in a browser before
// submitting. Exits 1 and lists every broken link.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const FILES = ["README.md", "SECURITY.md", "docs/EVIDENCE.md", "docs/SYSTEM_CARD.md", "examples/README.md"];

const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const anchors = (file: string) => new Set([...readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!)));

const bad: string[] = [];
for (const file of FILES) {
  if (!existsSync(file)) {
    bad.push(`${file}: file is missing`);
    continue;
  }
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  const links = [...text.matchAll(/\]\(([^)\s]+)(?:\s[^)]*)?\)|(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
  for (const link of links) {
    if (/^(https?:|mailto:)/.test(link)) continue;
    const [path, anchor] = link.split("#");
    const target = path ? normalize(join(dirname(file), path)) : file;
    if (!existsSync(target)) bad.push(`${file}: ${link} (no such file)`);
    else if (anchor && target.endsWith(".md") && !anchors(target).has(anchor)) bad.push(`${file}: ${link} (no such heading)`);
  }
}
if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
console.log(`Local links fine in ${FILES.length} files.`);
