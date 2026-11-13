/**
 * Decode VMID bytes the way the app should: SolidCAM VMIDs are often
 * ISO-8859-1 (declared in the XML prolog or a leading comment), others UTF-8.
 * Test helper only (Node Buffer).
 */
export function decodeVmid(buf: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(buf.subarray(0, 200))
  if (/encoding\s*=\s*"(ISO-8859-1|latin1)"/i.test(head)) return new TextDecoder('latin1').decode(buf)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}
