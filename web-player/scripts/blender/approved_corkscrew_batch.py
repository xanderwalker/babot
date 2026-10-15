"""Resumable native Blender corkscrew render with timestamp-frozen history."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'blender'))
import twin_ribbon_hyper as approved
from rpm_twist import CapturedHistoryDynamics, rpm_degrees, clearance_for_surface, twist_surface


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def publish_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--clip', required=True)
    parser.add_argument('--preflight', action='store_true')
    options = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    config = json.loads(options.config.read_text())
    clip = next(c for c in config['clips'] if c['id'] == options.clip)
    root = Path(config['root'])
    output = root / 'working' / clip['id']
    frames = output / 'frames'
    frames.mkdir(parents=True, exist_ok=True)
    data = Path(clip['telemetry'])
    if digest(data) != clip['telemetry_sha256']:
        raise RuntimeError('Telemetry changed after selection')
    rows, identity = approved.load_telemetry(data, clip['driver_number'])
    fps, duration, start = config['fps'], config['duration'], clip['start_lap_s']
    count = round(fps * duration)
    times = start + np.arange(count) / fps
    if start - 6.4 < rows[0, 0] or start + duration > rows[-1, 0]:
        raise RuntimeError('Full history and display window require real telemetry coverage')
    current_rpm = np.interp(times, rows[:, 0], rows[:, 2])
    low, high = float(current_rpm.min()), float(current_rpm.max())
    angles = rpm_degrees(current_rpm, low, high)
    dynamics = CapturedHistoryDynamics(*rows.T)
    quality = config['quality']
    across, stations = quality['across'], quality['stations']
    lift, outward = 0., 0.
    for now in times:
        surface = dynamics.surface(float(now), across=across, station_count=stations)
        dz, dx = clearance_for_surface(surface)
        lift, outward = max(lift, dz), max(outward, dx)
    lift, outward = math.ceil(lift*100)/100, math.ceil(outward*100)/100
    args = SimpleNamespace(width=1080, height=960, fps=fps, samples=quality['samples'],
        camera=(0, -40, 22+lift), target=(0, 17, lift), lens=quality['lens'],
        shift_y=0., across=across, stations=stations)
    dependencies = [Path(__file__), *sorted((HERE/'blender').glob('*.py'))]
    manifest = {
        'renderer': 'captured-history-corkscrew-batch-v1', 'clip': clip,
        'identity': identity, 'fps': fps, 'duration': duration, 'start_time': start,
        'frame_count': count, 'source': str(data), 'source_sha256': digest(data),
        'onboard_offset_s': clip['start_media_s']-start, 'retimed': False,
        'rpm_low': low, 'rpm_high': high,
        'angle_formula': '360 * clamp((RPM(section_source_time)-low)/(high-low),0,1)',
        'mapping_scope': 'Fixed clip-relative 0..360 degree orientation, not physical shaft speed',
        'history_policy': 'Freeze full X/Z birth pose and angle, then advect only Y toward horizon',
        'mirror_policy': 'Exact X reflection gives opposite-handed twin',
        'constant_clearance_lift': lift, 'constant_outward_shift': outward,
        'camera': list(args.camera), 'target': list(args.target), 'quality': quality,
        'width': args.width, 'height': args.height,
        'code_sha256': {str(p): digest(p) for p in dependencies},
        'angle_frames': [{'frame': int(i), 'lap_time_s': float(times[i]),
                          'rpm': float(current_rpm[i]), 'angle_degrees': float(angles[i])}
                         for i in range(count)],
    }
    manifest_path = frames/'render-manifest.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise RuntimeError('Changed settings/code require a new output family')
    publish_json(manifest_path, manifest)
    scene = approved.setup_scene(args)
    scene.render.image_settings.compression = quality.get('png_compression', 15)
    for side in (-1, 1):
        approved.base.add_area_light(f'Roll Under Fill {side}', (side*8.5, -10, .7),
            (side*4.2, 16, lift+2), (.85, .91, 1), 500, 3, 25)
    surface = dynamics.surface(start, across=across, station_count=stations)
    ribbon = approved.create_ribbon(args, twist_surface(surface, rows, low, high, lift, outward))
    ribbon['history_policy'] = manifest['history_policy']
    ribbon['rpm_rotation_bounds'] = [low, high]
    indexes = (sorted(set([0, count-1, count//4, count//2, 3*count//4] +
                         [int(np.argmin(abs(angles-a))) for a in (0, 90, 180, 270, 360)]))
               if options.preflight else range(count))
    begun, rendered = time.monotonic(), 0
    for n in indexes:
        path = frames/f'frame-{n:06d}.png'
        if path.exists() and path.stat().st_size > 32:
            continue
        surface = dynamics.surface(float(times[n]), across=across, station_count=stations)
        transformed = twist_surface(surface, rows, low, high, lift, outward)
        if transformed['z_grid'].min() < .29 or transformed['x_grid'].min() < .44:
            raise RuntimeError('Ribbon clearance violated')
        if abs(transformed['roll_degrees'][0]-angles[n]) > 1e-8:
            raise RuntimeError('Leading angle does not match current RPM')
        scene.frame_set(n+1)
        approved.update_mesh(ribbon, transformed)
        scene['lap_time_s'] = float(times[n])
        scene['leading_rpm_angle_degrees'] = float(angles[n])
        temporary = frames/f'.tmp-{n:06d}.png'
        scene.render.filepath = str(temporary)
        bpy.ops.render.render(write_still=True)
        os.replace(temporary, path)
        rendered += 1
        if rendered == 1 or rendered%25 == 0 or options.preflight or n == count-1:
            status = {'clip': clip['id'], 'frame': n, 'total': count, 'new_frames': rendered,
                      'seconds_per_frame': (time.monotonic()-begun)/rendered,
                      'preflight': options.preflight, 'render_complete': False}
            publish_json(output/'render-status.json', status)
            print(json.dumps(status), flush=True)
    scene.frame_start, scene.frame_end = 1, count
    scene['animation_note'] = 'Script-driven snapshot; run work/render_clip.py with frozen config to reproduce.'
    if not options.preflight:
        bpy.ops.wm.save_as_mainfile(filepath=str(output/f"{clip['id']}-corkscrew.blend"))
    publish_json(output/'render-status.json', {'clip': clip['id'], 'total': count,
        'render_complete': not options.preflight, 'preflight': options.preflight,
        'new_frames': rendered, 'elapsed_s': time.monotonic()-begun})
    print(json.dumps({'complete': True, 'preflight': options.preflight, 'clip': clip['id']}), flush=True)


if __name__ == '__main__':
    main()
