"""Render the approved continuous Blender corkscrew for the new Singapore pole lap.

Scene/material/dynamics are copied from the established Twin Ribbon workflow;
rpm_twist is restored verbatim from the approved September 22 production script.
Animation render orchestration retains Blender's engine between frames.
"""
from __future__ import annotations
import argparse, hashlib, json, math, os, sys, time
from pathlib import Path
from types import SimpleNamespace
import bpy
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
import twin_ribbon_hyper as approved
from rpm_twist import CapturedHistoryDynamics, clearance_for_surface, twist_surface

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--start-frame',type=int,default=1)
    p.add_argument('--end-frame',type=int,default=4569)
    p.add_argument('--samples',type=int,default=8)
    p.add_argument('--width',type=int,default=810)
    p.add_argument('--height',type=int,default=720)
    p.add_argument('--progress',type=Path)
    args=p.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    data=ROOT/'data/openf1-singapore-2026-verstappen-pole.json'
    fixture=json.loads(data.read_text())
    assert fixture['meta']['sessionKey']==11384 and fixture['meta']['driverNumber']==3 and fixture['meta']['lapNumber']==11
    rows,identity=approved.load_telemetry(data,3)
    fps=50; duration=fixture['meta']['lapDurationSeconds'];count=math.ceil(duration*fps)
    times=np.minimum(np.arange(count)/fps,duration)
    held_times=np.clip(times,rows[0,0],rows[-1,0])
    # No source samples are fabricated. Leading endpoints hold nearest measured
    # value for 0.120s / 0.092s; initial zero-area history is hidden as approved.
    rpms=np.interp(held_times,rows[:,0],rows[:,2]);low=float(rpms.min());high=float(rpms.max())
    dynamics=CapturedHistoryDynamics(*rows.T)
    across=25;stations=401;lift=outward=0.
    for now in held_times:
        surface=dynamics.surface(float(now),across=across,station_count=stations)
        dz,dx=clearance_for_surface(surface)
        lift=max(lift,dz);outward=max(outward,dx)
    lift=math.ceil(lift*100)/100;outward=math.ceil(outward*100)/100
    settings=SimpleNamespace(width=args.width,height=args.height,fps=fps,samples=args.samples,
        camera=(0,-40,22+lift),target=(0,17,lift),lens=47,shift_y=0.,across=across,stations=stations)
    out=args.output.resolve();frames=out/'frames';frames.mkdir(parents=True,exist_ok=True)
    manifest={'renderer':'approved-continuous-corkscrew-native-animation','identity':identity,
        'datasetId':fixture['meta']['datasetId'],'source':str(data),'source_sha256':hashlib.sha256(data.read_bytes()).hexdigest(),
        'fps':fps,'startTimeSeconds':0,'lapDurationSeconds':duration,'duration':count/fps,'frameCount':count,
        'width':args.width,'height':args.height,'samples':args.samples,'stations':stations,'across':across,
        'rpmBounds':[low,high],'constantLift':lift,'constantOutward':outward,'camera':settings.camera,'target':settings.target,
        'history':'Each continuous section retains its pose and RPM orientation at birth; exact opposite-handed X mirror.',
        'endpointPolicy':{'leadingHoldSeconds':float(rows[0,0]),'trailingHoldSeconds':duration-float(rows[-1,0]),'sourceModified':False,'emptyHistory':'hidden until positive measured history exists'},
        'lineage':'September22 approved TwinRibbon-Corkscrew-5x45 production; recovered rpm_twist.py and local continuous RPM Wet Latex renderer.',
        'codeSha256':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in HERE.glob('*.py')}}
    manifest_path=out/'render-manifest.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text())!=json.loads(json.dumps(manifest)):
        raise RuntimeError('Output settings differ; use a new directory.')
    manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
    scene=approved.setup_scene(settings)
    scene.render.use_lock_interface=True
    scene.render.image_settings.compression=10
    for side in (-1,1):
        approved.base.add_area_light(f'Roll Under Fill {side}',(side*8.5,-10,.7),(side*4.2,16,lift+2),(.85,.91,1),500,3,25)
    surface=dynamics.surface(float(held_times[0]),across=across,station_count=stations)
    ribbon=approved.create_ribbon(settings,twist_surface(surface,rows,low,high,lift,outward))
    def update(scene,*_):
        n=max(0,min(count-1,scene.frame_current-1))
        surface=dynamics.surface(float(held_times[n]),across=across,station_count=stations)
        approved.update_mesh(ribbon,twist_surface(surface,rows,low,high,lift,outward))
        scene['lap_time_s']=float(times[n]);scene['telemetry_identity']=json.dumps(identity)
    bpy.app.handlers.frame_change_pre.append(update)
    scene.frame_start=max(1,args.start_frame);scene.frame_end=min(count,args.end_frame)
    while scene.frame_start<scene.frame_end and (frames/f'frame-{scene.frame_start:04d}.png').exists():
        scene.frame_start+=1
    scene.render.filepath=str(frames/'frame-')
    scene.frame_set(scene.frame_start)
    begun=time.monotonic();first=scene.frame_start
    def progress(scene,*_):
        n=scene.frame_current
        if n==first or n%50==0 or n==scene.frame_end:
            seconds=(time.monotonic()-begun)/(n-first+1)
            status={'completed':n,'total':count,'secondsPerFrame':round(seconds,3),'message':f'Blender rendering frame {n:,} of {count:,}'}
            print(json.dumps(status),flush=True)
            if args.progress:
                args.progress.parent.mkdir(parents=True,exist_ok=True)
                tmp=args.progress.with_suffix('.tmp');tmp.write_text(json.dumps(status));os.replace(tmp,args.progress)
    bpy.app.handlers.render_write.append(progress)
    bpy.ops.wm.save_as_mainfile(filepath=str(out/'singapore-2026-corkscrew.blend'))
    bpy.ops.render.render(animation=True)
    print(json.dumps({'done':True,'frames':scene.frame_end-first+1,'seconds':time.monotonic()-begun}),flush=True)

if __name__=='__main__':main()
