import { Buffer } from 'node:buffer';

/**
 * Disable Node's shared Buffer pool for this process.
 *
 * Why: mqtt-packet (as of 9.0.2) caches one small Buffer per distinct MQTT
 * remaining-length in a module-private map that is never evicted. Those
 * buffers come from `Buffer.allocUnsafe`, so they are slices of the shared
 * pool and each cached entry pins a whole pool block (64 KiB on Node 24).
 * The cache grows for the life of the process. With `poolSize = 0` every
 * allocation owns its backing store, so a cached entry pins only its own bytes.
 *
 * Cost: small allocations are no longer pooled, which is negligible at MQTT
 * message rates.
 *
 * Call from the process entry point only, never from library code: this
 * mutates a process global.
 *
 * Remove once a fixed mqtt-packet ships.
 * Upstream: https://github.com/mqttjs/mqtt-packet/issues/163 (fix: PR #164).
 */
export function disableBufferPool(): void {
  Buffer.poolSize = 0;
  // Node only pools when size < poolSize >>> 1, so 0 must mean "never pool".
  // Verify the observable effect rather than trusting the assignment.
  if (Buffer.allocUnsafe(4).buffer.byteLength !== 4) {
    throw new Error('[homerun] failed to disable the Buffer pool: small allocations are still pooled');
  }
}
