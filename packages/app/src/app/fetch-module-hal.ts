import { MODULE_PENDING } from '@rebel-sim/engine';
import type { ModuleHal } from '@rebel-sim/engine';

/**
 * spec/01-HAL.md §6.7, M79: source modules for `NEEDS name` — `name.fth`
 * fetched from beside system.fth (public/), so precached for offline use
 * by the service worker's `/*.fth` rule like system.fth itself.
 *
 * The HAL read must not block, and fetch is asynchronous, so the first
 * read starts the fetch and answers "pending"; the engine suspends the
 * line (as KEY does) and `onSettled` wakes the pump when the fetch
 * finishes, so the next read gets the bytes, or `undefined` for a module
 * that doesn't exist. A result is handed out once and forgotten, so a
 * later NEEDS of the same name (after EMPTY) fetches afresh.
 */
export class FetchModuleHal implements ModuleHal {
  private readonly results = new Map<string, Uint8Array | null | typeof MODULE_PENDING>();

  constructor(private readonly onSettled: () => void) {}

  read(name: string): Uint8Array | undefined | typeof MODULE_PENDING {
    const result = this.results.get(name);
    if (result === MODULE_PENDING) return MODULE_PENDING;
    if (result !== undefined) {
      this.results.delete(name);
      return result ?? undefined;
    }
    // Letters and digits only, plus at most one extension (M86): a module
    // name never becomes a path.
    if (!/^[A-Z0-9]{1,8}(\.[A-Z0-9]{1,3})?$/.test(name)) return undefined;
    this.results.set(name, MODULE_PENDING);
    void this.fetchModule(name);
    return MODULE_PENDING;
  }

  private async fetchModule(name: string): Promise<void> {
    let bytes: Uint8Array | null = null;
    try {
      // NAME is NAME.fth, source; NAME.EXT is a file as named (M86).
      const file = name.includes('.') ? name.toLowerCase() : `${name.toLowerCase()}.fth`;
      const response = await fetch(file);
      // A dev server answers an unknown path with index.html and 200.
      const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
      if (response.ok && !isHtml) {
        bytes = new Uint8Array(await response.arrayBuffer());
      }
    } catch {
      bytes = null;
    }
    this.results.set(name, bytes);
    this.onSettled();
  }
}
