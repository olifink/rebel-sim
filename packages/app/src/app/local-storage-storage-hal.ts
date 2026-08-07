/**
 * A localStorage-backed StorageHal — synchronous, unlike the OPFS
 * backend this replaces (PORTING-WEB.md §5's original choice). OPFS
 * forced storage.ts's whole shape to be Promise-based, which leaked all
 * the way up into the engine's core execution model (repl.ts used to
 * carry a dedicated 'storage' StepStatus just so a running Forth line
 * could suspend itself around a real disk write) — even though real
 * hardware's own storage access (Rebel-ROM's CStorageModule, bare-metal
 * blocking FAT/USB I/O) is ordinary synchronous host code with no async
 * concept at all. That was a browser-platform artifact dictating the
 * shared cross-target engine contract, not a genuine requirement — see
 * DEVELOPING.md's storage section for the fuller reasoning.
 *
 * localStorage is a real, ordinary Web Storage API: synchronous, no
 * Promises, no Worker needed, ships in every browser, and persists
 * across reloads — trading OPFS's larger capacity (browsers typically
 * cap an origin's localStorage well under OPFS's effective disk-backed
 * quota) and native directory model for a shape that lets
 * PROJECT/SAVE/RESTORE/BSAVE/BLOAD be genuine dictionary primitives
 * again, usable inside a colon-definition or via EXECUTE like any other
 * word. Rebel's own bank sizes (four-to-few-hundred KB size classes)
 * are nowhere near what would actually bind on that quota in practice.
 *
 * The engine's POSIX-style absolute paths (e.g.
 * `/PROJECTS/<name>/<asset>.<ext>`) become flat localStorage keys under
 * one namespace prefix — there's no real directory hierarchy to create
 * (`ensureDir` is a no-op), "listing a directory" is a linear scan over
 * localStorage's own keys filtered by prefix, and binary payloads are
 * base64-encoded (localStorage only ever stores strings).
 */

import { StorageHal } from '@rebel-sim/engine';

const KEY_PREFIX = 'rebel-sim:';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // btoa needs a "binary string" (one char per byte, 0-255) — built in
  // chunks rather than String.fromCharCode(...bytes) directly, which
  // overflows the call stack well within reach of Rebel's larger bank
  // size classes.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class LocalStorageStorageHal implements StorageHal {
  ensureDir(): void {
    // Flat key namespace — nothing to create ahead of a write.
  }

  listFiles(path: string): string[] {
    const prefix = KEY_PREFIX + (path.endsWith('/') ? path : path + '/');
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes('/')) names.push(rest); // files only, no subdirectories
    }
    return names;
  }

  readFile(path: string): Uint8Array | undefined {
    const raw = localStorage.getItem(KEY_PREFIX + path);
    return raw === null ? undefined : base64ToBytes(raw);
  }

  writeFile(path: string, bytes: Uint8Array): void {
    // A real quota-exceeded error propagates as-is, same "authentic
    // risk, no host-side validation" stance as e.g. MMAP's raw writes —
    // it surfaces through the ordinary Forth `? <message>` error path,
    // not a special case here.
    localStorage.setItem(KEY_PREFIX + path, bytesToBase64(bytes));
  }
}

/** Feature-detects localStorage support — returns undefined (falling
 * back to the engine's NULL_STORAGE_HAL) in environments without it,
 * e.g. jsdom in some configurations, or a privacy mode that throws on
 * access instead of omitting the global entirely. */
export function createLocalStorageHalIfSupported(): LocalStorageStorageHal | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }
  try {
    const probeKey = `${KEY_PREFIX}__probe__`;
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
  } catch {
    return undefined;
  }
  return new LocalStorageStorageHal();
}
