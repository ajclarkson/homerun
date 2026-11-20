import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { disableBufferPool } from './buffer-pool.js';

describe('disableBufferPool', () => {
  const original = Buffer.poolSize;
  afterEach(() => { Buffer.poolSize = original; });

  it('makes small allocations own their backing store', () => {
    Buffer.poolSize = 8192;
    expect(Buffer.allocUnsafe(4).buffer.byteLength).toBeGreaterThan(4);
    disableBufferPool();
    expect(Buffer.poolSize).toBe(0);
    expect(Buffer.allocUnsafe(4).buffer.byteLength).toBe(4);
  });
});
