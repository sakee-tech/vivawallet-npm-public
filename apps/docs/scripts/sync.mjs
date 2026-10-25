#!/usr/bin/env node
// Sync public markdown into apps/docs/src/. Source of truth: /README.md,
// /docs/*.md (top-level, public), /packages/*/README.md.
//
// Internal-only docs live under /docs/internal/** and are NEVER read by
// this sync. Rewrites cross-doc relative links so they resolve in the
// VitePress site. Stray references to docs/internal/** are stripped from
// rendered markdown by stripInternalRefs() below.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const outRoot = join(__dirname, "..", "src");
const githubBlob = "https://github.com/techsakee20/vivawallet/blob/main";

// source path (relative to repoRoot) -> destination path (relative to outRoot)
const fileMap = [
  ["README.md", "overview.md"],
  ["docs/AUTH.md", "reference/auth.md"],
  ["docs/ENDPOINTS.md", "reference/endpoints.md"],
  ["docs/WEBHOOKS.md", "reference/webhooks.md"],
  ["docs/STATE-MACHINE.md", "reference/state-machine.md"],
  ["docs/ERRORS.md", "reference/errors.md"],
  ["docs/GLOSSARY.md", "reference/glossary.md"],
  ["docs/SECURITY.md", "reference/security.md"],
  ["docs/MIGRATION-0.1-to-0.2.md", "guides/migration-0.1-to-0.2.md"],
  ["packages/viva-payments-core/README.md", "packages/core.md"],
  ["packages/medusa-payment-viva/README.md", "packages/medusa.md"],
  ["packages/vendure-payment-viva/README.md", "packages/vendure.md"],
];

// Map of "source-relative href" -> "site-absolute path".
// Both with and without leading ./ are normalized before lookup.
const linkMap = new Map([
  ["README.md", "/overview"],
  ["docs/AUTH.md", "/reference/auth"],
  ["docs/ENDPOINTS.md", "/reference/endpoints"],
  ["docs/WEBHOOKS.md", "/reference/webhooks"],
  ["docs/STATE-MACHINE.md", "/reference/state-machine"],
  ["docs/ERRORS.md", "/reference/errors"],
  ["docs/GLOSSARY.md", "/reference/glossary"],
  ["docs/SECURITY.md", "/reference/security"],
  ["docs/MIGRATION-0.1-to-0.2.md", "/guides/migration-0.1-to-0.2"],
  ["packages/viva-payments-core/README.md", "/packages/core"],
  ["packages/medusa-payment-viva/README.md", "/packages/medusa"],
  ["packages/vendure-payment-viva/README.md", "/packages/vendure"],
  // bare package dirs (some READMEs link to the directory, not the file)
  ["packages/viva-payments-core", "/packages/core"],
  ["packages/medusa-payment-viva", "/packages/medusa"],
  ["packages/vendure-payment-viva", "/packages/vendure"],
]);

function normalizeSrcHref(href, srcDir) {
  // Strip leading "./" then resolve "../" segments relative to srcDir
  // so links written from inside docs/ or packages/* resolve to repo-root paths.
  let clean = href.replace(/^\.\//, "");
  if (clean.startsWith("/")) clean = clean.slice(1);

  const parts = (srcDir ? `${srcDir}/${clean}` : clean).split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function rewriteLink(href, srcDir) {
  // Leave external links, anchors, mailto/tel alone
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith("#")) return href;

  const [pathPart, hash = ""] = href.split("#");
  if (!pathPart) return href;

  const normalized = normalizeSrcHref(pathPart, srcDir);
  const hashSuffix = hash ? `#${hash}` : "";

  if (linkMap.has(normalized)) {
    return linkMap.get(normalized) + hashSuffix;
  }

  // Any other in-repo path (not external, not anchored, not site-mapped) is
  // rewritten to a GitHub blob URL. This covers per-package CHANGELOG.md and
  // LICENSE files, the docs/ directory landing, plans, resume notes, and any
  // future repo file that isn't published to the docs site.
  if (normalized) {
    return `${githubBlob}/${normalized}${hashSuffix}`;
  }

  return href;
}

function rewriteMarkdown(content, srcPath) {
  const srcDir = dirname(srcPath);
  const dir = srcDir === "." ? "" : srcDir;

  // [text](href) — skip image syntax handled below
  let out = content.replace(/(\[[^\]]*\])\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, label, href, title = "") => {
    return `${label}(${rewriteLink(href, dir)}${title})`;
  });

  // ![alt](src) — leave images alone for now (no in-repo images referenced from docs)
  // Reference-style links [foo]: ./bar
  out = out.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (m, prefix, href) => {
    return `${prefix}${rewriteLink(href, dir)}`;
  });

  out = stripInternalRefs(out);

  return out;
}

// Markdown text that, after link rewriting, still mentions an internal-only
// path. Public docs should not advertise these paths or link out to them —
// the spec, resume notes, and plugin contract are reader-internal artefacts.
const INTERNAL_REF =
  /docs\/internal\/|(^|[^a-z0-9])scripts\/[a-z0-9-]+\.md|references\/[a-z0-9-]+\.md|\.changeset\//i;

function stripInternalRefs(content) {
  const lines = content.split("\n");
  const out = [];

  for (const raw of lines) {
    if (!INTERNAL_REF.test(raw)) {
      out.push(raw);
      continue;
    }

    // Table row → drop the row entirely.
    if (/^\s*\|/.test(raw)) continue;

    // Blockquote line → drop the single line. If the surrounding chunk is
    // left dangling that's fine; collapsed blank-line pass below cleans it.
    if (/^\s*>/.test(raw)) continue;

    // List item (- / * / 1.) → drop the bullet.
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(raw)) continue;

    // Inline prose mention. Strip the offending link / backticked path,
    // then tidy stranded punctuation (";", "()", "§N"). If nothing useful
    // remains, drop the line.
    let cleaned = raw
      // [label](github.com/.../internal-path...)
      .replace(
        /\[[^\]]*\]\(https?:\/\/[^)]*\/(?:docs\/internal\/|scripts\/[a-z0-9-]+\.md|\.changeset\/|references\/[a-z0-9-]+\.md)[^)]*\)/gi,
        ""
      )
      // Bare backticked internal paths
      .replace(/`docs\/internal\/[^`]*`/gi, "")
      .replace(/`scripts\/[a-z0-9-]+\.md`/gi, "")
      // "(see ...)" / "( § 7.)" / ";" cleanup after a strip
      .replace(/\([^()]*(?:see|in)\s*[);]/gi, (m) => (m.endsWith(")") ? "" : m))
      .replace(/\(\s*§\s*\d+[^)]*\)/g, "")
      .replace(/§\s*\d+/g, "")
      .replace(/\s+;\s*/g, "; ")
      .replace(/;\s*\)/g, ")")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([.,;:])/g, "$1")
      .trimEnd();

    if (!cleaned.trim()) continue;
    out.push(cleaned);
  }

  // Collapse runs of 3+ blank lines to 2.
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function sync() {
  // Clean generated dirs first (preserves index.md and other committed files).
  for (const sub of ["reference", "packages", "guides"]) {
    await rm(join(outRoot, sub), { recursive: true, force: true });
  }
  await rm(join(outRoot, "overview.md"), { force: true });

  for (const [src, dest] of fileMap) {
    const srcPath = join(repoRoot, src);
    const destPath = join(outRoot, dest);
    let content = await readFile(srcPath, "utf8");
    content = rewriteMarkdown(content, src);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, content, "utf8");
    console.log(`  synced  ${src.padEnd(48)} -> ${dest}`);
  }
}

sync().catch((err) => {
  console.error(err);
  process.exit(1);
});
