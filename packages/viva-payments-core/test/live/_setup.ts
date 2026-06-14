/**
 * vitest setupFile for the LIVE suite — loads `.env` from the repo root into
 * `process.env` once, before any live test runs.
 *
 * Hand-rolled loader (no `dotenv` dependency) mirroring the probe scripts in
 * `scripts/viva-*-probe.ts`. It only POPULATES `process.env`; it never logs,
 * prints, or otherwise echoes any value — secrets stay out of the transcript.
 * Existing `process.env` values win (CI / shell exports override `.env`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadDotenv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No .env at the repo root — fine. Live tests self-skip when their
    // required vars are absent (see _env.ts liveDescribe).
    return;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of raw.split('\n')) {
    let t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('export ')) t = t.slice(7).trim();
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// test/live/_setup.ts -> repo root is four levels up:
// packages/viva-payments-core/test/live/_setup.ts
const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
loadDotenv(resolve(repoRoot, '.env'));
