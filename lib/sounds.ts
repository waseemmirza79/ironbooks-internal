/**
 * SNAP sound effects — REMOVED.
 *
 * Audio cues were pulled: a sound would fire with nothing on screen explaining
 * why, which read as random. `playSound` is now a no-op and the sidebar mute
 * toggle is gone. The exports are kept as harmless stubs so the ~10 existing
 * call sites keep compiling without a sweeping edit.
 */

export type SoundEvent =
  | "client_graduated"
  | "scan_complete"
  | "finalize_failed"
  | "message_received";

/** No-op — sounds were removed. */
export function playSound(_event: SoundEvent): void {}

/** Kept as a stub; nothing plays anymore. */
export function isMuted(): boolean {
  return true;
}
export function setMuted(_muted: boolean): void {}
export function onMutedChange(_cb: (muted: boolean) => void): () => void {
  return () => {};
}
