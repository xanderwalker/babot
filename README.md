# BaBot Lap Player

Video-clock replay of Max Verstappen's **2026 Singapore Grand Prix qualifying pole lap**, 1:31.373. The source is OpenF1 session 11384, driver 3, lap 11. The official F1 onboard drives the chassis, telemetry and USB pose stream. The Blender Twin Ribbon film follows that same lap clock. Its full 4,569-frame render is encoded and verified.

## Run locally

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5176/ in Chrome on this Mac. `npm run build` produces the static player; `npm test` runs the motion transport and clock tests.

The public official onboard is resolved from F1's browser playback catalog on each page load; signed CDN links are not stored. A local video can also be selected, kept entirely in the browser. Initial official-video lap start is **2.10 seconds**, visually checked against the timing stripe, broadcast lap clock and sector 1, approximately ±0.10s. Adjust sync is available for precise trimming.

## Replay and motion

- Play, pause, scrub, select a sector or change playback speed. The video is the master clock; a stalled video cannot continue hardware motion.
- The chassis exaggerates body movement visually: roll ×8 and pitch ×4. Physical roll/pitch limits remain separate and default to 1°/0.75°.
- To use BaBot, connect its Leonardo USB port, verify the firmware response, check video alignment, play the lap, then deliberately select Start motion.
- The existing car-to-plate calibration is 45°. Pose output is limited to a 20° vector, sent at up to 50 Hz with a single outstanding acknowledged command. UI limits are deliberately lower.
- Pause, seeking, buffering, page hiding, stale frames, disconnects and lap completion stop the session. STOP acknowledgement and the subsequent firmware EVENT OFF are tracked separately. No automatic rearming.
- The real source has gaps around 26.6–27.7 s, 50.54–51.68 s and 61.98–63.14 s. Motion stops there; resume explicitly afterward. The visual channels interpolate recorded telemetry while the motion model neutralizes invalid poses. The first 0.30 s and final 0.17 s are also outside valid motion coverage.
- Roll, pitch and G values are **derived cues from speed and approximate OpenF1 path**, not measured suspension or acceleration. Wheel rotation integrates recorded speed; suspension is visual only.

USB is allowed only on a secure top-level localhost page. The hosted version is a viewer; use the local player to drive the hardware. The transport passes mocked firmware tests. A six-second live USB test on the connected Leonardo verified firmware identity, ARM, all 301 low-angle POSE acknowledgements, STOP, and EVENT OFF. Test limits were 1° roll and 0.75° pitch with the existing 45° mounting calibration. This confirms controller behavior; visible mechanism movement requires observation.

## Chassis and suspension views

The gallery includes the original ten abstract chassis studies and six suspension variants:

| Study | What it shows |
| --- | --- |
| Load paths | Four fixed contacts and twin wishbones connected to a floating body plane. |
| Coil study | Exposed amber coils compressing around telescoping dampers. |
| Pushrod skeleton | Outboard pushrods, rotating rockers and inboard violet springs. |
| Section laboratory | Translucent cyan body slices and four exposed suspension corners. |
| Exploded suspension | Raised amber slices above an open ladder frame and orange coils. |
| X-ray flex | A nearly transparent blue shell with moving body-attachment markers. |

The default **Light chassis** is a sparse Tron-style F1 outline with a helmet sphere, wide tires, and small inboard pushrod springs. Rear tires are wider than fronts. The camera starts behind the car, and exaggerated visual roll leans toward the outside of each turn. The original studies remain available in the gallery.

Drag the chassis to inspect it. In suspension views, the wheel contacts stay on the ground while body attachments, wishbones, dampers and springs articulate. This is a schematic visualization, not measured damper travel or a complete mechanical simulation.

**Preview suspension flex** pauses the lap and requests a hardware stop, then animates the visual model from a separate demonstration clock. It cannot arm or stream poses to BaBot, even when USB remains connected. Returning to lap playback does not restart hardware motion; Start motion remains an explicit action.

## Blender ribbon

The continuous Twin Ribbon film is complete: 810×720, 50 fps, 4,569 frames, 91.38 seconds, and 10,873,262 bytes. Frame count, dimensions, duration and a full decode pass before the encoder publishes `public/media/ribbon.json`. The film follows onboard lap position and playback speed; a stalled onboard pauses the follower.

Reproduce from the parent `babot` directory with Blender and FFmpeg installed:

```sh
/usr/bin/caffeinate -i /Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup --python-exit-code 1 \
  --python web-player/scripts/blender/render_singapore_2026.py -- \
  --output web-player/media/singapore-2026-corkscrew-full \
  --samples 16 --progress web-player/public/media/ribbon-progress.json
node web-player/scripts/encode-blender-ribbon.mjs
```

Render settings and source hashes are recorded in `media/singapore-2026-corkscrew-full/render-manifest.json`; encoding checks are in `encoded-verification.json` beside it. The first 0.12 seconds and final 0.092 seconds hold the nearest recorded sample, and empty initial ribbon history stays hidden.

## Sources and assets

- [Official qualifying results](https://www.formula1.com/en/results/2026/races/1296/singapore/qualifying)
- [Official onboard](https://www.formula1.com/en/video/onboard-max-verstappens-2026-pirelli-pole-position-award-lap-at-the-singapore-grand-prix.1878677458343183007)
- [OpenF1](https://openf1.org/docs/)
- Raw fixture, exact timestamp window, result verification and request URLs: `data/openf1-singapore-2026-verstappen-pole.json`.
- Fetcher: `scripts/fetch-singapore-2026-pole.mjs`. Public media resolver: `src/media-source.ts`.
- Derived motion model and calibration preserve the previous Lapform/BaBot implementation in the adjacent F1 project.
- Blender rendering uses the established continuous Twin Ribbon workflow, with a fresh render of this lap. Generated media is ignored by Git; the render manifest and scripts document reproduction. The verified web film is bundled in the static deployment.

F1 media remains on its official CDN. This project does not redistribute the downloaded onboard. The official service may change availability; the local-video picker remains available.
