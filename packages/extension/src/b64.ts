/**
 * Bytes → base64 without spreading the whole buffer into one call.
 *
 * The owner's first verdict: the screenshot came through as
 * `screenshotError: "Maximum call stack size exceeded"`. The worker had been
 * doing `String.fromCharCode(...bytes)` on the downscaled JPEG, which hands
 * the engine one argument per byte; a Retina capture re-encoded at 1568 wide
 * is a few hundred thousand of them, past the argument limit. The e2e never
 * hit it because its window is narrower than the cap, so the original
 * data-URL was passed through and nothing was ever re-encoded.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}
