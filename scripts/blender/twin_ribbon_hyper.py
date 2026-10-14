"""Native portrait Twin Ribbon: fast telemetry-driven elastic latex.

Render bounded history with persistent mesh topology and exact X reflection.
Each local frame n represents start_time + n/fps. PNGs publish atomically and
resumes require matching source, dynamics, renderer and scene configuration.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import twin_ribbon_cinematic as base
from twin_ribbon_animation import rpm_color_np
from twin_ribbon_dynamics import RibbonDynamics


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def arguments():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data', type=Path, required=True)
    p.add_argument('--driver-number', type=int)
    p.add_argument('--frames-dir', type=Path, required=True)
    p.add_argument('--start-time', type=float, required=True)
    p.add_argument('--duration', type=float, default=15)
    p.add_argument('--fps', type=int, default=50)
    p.add_argument('--width', type=int, default=1080)
    p.add_argument('--height', type=int, default=960)
    p.add_argument('--samples', type=int, default=32)
    p.add_argument('--stations', type=int, default=401)
    p.add_argument('--across', type=int, default=25)
    p.add_argument('--lens', type=float, default=47)
    p.add_argument('--camera', nargs=3, type=float, default=(0, -40, 22))
    p.add_argument('--target', nargs=3, type=float, default=(0, 17, 0))
    p.add_argument('--shift-y', type=float, default=0.0)
    p.add_argument('--still-index', type=int)
    p.add_argument('--blend-output', type=Path)
    return p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def load_telemetry(path, driver_number):
    data = json.loads(path.read_text())
    if 'carSamples' in data:
        rows = np.array([[r[0]/1000, *r[1:6]] for r in data['carSamples']], dtype=float)
        meta = data['meta']
        identity = {'name': meta['driverName'], 'number': meta['driverNumber'], 'event': meta['meetingName']}
    else:
        drivers = data['drivers']
        number = driver_number or data.get('default_driver_number') or drivers[0]['driver_number']
        driver = next(d for d in drivers if int(d['driver_number']) == int(number))
        rows = np.array([r[:6] for r in driver['samples']], dtype=float)
        identity = {'name': driver['name'], 'number': driver['driver_number'], 'event': data['meeting']['name']}
    if not np.isfinite(rows).all() or not np.all(np.diff(rows[:, 0]) > 0):
        raise ValueError('Telemetry must be finite with strictly increasing timestamps')
    return rows, identity


def setup_scene(args):
    base.clear_scene()
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = args.width, args.height
    scene.render.resolution_percentage = 100
    scene.render.fps = args.fps
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.render.image_settings.compression = 15
    scene.render.film_transparent = False
    scene.eevee.taa_render_samples = args.samples
    scene.eevee.use_raytracing = True
    scene.eevee.ray_tracing_method = 'SCREEN'
    scene.world.use_nodes = True
    world = scene.world.node_tree.nodes.get('Background')
    world.inputs['Color'].default_value = (0.005, 0.009, 0.015, 1)
    world.inputs['Strength'].default_value = 0.10
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = 0.15
    scene.view_settings.gamma = 1
    base.create_stage()
    base.create_lighting()
    # Broad grazing lights make fast folds legible through moving wet reflections.
    for side in (-1, 1):
        base.add_area_light(f'Hyper Front Softbox {side}', (side*7, -17, 9),
                            (side*4, 0, 2), (0.78, 0.9, 1), 900, 3.2, 14)
        base.add_area_light(f'Hyper Edge Strip {side}', (side*8.8, 8, 5.5),
                            (side*4, 13, 2.7), (1, 0.88, 0.65), 650, 0.30, 35)
    floor = bpy.data.materials.get('Black Reflective Floor')
    floor.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 0.29
    camera = base.create_camera(scene, args.camera, args.target, args.lens)
    camera.data.shift_y = args.shift_y
    scene.render.use_compositing = False
    return scene


def create_ribbon(args, surface):
    stations, across = surface['x_grid'].shape
    mesh = bpy.data.meshes.new('Elastic Latex Persistent Mesh')
    count = stations * across
    corners = np.arange(stations-1)[:,None]*across + np.arange(across-1)[None,:]
    loops = np.stack((corners, corners+1, corners+across+1, corners+across), axis=-1).astype(np.int32)
    faces = (stations-1)*(across-1)
    mesh.vertices.add(count)
    mesh.loops.add(faces*4)
    mesh.loops.foreach_set('vertex_index', loops.ravel())
    mesh.polygons.add(faces)
    mesh.polygons.foreach_set('loop_start', np.arange(faces,dtype=np.int32)*4)
    mesh.polygons.foreach_set('loop_total', np.full(faces,4,dtype=np.int32))
    mesh.polygons.foreach_set('use_smooth', np.ones(faces,dtype=bool))
    mesh.color_attributes.new(name='rpm_color',type='FLOAT_COLOR',domain='POINT')
    ribbon = bpy.data.objects.new('Twin Ribbon — Elastic Telemetry',mesh)
    bpy.context.collection.objects.link(ribbon)
    mirror = ribbon.modifiers.new('Exact X Mirror','MIRROR')
    mirror.use_mirror_merge = False
    sub = ribbon.modifiers.new('Liquid Continuity','SUBSURF')
    sub.levels = sub.render_levels = 1
    sub.boundary_smooth = 'PRESERVE_CORNERS'
    solid = ribbon.modifiers.new('Wet Latex Thickness','SOLIDIFY')
    solid.thickness = 0.12
    solid.offset = -0.5
    solid.use_even_offset = True
    material = base.create_latex_material()
    material.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value = 0.07
    material.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 0.105
    ribbon.data.materials.append(material)
    update_mesh(ribbon,surface)
    return ribbon


def update_mesh(ribbon, surface):
    mesh = ribbon.data
    ribbon.hide_render = bool(np.ptp(surface['y_grid']) <= 1e-8)
    across = surface['x_grid'].shape[1]
    coordinates = np.stack([surface[k] for k in ('x_grid','y_grid','z_grid')], axis=-1)
    mesh.vertices.foreach_set('co', coordinates.astype(np.float32).ravel())
    colors = np.repeat(rpm_color_np(surface['rpm']), across, axis=0).astype(np.float32)
    mesh.color_attributes['rpm_color'].data.foreach_set('color',colors.ravel())
    mesh.update()


def main():
    args = arguments()
    args.data = args.data.resolve()
    args.frames_dir = args.frames_dir.resolve()
    args.frames_dir.mkdir(parents=True,exist_ok=True)
    rows, identity = load_telemetry(args.data,args.driver_number)
    frame_count = round(args.duration*args.fps)
    if args.start_time < rows[0,0] or args.start_time+(frame_count-1)/args.fps > rows[-1,0]:
        raise ValueError('Requested clip exceeds available telemetry')
    dynamics = RibbonDynamics(rows[:,0],rows[:,1],rows[:,2],rows[:,3],rows[:,4],rows[:,5])
    manifest = {
        'renderer':'twin-ribbon-hyper-large-v2', 'data':str(args.data),
        'data_sha256':digest(args.data), 'renderer_sha256':digest(__file__),
        'dynamics_sha256':digest(HERE/'twin_ribbon_dynamics.py'),
        'base_sha256':digest(HERE/'twin_ribbon_cinematic.py'),
        'rpm_mapping_sha256':digest(HERE/'twin_ribbon_animation.py'),
        'identity':identity, 'fps':args.fps, 'start_time':args.start_time,
        'duration':args.duration, 'frame_count':frame_count,
        'width':args.width,'height':args.height,'samples':args.samples,
        'stations':args.stations,'across':args.across,'camera':list(args.camera),
        'target':list(args.target),'lens':args.lens,'shift_y':args.shift_y,
        'motion':'causal telemetry response and event-driven damped traveling waves',
        'framing':'tall native perspective fills panel, no compositor stretching',
    }
    manifest_path = args.frames_dir/'render-manifest.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise RuntimeError('Render manifest mismatch: use a new directory for changed settings')
    manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
    scene = setup_scene(args)
    surface = dynamics.surface(args.start_time,across=args.across,station_count=args.stations)
    ribbon = create_ribbon(args,surface)
    frame_indexes = [args.still_index] if args.still_index is not None else range(frame_count)
    begun = time.monotonic()
    rendered = 0
    for n in frame_indexes:
        path = args.frames_dir/f'frame-{n:06d}.png'
        if path.exists() and path.stat().st_size > 0:
            continue
        t = args.start_time+n/args.fps
        scene.frame_set(n+1)
        surface = dynamics.surface(t,across=args.across,station_count=args.stations)
        update_mesh(ribbon,surface)
        scene['lap_time_s'] = t
        scene['telemetry_identity'] = json.dumps(identity)
        scene['dynamics_version'] = manifest['dynamics_sha256']
        tmp = args.frames_dir/f'.tmp-{n:06d}.png'
        scene.render.filepath = str(tmp)
        bpy.ops.render.render(write_still=True)
        os.replace(tmp,path)
        rendered += 1
        if rendered == 1 or rendered%25 == 0 or n == frame_count-1:
            elapsed = time.monotonic()-begun
            print(json.dumps({'frame':n,'total':frame_count,'lap_time':round(t,4),
                              'seconds_per_frame':round(elapsed/rendered,3),
                              'rendered':rendered}),flush=True)
    if args.blend_output:
        args.blend_output.parent.mkdir(parents=True,exist_ok=True)
        scene.frame_start = 1
        scene.frame_end = frame_count
        scene['reproduction_command'] = ' '.join(sys.argv)
        bpy.ops.wm.save_as_mainfile(filepath=str(args.blend_output.resolve()))
    print(json.dumps({'complete':True,'new_frames':rendered,'directory':str(args.frames_dir)}),flush=True)


if __name__ == '__main__':
    main()
