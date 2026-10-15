# 2026 Twin Ribbon batch

Run commands from `web-player`. The batch reads verified pole fixtures from
`public/data/2026/*.json`. It preserves the Singapore production scene and
continuous captured-history dynamics: Eevee, 810 × 720, 16 samples, 50 fps.
Existing Singapore playback files and its original scripts stay available.

```sh
# Inspect events, timing, and the estimated local render duration.
node scripts/render-season-ribbons.mjs

# Render all imported laps; exact matching completed output is verified and skipped.
node scripts/render-season-ribbons.mjs --render

# Render one event, or test the first bounded chunk.
node scripts/render-season-ribbons.mjs --render --event australia
node scripts/render-season-ribbons.mjs --render --event australia --max-chunks 1

# Count frames, verify codec/timing/identity, and decode already published films.
node scripts/render-season-ribbons.mjs --verify-only

# Pause safely after the current chunk; remove STOP to resume with --render.
touch media/2026/STOP
```

Set `BLENDER_BIN` or pass `--blender /absolute/path/to/Blender` on another host.
`ffmpeg` and `ffprobe` must be available on PATH. Blender's installed Python must
have NumPy (the existing local installation does).

Each event writes `public/media/2026/<event>/ribbon-progress.json`. A ready
`ribbon.json` appears only after the whole film passes identity, frame count,
duration, dimensions, codec, SHA-256, and full-decoding checks. The manifest
identifies the exact dataset, qualifying session, driver, and lap. It records
leading/trailing measured-endpoint holds; source data remains unchanged.

Temporary render state lives in `media/2026/<event>`. The batch renders 500-frame
chunks, encodes and fully decodes each segment, saves a receipt, then removes
only that chunk's generated PNGs. An interrupted chunk is rerendered; completed
verified segments are reused. The batch refuses to resume after source, render
code, or production settings change. Preserve the old directory and start in a
fresh one when intentionally changing those inputs. Completed segment files
remain available for repair and concatenation.

The batch starts no new chunk with less than 3 GiB of free disk and keeps a
single-process lock in `media/2026/.render-lock`. After a forced interruption,
inspect `owner.json` and verify that its process and Blender children have
stopped before removing this lock. The STOP file allows normal cleanup.

Singapore is adopted from the existing production MP4 only if measured car
samples, source session, driver, lap, duration and the encoded contract match.
It is decoded and hashed again before publication in the season library.

Machine render time is separate from Codex account usage. The original Singapore
film took 40.2 minutes for 4,569 frames on this Mac. A local process can continue
without active model calls; background rendering is not evidence of completion.
Check each event's ready manifest and final verification receipt before claiming
its film is available. No script connects to BaBot or moves hardware.
