"""RPM-authored ribbon sections, frozen at birth and transported through history.

Only the leading edge uses current RPM. Every older section uses its own
absolute source timestamp, never the current frame's rotation. Elastic shape
is also captured at birth so new waves cannot disturb recorded history.
"""
from __future__ import annotations

import math
import numpy as np
from twin_ribbon_dynamics import RibbonDynamics, _bounded


def rpm_degrees(rpm, low, high):
    if not (math.isfinite(low) and math.isfinite(high) and high > low):
        raise ValueError('Finite increasing RPM bounds required')
    values = np.asarray(rpm, dtype=float)
    if not np.isfinite(values).all():
        raise ValueError('RPM must be finite')
    return np.clip((values-low)/(high-low), 0, 1) * 360


class CapturedHistoryDynamics(RibbonDynamics):
    """Identical birth pose to approved dynamics; no post-birth deformation."""

    def sample(self, now, station_count=401, history_seconds=None):
        station = super().sample(now, station_count, history_seconds)
        t, cfg = station['t'], self.config
        # The approved leading edge has age=0, wave_t=sample_t and envelope=1.
        # Evaluate that exact pose for each station's own time of creation.
        def mode(name):
            return 1.20 * self._at(name, t, zero_before=True)
        station['heave'] = _bounded(1.15 * cfg.intensity * mode('heave'), 1.32)
        station['twist'] = _bounded(0.78 * cfg.intensity * mode('twist'), 0.86)
        station['edge'] = (_bounded(0.60 * cfg.intensity * mode('edge'), 0.64)
                           + cfg.intensity * self._at('flutter', t, zero_before=True))
        bounce = _bounded(cfg.intensity * mode('width_bounce'), 0.48)
        station['width'] = np.maximum(cfg.width_min * 0.8, station['width_target'] + bounce)
        station['energy'] = np.clip(self._at('energy', t, zero_before=True), 0, 1)
        return station


def section_axes(surface):
    x, z = surface['x_grid'], surface['z_grid']
    return (x[:, :1] + x[:, -1:]) * 0.5, (z[:, :1] + z[:, -1:]) * 0.5


def clearance_for_surface(surface, floor=0.3, inner_gap=0.45):
    cx, cz = section_axes(surface)
    radius = np.hypot(surface['x_grid'] - cx, surface['z_grid'] - cz)
    return max(0., float(np.max(floor + radius - cz))), max(0., float(np.max(inner_gap + radius - cx)))


def twist_surface(surface, rows, low, high, lift=0., outward=0.):
    if not all(math.isfinite(v) for v in (lift, outward)):
        raise ValueError('Finite scene offsets required')
    rows = np.asarray(rows, dtype=float)
    times = np.asarray(surface['t'], dtype=float)
    if times.min() < rows[0, 0] or times.max() > rows[-1, 0]:
        raise ValueError('History must be covered by real source telemetry')
    rpms = np.interp(times, rows[:, 0], rows[:, 2])
    degrees = rpm_degrees(rpms, low, high)
    angle = np.deg2rad(degrees)[:, None]
    cosine, sine = np.cos(angle), np.sin(angle)
    cx, cz = section_axes(surface)
    dx, dz = surface['x_grid'] - cx, surface['z_grid'] - cz
    result = dict(surface)
    result['x_grid'] = cx + outward + dx * cosine + dz * sine
    result['z_grid'] = cz + lift - dx * sine + dz * cosine
    result['y_grid'] = surface['y_grid'].copy()
    result['rpm'] = rpms
    result['roll_degrees'] = degrees
    return result
