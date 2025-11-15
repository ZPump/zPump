import fs from 'fs';
import path from 'path';

let cachedRoot: string | null = null;

function locateRepoRoot(): string {
  if (cachedRoot) {
    return cachedRoot;
  }
  const start = process.cwd();
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    const marker = path.join(current, 'Anchor.toml');
    if (fs.existsSync(marker)) {
      cachedRoot = current;
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(`Unable to locate repository root from ${start}`);
}

export function getRepoRoot(): string {
  return locateRepoRoot();
}

export function resolveRepoPath(...segments: string[]): string {
  return path.join(getRepoRoot(), ...segments);
}

