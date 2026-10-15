"""Render the Twin Ribbon cinematic as a deterministic Eevee frame sequence.

Single-session animation renderer for the mirrored throttle ribbon. The stage,
lighting, camera, and materials are built once; only the ribbon mesh is rebuilt
per frame (numpy + foreach_set), then one still is rendered per frame. Frame f
shows telemetry time f / fps, so a 50 fps sequence advances in lockstep with
the 50 Hz resampled telemetry and maps 1:1 onto the 50 fps onboard footage.

The geometry math intentionally mirrors twin_ribbon_cinematic.py station for
station so an animation frame at time T matches the approved still at time T.

Run from the repository root:

  /opt/homebrew/bin/blender --background --factory-startup \
    --python blender/twin_ribbon_animation.py -- \
    --data public/data/features/openf1-singapore-2025-russell-pole.json \
    --frames-dir "/Volumes/Rocket_XTRM/.../frames-16x9"

Already-rendered frames are skipped, so an interrupted render resumes by
re-running the same command.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time as clock
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import twin_ribbon_cinematic as base


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=base.DATA_PATH)
    parser.add_argument("--frames-dir", type=Path, required=True)
    parser.add_argument("--fps", type=int, default=50)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1010)
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--cam-loc", type=float, nargs=3, default=(0.0, -12.3, 5.20))
    parser.add_argument("--cam-target", type=float, nargs=3, default=(0.0, 17.0, 0.80))
    parser.add_argument("--lens", type=float, default=24.0)
    parser.add_argument(
        "--subsurf-render-levels",
        type=int,
        default=2,
        help="Render-time Catmull-Clark levels on the ribbon (the approved still used 2).",
    )
    parser.add_argument("--start-frame", type=int, default=1)
    parser.add_argument("--end-frame", type=int, default=0, help="0 means the full lap.")
    parser.add_argument(
        "--blend-output",
        type=Path,
        default=None,
        help="Optional editable .blend snapshot saved at the final rendered frame.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Re-render frames whose PNG already exists instead of skipping.",
    )
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def gaussian_smooth_np(values: np.ndarray, radius_samples: int) -> np.ndarray:
    """Numpy twin of base.gaussian_smooth: edge-clamped gaussian window."""
    if radius_samples <= 0 or values.size < 2:
        return values.astype(np.float64, copy=True)
    sigma = max(1.0, radius_samples / 2.15)
    offsets = np.arange(-radius_samples, radius_samples + 1, dtype=np.float64)
    weights = np.exp(-0.5 * (offsets / sigma) ** 2)
    weights /= weights.sum()
    padded = np.pad(values.astype(np.float64), radius_samples, mode="edge")
    return np.convolve(padded, weights, mode="valid")


def rpm_color_np(rpm: np.ndarray) -> np.ndarray:
    """Numpy twin of base.rpm_color, returning (N, 4) RGBA."""
    yellow = np.array((1.0, 0.69, 0.015))
    orange = np.array((1.0, 0.19, 0.005))
    red = np.array((0.94, 0.002, 0.018))

    low_amount = np.clip((rpm - 7_000.0) / 2_500.0, 0.0, 1.0)[:, None]
    high_amount = np.clip((rpm - 9_500.0) / 2_000.0, 0.0, 1.0)[:, None]
    low_rgb = yellow + (orange - yellow) * low_amount
    high_rgb = orange + (red - orange) * high_amount
    rgb = np.where((rpm <= 9_500.0)[:, None], low_rgb, high_rgb)
    return np.concatenate([rgb, np.ones((rpm.size, 1))], axis=1)


def smoothstep_np(edge0: float, edge1: float, values: np.ndarray) -> np.ndarray:
    amount = np.clip((values - edge0) / max(edge1 - edge0, 1e-9), 0.0, 1.0)
    return amount * amount * (3.0 - 2.0 * amount)


class StationCache:
    """Caches per-station raw telemetry so each lap time is sampled once.

    Station times repeat across frames (frame f adds one new station at
    t = f / fps and shifts the rest), so sample_at results are memoized by
    microsecond-rounded time.
    """

    def __init__(self, samples):
        self.samples = samples
        self.source_times = [row["t"] for row in samples]
        self.cache: dict[int, tuple[float, float, float, float]] = {}

    def row(self, requested_time: float) -> tuple[float, float, float, float]:
        key = round(requested_time * 1_000_000)
        hit = self.cache.get(key)
        if hit is None:
            sample = base.sample_at(self.samples, self.source_times, requested_time)
            hit = (sample["t"], sample["speed"], sample["rpm"], sample["throttle"])
            self.cache[key] = hit
        return hit


def station_arrays(cache: StationCache, frame: int, fps: int):
    """Newest-first station arrays, matching base.telemetry_history exactly.

    Station times use exact integer arithmetic — (frame*50 - index*fps) over one
    denominator — so every run (any --start-frame) produces bit-identical times.
    This pins the gear-change interpolation branch at amount==0.5 stations,
    which 1-ulp float noise would otherwise decide differently per run.
    """
    first_time = cache.source_times[0]
    last_time = cache.source_times[-1]
    elapsed = min(max(frame / fps, first_time), last_time)
    count = max(2, int(math.ceil((elapsed - first_time) * base.SAMPLE_RATE_HZ)) + 1)
    denominator = fps * base.SAMPLE_RATE_HZ
    times = [
        max(first_time, (frame * base.SAMPLE_RATE_HZ - index * fps) / denominator)
        for index in range(count)
    ]
    times[-1] = first_time

    rows = [cache.row(t) for t in times]
    t_arr = np.array([row[0] for row in rows])
    speed = np.array([row[1] for row in rows])
    rpm = np.array([row[2] for row in rows])
    throttle = np.array([row[3] for row in rows])

    smooth_speed = gaussian_smooth_np(speed, radius_samples=25)
    smooth_throttle = gaussian_smooth_np(throttle, radius_samples=60)
    age = elapsed - t_arr
    return elapsed, t_arr, rpm, smooth_speed, smooth_throttle, age


ACROSS = 17
U = np.linspace(0.0, 1.0, ACROSS)
CROWN = 0.14 * np.sin(math.pi * U) ** 1.35
EDGE_ROLL = -0.035 * ((np.abs(U - 0.5) * 2.0) ** 5)


def build_ribbon_mesh(name, t_arr, rpm, smooth_speed, smooth_throttle, age, material):
    stations = t_arr.size
    width = base.WIDTH_MIN + base.WIDTH_SPAN * np.clip(smooth_throttle / 100.0, 0.0, 1.0) ** 0.75
    base_z = 0.35 + 6.0 * smoothstep_np(25.0, 305.0, smooth_speed) ** 1.25
    y = base.Y_NEAR + age * base.DEPTH_PER_SECOND

    x_grid = base.INNER_EDGE_X + width[:, None] * U[None, :]
    y_grid = np.broadcast_to(y[:, None], (stations, ACROSS))
    z_grid = base_z[:, None] + (CROWN + EDGE_ROLL)[None, :]
    coordinates = np.stack([x_grid, y_grid, z_grid], axis=-1).astype(np.float32).ravel()

    quad_count = (stations - 1) * (ACROSS - 1)
    corner = np.arange(stations - 1)[:, None] * ACROSS + np.arange(ACROSS - 1)[None, :]
    loops = np.stack([corner, corner + 1, corner + ACROSS + 1, corner + ACROSS], axis=-1)
    loops = loops.astype(np.int32).ravel()

    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(stations * ACROSS)
    mesh.vertices.foreach_set("co", coordinates)
    mesh.loops.add(quad_count * 4)
    mesh.loops.foreach_set("vertex_index", loops)
    mesh.polygons.add(quad_count)
    mesh.polygons.foreach_set("loop_start", np.arange(quad_count, dtype=np.int32) * 4)
    mesh.polygons.foreach_set("loop_total", np.full(quad_count, 4, dtype=np.int32))
    mesh.polygons.foreach_set("use_smooth", np.ones(quad_count, dtype=bool))
    mesh.update(calc_edges=True)
    mesh.validate()

    colors = np.repeat(rpm_color_np(rpm), ACROSS, axis=0).astype(np.float32).ravel()
    color_attribute = mesh.color_attributes.new(name="rpm_color", type="FLOAT_COLOR", domain="POINT")
    color_attribute.data.foreach_set("color", colors)

    for attribute_name, values in (
        ("sample_time", t_arr),
        ("throttle_pct", smooth_throttle),
        ("speed_kph", smooth_speed),
    ):
        attribute = mesh.attributes.new(attribute_name, "FLOAT", "POINT")
        attribute.data.foreach_set("value", np.repeat(values, ACROSS).astype(np.float32))

    mesh.materials.append(material)
    return mesh


def configure_render(scene, args, info, source_label):
    scene.frame_start = 1
    scene.frame_end = 1
    scene.render.fps = args.fps
    scene.render.resolution_x = max(320, args.width)
    scene.render.resolution_y = max(180, args.height)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False

    scene.render.engine = "BLENDER_EEVEE"
    try:
        scene.eevee.taa_render_samples = max(64, args.samples * 2)
        scene.eevee.use_raytracing = True
        scene.eevee.ray_tracing_method = "SCREEN"
    except (AttributeError, TypeError):
        pass

    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.0003, 0.00015, 0.00008, 1.0)
    background.inputs["Strength"].default_value = 0.003

    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.20
    scene.view_settings.gamma = 1.0

    scene["visualizer"] = "twin-ribbon-animation"
    scene["telemetry_driver"] = info["driver_name"]
    scene["telemetry_event"] = info["event_name"]
    scene["telemetry_date"] = info["event_date"]
    scene["telemetry_source"] = source_label
    scene["render_intent"] = f"{args.fps} fps Eevee animation sequence"


def main():
    args = parse_args()
    data_path = args.data if args.data.is_absolute() else base.ROOT / args.data
    try:
        source_label = str(data_path.relative_to(base.ROOT))
    except ValueError:
        source_label = str(data_path)
    frames_dir = args.frames_dir.resolve()
    frames_dir.mkdir(parents=True, exist_ok=True)

    base.clear_scene()
    info, samples = base.load_dataset(data_path)
    cache = StationCache(samples)
    last_time = cache.source_times[-1]
    total_frames = int(math.ceil(last_time * args.fps))
    end_frame = args.end_frame if args.end_frame > 0 else total_frames
    end_frame = min(end_frame, total_frames)

    manifest_path = frames_dir / "render-manifest.json"
    manifest = {
        "data": source_label,
        "fps": args.fps,
        "width": args.width,
        "height": args.height,
        "samples": args.samples,
        "subsurf_render_levels": args.subsurf_render_levels,
        "cam_loc": list(args.cam_loc),
        "cam_target": list(args.cam_target),
        "lens": args.lens,
        "total_frames": total_frames,
    }
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text())
        if existing != manifest:
            print(
                "FATAL: frames dir was rendered with different settings:\n"
                f"  existing: {existing}\n  requested: {manifest}\n"
                "Use a fresh --frames-dir (or delete the old frames + manifest).",
                flush=True,
            )
            sys.exit(1)
    else:
        manifest_path.write_text(json.dumps(manifest, indent=1))

    scene = bpy.context.scene
    configure_render(scene, args, info, source_label)

    # Build the persistent scene: first-frame ribbon via the approved code path
    # keeps the object, modifier stack, and custom properties identical.
    _, first_history = base.telemetry_history(samples, args.start_frame / args.fps)
    ribbon = base.create_ribbon_pair(first_history, source_label)
    ribbon.modifiers["Liquid Continuity"].render_levels = args.subsurf_render_levels
    material = base.create_latex_material()
    ribbon.data.materials.append(material)
    base.create_stage()
    base.create_lighting()
    base.create_camera(scene, args.cam_loc, args.cam_target, args.lens)

    print(
        f"Twin Ribbon animation: {info['driver_name']} — {info['event_name']} | "
        f"frames {args.start_frame}-{end_frame} of {total_frames} at {args.fps} fps | "
        f"{scene.render.resolution_x}x{scene.render.resolution_y}",
        flush=True,
    )

    rendered = 0
    skipped = 0
    last_built_frame = args.start_frame
    loop_started = clock.monotonic()
    for frame in range(args.start_frame, end_frame + 1):
        output_path = frames_dir / f"frame-{frame:06d}.png"
        if not args.overwrite and output_path.exists() and output_path.stat().st_size > 0:
            skipped += 1
            continue

        elapsed, t_arr, rpm, smooth_speed, smooth_throttle, age = station_arrays(
            cache, frame, args.fps
        )
        new_mesh = build_ribbon_mesh(
            f"Twin Ribbon Frame {frame}", t_arr, rpm, smooth_speed, smooth_throttle, age, material
        )
        old_mesh = ribbon.data
        ribbon.data = new_mesh
        bpy.data.meshes.remove(old_mesh)

        scene["telemetry_elapsed_s"] = elapsed
        # Render to a temp name, then atomically publish: resume can then trust
        # any frame-*.png that exists.
        tmp_path = frames_dir / f".tmp-frame-{frame:06d}.png"
        scene.render.filepath = str(tmp_path)
        bpy.ops.render.render(write_still=True)
        os.replace(tmp_path, output_path)
        rendered += 1
        last_built_frame = frame

        if rendered == 1 or rendered % 25 == 0 or frame == end_frame:
            average = (clock.monotonic() - loop_started) / rendered
            remaining = (end_frame - frame) * average
            print(
                f"frame {frame}/{end_frame} t={elapsed:7.3f}s stations={t_arr.size:4d} "
                f"avg={average:5.2f}s/frame eta={remaining / 3600:5.2f}h",
                flush=True,
            )

    if args.blend_output is not None:
        if last_built_frame != end_frame:
            # A fully-skipped resume run never rebuilt the mesh; snapshot the
            # documented final-frame state before saving.
            _, t_arr, rpm, smooth_speed, smooth_throttle, age = station_arrays(
                cache, end_frame, args.fps
            )
            final_mesh = build_ribbon_mesh(
                f"Twin Ribbon Frame {end_frame}", t_arr, rpm, smooth_speed, smooth_throttle, age, material
            )
            old_mesh = ribbon.data
            ribbon.data = final_mesh
            bpy.data.meshes.remove(old_mesh)
        blend_path = args.blend_output if args.blend_output.is_absolute() else base.ROOT / args.blend_output
        blend_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_path.resolve()))
        print(f"Saved Blender scene: {blend_path.resolve()}", flush=True)

    print(
        f"Sequence complete: rendered {rendered}, skipped {skipped} existing, "
        f"frames in {frames_dir}",
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        import traceback

        traceback.print_exc()
        sys.stdout.flush()
        sys.exit(1)
