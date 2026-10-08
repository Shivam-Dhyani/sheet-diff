import { SheetDiffError } from '../errors.js';

/**
 * Decrypt an encrypted OOXML/.xls container to its plaintext bytes.
 *
 * Wraps `officecrypto-tool` (TDD §4), loaded lazily so the engine works
 * without it (the module is an optional dependency and is not needed for the
 * compare-only path). When it is absent, callers get `ENCRYPTION_UNSUPPORTED`,
 * which the UI maps to the "save an unprotected copy" guidance (FR-IN-05).
 *
 * The password is held only in this local scope for the duration of the call
 * and is never stored or logged (TDD §7.1 step 2, §14).
 */
export async function decrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  let mod: unknown;
  try {
    // Indirect specifier so the optional dependency is not statically resolved
    // at build/typecheck time (it may be absent — see IMPLEMENTATION_NOTES.md).
    const specifier = 'officecrypto-tool';
    mod = await import(specifier);
  } catch {
    throw new SheetDiffError(
      'ENCRYPTION_UNSUPPORTED',
      'Decryption support is not available in this build.',
    );
  }

  const decryptFn = resolveDecryptFn(mod);
  if (!decryptFn) {
    throw new SheetDiffError('ENCRYPTION_UNSUPPORTED', 'Unsupported encryption scheme.');
  }

  try {
    const input = toBuffer(bytes);
    const out = (await decryptFn(input, { password })) as Uint8Array | ArrayBuffer;
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/password|incorrect|invalid/i.test(msg)) {
      throw new SheetDiffError('PASSWORD_WRONG', 'That password did not open the file.');
    }
    throw new SheetDiffError('ENCRYPTION_UNSUPPORTED', 'This protection type is not supported.', {
      cause: msg,
    });
  }
}

type DecryptFn = (input: unknown, opts: { password: string }) => Promise<Uint8Array | ArrayBuffer>;

function resolveDecryptFn(mod: unknown): DecryptFn | null {
  const m = mod as Record<string, unknown> & { default?: Record<string, unknown> };
  const candidate = m?.decrypt ?? m?.default?.decrypt;
  return typeof candidate === 'function' ? (candidate as DecryptFn) : null;
}

/** officecrypto-tool expects a Node Buffer when running under Node. */
function toBuffer(bytes: Uint8Array): Uint8Array {
  const g = globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } };
  return g.Buffer ? g.Buffer.from(bytes) : bytes;
}
