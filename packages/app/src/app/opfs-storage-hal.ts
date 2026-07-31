/**
 * The Origin Private File System-backed StorageHal (PORTING-WEB.md §5:
 * OPFS over IndexedDB — real directory/file handles are the closer
 * conceptual match to docs/STORAGE.md's `/PROJECTS/<name>/asset.ext`
 * shape than a flat key-value store). The engine never touches OPFS (or
 * any DOM API) directly — this is the one place that translates
 * Storage's POSIX-style absolute paths into `getDirectoryHandle`/
 * `getFileHandle` calls.
 */

import { StorageHal } from '@rebel-sim/engine';

export class OpfsStorageHal implements StorageHal {
  private root: Promise<FileSystemDirectoryHandle> | undefined;

  private getRoot(): Promise<FileSystemDirectoryHandle> {
    this.root ??= navigator.storage.getDirectory();
    return this.root;
  }

  private async resolveDir(
    path: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | undefined> {
    let dir = await this.getRoot();
    for (const part of path.split('/').filter(Boolean)) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch {
        return undefined;
      }
    }
    return dir;
  }

  private splitPath(path: string): { dirPath: string; filename: string } {
    const idx = path.lastIndexOf('/');
    return { dirPath: path.slice(0, idx), filename: path.slice(idx + 1) };
  }

  async ensureDir(path: string): Promise<void> {
    await this.resolveDir(path, true);
  }

  async listFiles(path: string): Promise<string[]> {
    const dir = await this.resolveDir(path, false);
    if (!dir) {
      return [];
    }
    const names: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        names.push(name);
      }
    }
    return names;
  }

  async readFile(path: string): Promise<Uint8Array | undefined> {
    const { dirPath, filename } = this.splitPath(path);
    const dir = await this.resolveDir(dirPath, false);
    if (!dir) {
      return undefined;
    }
    try {
      const handle = await dir.getFileHandle(filename);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return undefined;
    }
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const { dirPath, filename } = this.splitPath(path);
    const dir = await this.resolveDir(dirPath, true);
    if (!dir) {
      throw new Error(`cannot create directory for ${path}`);
    }
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes.slice().buffer);
    await writable.close();
  }
}

/** Feature-detects OPFS support — returns undefined (falling back to the
 * engine's NULL_STORAGE_HAL) in environments without it, e.g. jsdom in
 * unit tests, or older browsers. */
export function createOpfsStorageHalIfSupported(): OpfsStorageHal | undefined {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) {
    return undefined;
  }
  if (typeof navigator.storage.getDirectory !== 'function') {
    return undefined;
  }
  return new OpfsStorageHal();
}
