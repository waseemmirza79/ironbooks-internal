# SNAP sound effects

Drop mp3 or wav files here matching the exact filenames below. The player
in `lib/sounds.ts` looks them up by path. Missing files fail silently —
playback just no-ops, no console errors, no broken UX.

| Filename                  | When it plays                                                     |
|---------------------------|-------------------------------------------------------------------|
| `client-graduated.mp3`    | Kanban: client moves from Onboarding → Month-over-month (close-cleanup) |
| `scan-complete.mp3`       | Any scan finishes: UF Audit, Uncat Income Recovery, AI BS analyze |
| `finalize-failed.mp3`     | Finalize → QBO had partial/full failure (one or more items failed) |

## Suggested sources

- **Pixabay Sound Effects** — royalty-free, no attribution required: https://pixabay.com/sound-effects/
- **Freesound.org** — large library, varied licenses (check each)
- **Mixkit** — free with no attribution: https://mixkit.co/free-sound-effects/

## Vibe guidance

- **client-graduated**: triumphant — short fanfare, level-up chime, cash register. 1–2s. This is *the* satisfying moment in bookkeeper-land.
- **scan-complete**: subtle — single soft chime, two-note ding, or a gentle pop. <1s. Plays often, so should never grate.
- **finalize-failed**: a low, dissonant tone or short buzz. Not alarming, but distinct enough to make the bookkeeper look. <1s.

## File format

- Prefer **mp3** (universal browser support, small files)
- Keep under **100KB each** if possible — they're loaded on demand but a 5MB sound is silly
- Normalize volume so they're comparable to each other; the player drops volume to 0.5 automatically

## Adding new event sounds

1. Add a new entry to `SOUND_FILES` in `lib/sounds.ts`
2. Drop the file here matching that filename
3. Call `playSound("your_new_event")` from the relevant client component
