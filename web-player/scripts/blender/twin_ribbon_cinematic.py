"""Build a cinematic, telemetry-driven Twin Ribbon scene in Blender.

The scene is an editable Blender counterpart to the interactive Three.js route.
It uses the real Kevin Magnussen 2024 Canadian Grand Prix opening-lap fixture and
keeps the requested visual grammar:

  throttle -> ribbon width
  speed    -> ribbon height
  RPM      -> yellow-to-red color
  time     -> depth toward the horizon

Run from the repository root:

  /opt/homebrew/bin/blender --background --factory-startup \
    --python blender/twin_ribbon_cinematic.py -- --time 56.928
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "public/data/features/2024-canadian-grand-prix-magnussen-opening-lap.json"
OUTPUT_DIR = ROOT / "blender/output"

SAMPLE_RATE_HZ = 50
DEFAULT_TIME_SECONDS = 56.928
DEFAULT_WIDTH = 1730
DEFAULT_HEIGHT = 909

Y_NEAR = -13.3
DEPTH_PER_SECOND = 2.2
INNER_EDGE_X = 0.85
WIDTH_MIN = 3.0
WIDTH_SPAN = 4.0
FLOOR_Z = 0.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--time", type=float, default=DEFAULT_TIME_SECONDS)
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
    parser.add_argument(
        "--engine",
        choices=("eevee", "cycles"),
        default="eevee",
        help="Eevee is the quick approval renderer; Cycles is the final-quality path.",
    )
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument(
        "--data",
        type=Path,
        default=DATA_PATH,
        help="Telemetry fixture: legacy feature schema or openf1 carSamples schema.",
    )
    parser.add_argument("--cam-loc", type=float, nargs=3, default=(0.0, -12.3, 5.20))
    parser.add_argument("--cam-target", type=float, nargs=3, default=(0.0, 17.0, 0.80))
    parser.add_argument("--lens", type=float, default=24.0)
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_DIR / "twin-ribbon-approval.png",
    )
    parser.add_argument(
        "--blend-output",
        type=Path,
        default=OUTPUT_DIR / "lapform-twin-ribbon.blend",
    )
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, float(value)))


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    amount = clamp((value - edge0) / max(edge1 - edge0, 1e-9))
    return amount * amount * (3.0 - 2.0 * amount)


def mix(left: float, right: float, amount: float) -> float:
    return left + (right - left) * amount


def mix_color(left: tuple[float, float, float], right: tuple[float, float, float], amount: float):
    return tuple(mix(left[i], right[i], amount) for i in range(3))


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for data_collection in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for block in list(data_collection):
            if block.users == 0:
                data_collection.remove(block)


def load_dataset(data_path: Path):
    """Load either fixture schema and normalize to one sample shape.

    Legacy feature schema: drivers[0].samples rows of [t_s, speed, rpm,
    throttle, brake, gear, drs]. Newer openf1 dataset schema: carSamples rows
    of [tMs, speedKph, rpm, throttlePct, brakeOn, gear, drs] with meta.
    """
    with data_path.open() as source:
        dataset = json.load(source)

    if "carSamples" in dataset:
        meta = dataset["meta"]
        samples = [
            {
                "t": float(row[0]) / 1000.0,
                "speed": float(row[1]),
                "rpm": float(row[2]),
                "throttle": clamp(float(row[3]), 0.0, 100.0),
                "brake": 100.0 if float(row[4]) > 0 else 0.0,
                "gear": int(row[5]),
                "drs": row[6],
            }
            for row in dataset["carSamples"]
        ]
        info = {
            "driver_name": meta["driverName"],
            "event_name": meta["meetingName"],
            "event_date": meta["lapStartUtc"],
        }
    else:
        driver = dataset["drivers"][0]
        samples = [
            {
                "t": float(row[0]),
                "speed": float(row[1]),
                "rpm": float(row[2]),
                "throttle": clamp(float(row[3]), 0.0, 100.0),
                "brake": 100.0 if float(row[4]) > 0 else 0.0,
                "gear": int(row[5]),
                "drs": row[6],
            }
            for row in driver["samples"]
        ]
        info = {
            "driver_name": driver["name"],
            "event_name": dataset["meeting"]["name"],
            "event_date": dataset["meeting"]["date_start_utc"],
        }
    return info, samples


def sample_at(samples, sample_times, requested_time: float):
    if requested_time <= sample_times[0]:
        return dict(samples[0])
    if requested_time >= sample_times[-1]:
        return dict(samples[-1])

    upper = bisect.bisect_right(sample_times, requested_time)
    lower = upper - 1
    left = samples[lower]
    right = samples[upper]
    amount = (requested_time - left["t"]) / max(right["t"] - left["t"], 1e-9)
    gear_changed = left["gear"] != right["gear"]
    rpm = (
        left["rpm"] if amount < 0.5 else right["rpm"]
    ) if gear_changed else mix(left["rpm"], right["rpm"], amount)
    discrete = left if amount < 0.5 else right

    return {
        "t": requested_time,
        "speed": mix(left["speed"], right["speed"], amount),
        "rpm": rpm,
        "throttle": mix(left["throttle"], right["throttle"], amount),
        "brake": discrete["brake"],
        "gear": discrete["gear"],
        "drs": discrete["drs"],
    }


def gaussian_smooth(values: list[float], radius_samples: int) -> list[float]:
    if radius_samples <= 0:
        return list(values)
    sigma = max(1.0, radius_samples / 2.15)
    weights = [math.exp(-0.5 * (offset / sigma) ** 2) for offset in range(-radius_samples, radius_samples + 1)]
    output = []
    for index in range(len(values)):
        numerator = 0.0
        denominator = 0.0
        for offset, weight in zip(range(-radius_samples, radius_samples + 1), weights):
            source_index = max(0, min(len(values) - 1, index + offset))
            numerator += values[source_index] * weight
            denominator += weight
        output.append(numerator / max(denominator, 1e-9))
    return output


def telemetry_history(samples, elapsed: float):
    first_time = samples[0]["t"]
    last_time = samples[-1]["t"]
    elapsed = clamp(elapsed, first_time, last_time)
    count = max(2, int(math.ceil((elapsed - first_time) * SAMPLE_RATE_HZ)) + 1)
    times = [max(first_time, elapsed - index / SAMPLE_RATE_HZ) for index in range(count)]
    times[-1] = first_time
    source_times = [sample["t"] for sample in samples]
    history = [sample_at(samples, source_times, t) for t in times]

    speeds = gaussian_smooth([row["speed"] for row in history], radius_samples=25)
    throttles = gaussian_smooth([row["throttle"] for row in history], radius_samples=60)
    for row, speed, throttle in zip(history, speeds, throttles):
        row["smooth_speed"] = speed
        row["smooth_throttle"] = throttle
        row["age"] = elapsed - row["t"]
    return elapsed, history


def rpm_color(rpm: float) -> tuple[float, float, float, float]:
    yellow = (1.0, 0.69, 0.015)
    orange = (1.0, 0.19, 0.005)
    red = (0.94, 0.002, 0.018)
    if rpm <= 9_500:
        rgb = mix_color(yellow, orange, clamp((rpm - 7_000) / 2_500))
    else:
        rgb = mix_color(orange, red, clamp((rpm - 9_500) / 2_000))
    return (*rgb, 1.0)


def ribbon_width(throttle: float) -> float:
    return WIDTH_MIN + WIDTH_SPAN * (clamp(throttle / 100.0) ** 0.75)


def ribbon_height(speed: float) -> float:
    speed_amount = smoothstep(25.0, 305.0, speed) ** 1.25
    return 0.35 + 6.0 * speed_amount


def create_ribbon_pair(history, source_label: str):
    across_count = 17
    vertices: list[tuple[float, float, float]] = []
    colors: list[tuple[float, float, float, float]] = []
    sample_time: list[float] = []
    throttle_values: list[float] = []
    speed_values: list[float] = []
    faces: list[tuple[int, int, int, int]] = []

    for station_index, row in enumerate(history):
        width = ribbon_width(row["smooth_throttle"])
        y = Y_NEAR + row["age"] * DEPTH_PER_SECOND
        base_z = ribbon_height(row["smooth_speed"])
        color = rpm_color(row["rpm"])

        for across_index in range(across_count):
            u = across_index / (across_count - 1)
            x = INNER_EDGE_X + u * width
            crown = 0.14 * (math.sin(math.pi * u) ** 1.35)
            edge_roll = -0.035 * ((abs(u - 0.5) * 2.0) ** 5)
            vertices.append((x, y, base_z + crown + edge_roll))
            colors.append(color)
            sample_time.append(row["t"])
            throttle_values.append(row["smooth_throttle"])
            speed_values.append(row["smooth_speed"])

        if station_index:
            previous = (station_index - 1) * across_count
            current = station_index * across_count
            for across_index in range(across_count - 1):
                faces.append(
                    (
                        previous + across_index,
                        previous + across_index + 1,
                        current + across_index + 1,
                        current + across_index,
                    )
                )

    mesh = bpy.data.meshes.new("Twin Ribbon Telemetry Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()

    color_attribute = mesh.color_attributes.new(
        name="rpm_color",
        type="FLOAT_COLOR",
        domain="POINT",
    )
    for index, color in enumerate(colors):
        color_attribute.data[index].color = color

    for attribute_name, values in (
        ("sample_time", sample_time),
        ("throttle_pct", throttle_values),
        ("speed_kph", speed_values),
    ):
        attribute = mesh.attributes.new(attribute_name, "FLOAT", "POINT")
        for index, value in enumerate(values):
            attribute.data[index].value = value

    for polygon in mesh.polygons:
        polygon.use_smooth = True

    ribbon = bpy.data.objects.new("Twin Ribbon Pair", mesh)
    bpy.context.collection.objects.link(ribbon)

    mirror = ribbon.modifiers.new("Exact X Mirror", "MIRROR")
    mirror.use_axis[0] = True
    mirror.use_clip = False
    mirror.use_mirror_merge = False

    subdivision = ribbon.modifiers.new("Liquid Continuity", "SUBSURF")
    subdivision.subdivision_type = "CATMULL_CLARK"
    subdivision.levels = 1
    subdivision.render_levels = 2
    subdivision.boundary_smooth = "PRESERVE_CORNERS"

    solidify = ribbon.modifiers.new("Latex Thickness", "SOLIDIFY")
    solidify.thickness = 0.22
    solidify.offset = -1.0
    solidify.use_rim = True
    if hasattr(solidify, "use_even_offset"):
        solidify.use_even_offset = True

    ribbon["telemetry_source"] = source_label
    ribbon["sample_rate_hz"] = SAMPLE_RATE_HZ
    ribbon["throttle_mapping"] = "width"
    ribbon["speed_mapping"] = "height"
    ribbon["rpm_mapping"] = "yellow_to_red"
    ribbon["time_mapping"] = "depth_to_horizon"
    ribbon["mirror_axis"] = "X"
    return ribbon


def principled_material(name: str, base_color, roughness: float, metallic: float = 0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*base_color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return material


def create_latex_material():
    material = bpy.data.materials.new("RPM Wet Latex")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    vertex_color = nodes.new("ShaderNodeVertexColor")
    vertex_color.layer_name = "rpm_color"
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 5.0
    noise.inputs["Detail"].default_value = 2.0
    noise.inputs["Roughness"].default_value = 0.55
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.028
    bump.inputs["Distance"].default_value = 0.018

    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.085
    bsdf.inputs["IOR"].default_value = 1.45
    bsdf.inputs["Specular IOR Level"].default_value = 0.5
    bsdf.inputs["Coat Weight"].default_value = 1.0
    bsdf.inputs["Coat Roughness"].default_value = 0.025
    bsdf.inputs["Coat IOR"].default_value = 1.47
    bsdf.inputs["Sheen Weight"].default_value = 0.10
    bsdf.inputs["Transmission Weight"].default_value = 0.0
    bsdf.inputs["Emission Strength"].default_value = 0.22

    links.new(vertex_color.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(vertex_color.outputs["Color"], bsdf.inputs["Emission Color"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return material


def emissive_material(name: str, color, strength: float):
    material = principled_material(name, color, roughness=0.28)
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
    bsdf.inputs["Emission Strength"].default_value = strength
    return material


def add_curve_lines(name: str, polylines, material, bevel_depth: float):
    curve_data = bpy.data.curves.new(name, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 1
    curve_data.bevel_depth = bevel_depth
    curve_data.bevel_resolution = 2
    curve_data.resolution_u = 1
    for points in polylines:
        spline = curve_data.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for point, coordinate in zip(spline.points, points):
            point.co = (*coordinate, 1.0)
    curve_data.materials.append(material)
    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.collection.objects.link(obj)
    return obj


def create_stage():
    floor_material = principled_material("Black Reflective Floor", (0.001, 0.001, 0.001), roughness=0.42, metallic=0.0)
    floor_bsdf = floor_material.node_tree.nodes.get("Principled BSDF")
    floor_bsdf.inputs["Specular IOR Level"].default_value = 0.06
    floor_bsdf.inputs["Coat Weight"].default_value = 0.03
    floor_bsdf.inputs["Coat Roughness"].default_value = 0.24

    bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0.0, 31.0, FLOOR_Z))
    floor = bpy.context.object
    floor.name = "Black Mirror Stage"
    floor.scale = (11.0, 62.0, 1.0)
    floor.data.materials.append(floor_material)

    grid_material = emissive_material("Amber Grid", (0.66, 0.14, 0.008), 0.52)
    grid_z = FLOOR_Z + 0.006
    floor_lines = []
    for x in range(-10, 11, 2):
        floor_lines.append(((x, -12.0, grid_z), (x, 82.0, grid_z)))
    for y in range(-10, 83, 4):
        floor_lines.append(((-11.0, y, grid_z), (11.0, y, grid_z)))
    add_curve_lines("Perspective Floor Grid", floor_lines, grid_material, 0.006)

    tunnel_lines = []
    for y in range(-4, 79, 6):
        tunnel_lines.append(
            (
                (-9.5, y, grid_z),
                (-9.5, y, 9.5),
                (9.5, y, 9.5),
                (9.5, y, grid_z),
            )
        )
    for z in (2.0, 4.0, 6.0, 8.0):
        tunnel_lines.append(((-9.5, -8.0, z), (-9.5, 82.0, z)))
        tunnel_lines.append(((9.5, -8.0, z), (9.5, 82.0, z)))
    tunnel_lines.append(((0.0, -8.0, 9.5), (0.0, 82.0, 9.5)))
    add_curve_lines("Nested Cubic Tunnel", tunnel_lines, grid_material, 0.008)
    return floor


def point_object_at(obj, target) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_area_light(name, location, target, color, energy, size, size_y):
    bpy.ops.object.light_add(type="AREA", location=location)
    light = bpy.context.object
    light.name = name
    light.data.energy = energy
    light.data.color = color
    light.data.shape = "RECTANGLE"
    light.data.size = size
    light.data.size_y = size_y
    point_object_at(light, target)
    return light


def create_lighting():
    for side in (-1.0, 1.0):
        add_area_light(
            f"White Reflection Strip {side:+.0f}",
            (side * 3.7, 20.0, 9.0),
            (side * 3.4, 20.0, 1.4),
            (1.0, 0.94, 0.88),
            1_650.0,
            0.22,
            44.0,
        )
        add_area_light(
            f"Soft Reflection Strip {side:+.0f}",
            (side * 6.4, 17.0, 7.4),
            (side * 4.4, 17.0, 1.2),
            (1.0, 0.50, 0.20),
            560.0,
            1.2,
            38.0,
        )
        add_area_light(
            f"Amber Underlight {side:+.0f}",
            (side * 3.4, 17.0, 0.10),
            (side * 3.4, 17.0, 2.4),
            (1.0, 0.12, 0.005),
            180.0,
            2.0,
            35.0,
        )

    add_area_light(
        "Broad Overhead Color Fill",
        (0.0, 12.0, 11.0),
        (0.0, 12.0, 1.5),
        (1.0, 0.78, 0.60),
        760.0,
        8.0,
        48.0,
    )

    horizon_material = emissive_material("Horizon Ember", (1.0, 0.19, 0.006), 24.0)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=0.12, location=(0.0, 75.0, 1.0))
    ember = bpy.context.object
    ember.name = "Horizon Ember"
    ember.data.materials.append(horizon_material)

    bpy.ops.object.light_add(type="POINT", location=(0.0, 70.0, 1.1))
    horizon_light = bpy.context.object
    horizon_light.name = "Horizon Warm Light"
    horizon_light.data.energy = 1_250.0
    horizon_light.data.color = (1.0, 0.16, 0.015)
    horizon_light.data.shadow_soft_size = 2.4


def create_camera(scene, location=(0.0, -12.3, 5.20), target=(0.0, 17.0, 0.80), lens=24.0):
    bpy.ops.object.camera_add(location=tuple(location))
    camera = bpy.context.object
    camera.name = "Twin Ribbon Hero Camera"
    camera.data.lens = lens
    camera.data.sensor_width = 36.0
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.dof.use_dof = False
    point_object_at(camera, tuple(target))
    scene.camera = camera
    return camera


def configure_cycles(scene, samples: int):
    scene.render.engine = "CYCLES"
    scene.cycles.samples = max(16, samples)
    scene.cycles.use_denoising = True
    scene.cycles.preview_samples = min(64, max(16, samples // 2))
    try:
        preferences = bpy.context.preferences.addons["cycles"].preferences
        preferences.compute_device_type = "METAL"
        preferences.get_devices()
        for device in preferences.devices:
            device.use = device.type != "CPU"
        scene.cycles.device = "GPU"
    except Exception as error:  # A CPU render is slower but still valid.
        print(f"Cycles Metal configuration unavailable: {error}")


def configure_scene(scene, args, elapsed: float, info, source_label: str):
    scene.frame_start = 1
    scene.frame_end = 1
    scene.render.fps = 50
    scene.render.resolution_x = max(320, args.width)
    scene.render.resolution_y = max(180, args.height)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "16"
    scene.render.film_transparent = False
    scene.render.filepath = str(args.output.resolve())

    if args.engine == "cycles":
        configure_cycles(scene, args.samples)
    else:
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

    scene["visualizer"] = "twin-ribbon-cinematic"
    scene["telemetry_elapsed_s"] = elapsed
    scene["telemetry_driver"] = info["driver_name"]
    scene["telemetry_event"] = info["event_name"]
    scene["telemetry_date"] = info["event_date"]
    scene["telemetry_source"] = source_label
    scene["render_intent"] = "full-resolution concept-match approval still"


def main():
    args = parse_args()
    args.output = args.output if args.output.is_absolute() else ROOT / args.output
    args.blend_output = args.blend_output if args.blend_output.is_absolute() else ROOT / args.blend_output
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.blend_output.parent.mkdir(parents=True, exist_ok=True)

    data_path = args.data if args.data.is_absolute() else ROOT / args.data
    try:
        source_label = str(data_path.relative_to(ROOT))
    except ValueError:
        source_label = str(data_path)

    clear_scene()
    info, samples = load_dataset(data_path)
    elapsed, history = telemetry_history(samples, args.time)

    scene = bpy.context.scene
    configure_scene(scene, args, elapsed, info, source_label)
    ribbon = create_ribbon_pair(history, source_label)
    ribbon.data.materials.append(create_latex_material())
    create_stage()
    create_lighting()
    create_camera(scene, args.cam_loc, args.cam_target, args.lens)

    bpy.ops.wm.save_as_mainfile(filepath=str(args.blend_output.resolve()))
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.blend_output.resolve()))

    print(f"Twin Ribbon time: {elapsed:.3f}s")
    print(f"Telemetry stations: {len(history)} at {SAMPLE_RATE_HZ} Hz")
    print(f"Saved Blender scene: {args.blend_output.resolve()}")
    print(f"Rendered approval still: {args.output.resolve()}")


if __name__ == "__main__":
    main()
