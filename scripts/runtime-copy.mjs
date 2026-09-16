import { cp, lstat, mkdir, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const inside = (root, file) => file === root || file.startsWith(root + sep);

// A bundle may contain relative framework links, but none may depend on the
// build machine or another directory. Follow chains to catch indirect escapes.
export async function auditRuntimeLinks(directory) {
  const root = await realpath(directory), links = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(file);
        if (isAbsolute(target) || !inside(root, resolve(dirname(file), target))) throw new Error(`Runtime link escapes bundle: ${relative(root, file)} -> ${target}`);
        if (!inside(root, await realpath(file))) throw new Error(`Runtime link resolves outside bundle: ${relative(root, file)}`);
        links.push({ path: relative(root, file), target });
      } else if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(root);
  return links;
}

export async function copyRuntimeDirectory(source, destination) {
  await auditRuntimeLinks(source);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['scenes', '.portable-profile'].includes(entry.name)) throw new Error(`User data must not be embedded in the runtime: ${entry.name}`);
    const target = join(destination, entry.name), id = randomUUID();
    const incoming = join(destination, `.runtime-incoming-${id}`), backup = join(destination, `.runtime-previous-${id}`);
    let replaced = false, published = false;
    try {
      // Node's default cp resolves relative symlinks against source, producing
      // absolute /home/... paths. Preserve their literal targets instead.
      await cp(join(source, entry.name), incoming, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      if (entry.isDirectory()) await auditRuntimeLinks(incoming);
      try { await lstat(target); await rename(target, backup); replaced = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { await rename(incoming, target); published = true; }
      catch (e) { if (replaced) { await rename(backup, target); replaced = false; } throw e; }
    } finally {
      await rm(incoming, { recursive: true, force: true });
      // rm of a symlink removes only the link, including an old absolute link.
      if (published && replaced) await rm(backup, { recursive: true, force: true });
    }
  }
}
