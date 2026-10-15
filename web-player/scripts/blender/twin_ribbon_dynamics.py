"""Deterministic, causal wet-latex motion for the continuous Twin Ribbon.

This module has no Blender dependency.  Build one RibbonDynamics for a session,
then query frames in any order.  Times are seconds on the same clock as the
onboard; speed is km/h, throttle is percent, and RPM stays an unmodified color
signal.  Do not retime the onboard to make this animation move faster.

    motion = RibbonDynamics(times, speeds, rpms, throttles, brakes, gears)
    station = motion.surface(lap_time, across=17, station_count=401)
    vertices = np.stack([station['x_grid'], station['y_grid'],
                         station['z_grid']], axis=-1)

The returned surface is the positive-X half.  Mirror it exactly in Blender.
Width and height retain their telemetry mappings.  Three decaying elastic modes
react to real throttle changes, braking, shifts, RPM transients and acceleration.
They propagate down the existing ribbon, so its *material* continues to jiggle
after a telemetry event has passed.  There is no noise or frame-order state.

The older renderer used a 2.4-second-wide throttle smoothing kernel, a one-second
speed smoothing kernel, and 2.2 units/second history transport.  Here input lag is
20-40 ms and up to 6.4 seconds of genuine history travels at 12 units/second.
The oldest 20% accelerates into a distant horizon.  That depth projection and
elastic motion are explicit artistic responses, not claims that telemetry
sampled at a few Hz measures those high-frequency vibrations.

Run this file with any NumPy-equipped Python to check causality, repeatability,
boundedness, telemetry response time and the dominant elastic frequencies.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import math

import numpy as np


@dataclass(frozen=True)
class DynamicsConfig:
    history_seconds: float = 6.4
    depth_per_second: float = 12.0
    horizon_start_fraction: float = 0.8
    horizon_extension: float = 120.0
    y_near: float = -13.3
    inner_edge_x: float = 0.85
    width_min: float = 3.0
    width_span: float = 4.0
    floor_z: float = 0.12
    intensity: float = 1.0
    sample_hz: float = 100.0
    throttle_tau: float = 0.020
    speed_tau: float = 0.040
    heave_hz: float = 4.6
    twist_hz: float = 6.8
    edge_hz: float = 9.6
    # A disturbance moves faster than the historical material: it travels along
    # the ribbon at depth_per_second / wave_delay_per_history_second units/sec.
    wave_delay_per_history_second: float = 0.56


def _ema(values: np.ndarray, dt: float, tau: float) -> np.ndarray:
    out = np.empty_like(values)
    out[0] = values[0]
    alpha = 1.0 - math.exp(-dt / max(tau, 1e-8))
    for i in range(1, len(values)):
        out[i] = out[i - 1] + alpha * (values[i] - out[i - 1])
    return out


def _elastic(impulses: np.ndarray, dt: float, hz: float, damping: float) -> np.ndarray:
    """Exact causal underdamped response; a unit impulse peaks at one unit.

    A short finite impulse response is preferable to a per-render-frame spring:
    it is stable at any render FPS and resumed frames reproduce exactly.
    """
    omega = 2.0 * math.pi * hz
    decay = damping * omega
    ring = omega * math.sqrt(1.0 - damping * damping)
    duration = max(0.5, -math.log(0.0001) / decay)
    t = np.arange(math.ceil(duration / dt) + 1, dtype=np.float64) * dt
    peak_time = math.atan2(ring, decay) / ring
    peak = math.exp(-decay * peak_time) * math.sin(ring * peak_time)
    kernel = np.exp(-decay * t) * np.sin(ring * t) / peak
    return np.convolve(impulses, kernel, mode="full")[: len(impulses)]


def _bounded(value: np.ndarray, limit: float) -> np.ndarray:
    return limit * np.tanh(value / limit)


def _smoothstep(low: float, high: float, values: np.ndarray) -> np.ndarray:
    x = np.clip((values - low) / (high - low), 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


class RibbonDynamics:
    """Precomputed telemetry response, sampled causally on an absolute clock.

    Inputs may already be regular telemetry or irregular timestamped telemetry;
    they must be finite, one-dimensional, equally sized, and strictly ordered.
    Continuous channels are linearly interpolated.  Brake and gear transitions
    are held from the last actual sample, never anticipated.  Querying before
    the source begins collapses history to its first measured station with no
    impulses.  The fixed station count grows across only available telemetry.
    """

    def __init__(
        self,
        times,
        speed_kph,
        rpm,
        throttle_pct,
        brake=None,
        gear=None,
        config: DynamicsConfig | None = None,
    ):
        self.config = config or DynamicsConfig()
        source_t = np.asarray(times, dtype=np.float64)
        channels = [np.asarray(v, dtype=np.float64) for v in (speed_kph, rpm, throttle_pct)]
        if source_t.ndim != 1 or source_t.size < 2:
            raise ValueError("Telemetry needs at least two one-dimensional timestamps")
        if any(v.shape != source_t.shape for v in channels):
            raise ValueError("All telemetry channels must match times")
        if not np.all(np.isfinite(source_t)) or not all(np.all(np.isfinite(v)) for v in channels):
            raise ValueError("Telemetry must contain finite values")
        if not np.all(np.diff(source_t) > 0):
            raise ValueError("Telemetry timestamps must be strictly increasing")
        cfg = self.config
        if cfg.sample_hz < 50 or cfg.history_seconds <= 0 or cfg.intensity < 0:
            raise ValueError("Need sample_hz >= 50, positive history, and nonnegative intensity")
        if not 0 < cfg.horizon_start_fraction < 1 or cfg.horizon_extension < 0:
            raise ValueError("Need horizon fraction between zero and one and nonnegative extension")
        if not 0 < cfg.wave_delay_per_history_second <= 2:
            raise ValueError("Wave propagation delay must be positive and <= 2")
        self.start_time = float(source_t[0])
        self.end_time = float(source_t[-1])
        self.dt = 1.0 / cfg.sample_hz
        count = int(math.ceil((self.end_time - self.start_time) / self.dt)) + 1
        self.times = self.start_time + np.arange(count, dtype=np.float64) * self.dt
        speed, rpms, throttle = (np.interp(self.times, source_t, c) for c in channels)
        speed = np.maximum(speed, 0.0)
        rpms = np.maximum(rpms, 0.0)
        throttle = np.clip(throttle, 0.0, 100.0)

        def held(values, default):
            if values is None:
                return np.full(count, default, dtype=np.float64)
            arr = np.asarray(values, dtype=np.float64)
            if arr.shape != source_t.shape or not np.all(np.isfinite(arr)):
                raise ValueError("Brake/gear must be finite and match times")
            index = np.clip(np.searchsorted(source_t, self.times, side="right") - 1, 0, len(source_t) - 1)
            return arr[index]

        braking = (held(brake, 0.0) > 0).astype(np.float64)
        gears = held(gear, 0.0)
        self.signals = {
            "speed": _ema(speed, self.dt, cfg.speed_tau),
            "throttle": _ema(throttle, self.dt, cfg.throttle_tau),
            "rpm": rpms,
            "brake": braking,
            "gear": gears,
        }
        # Each delta is an impulse *area*, so a 0->100% throttle application has
        # the same total excitation at 50, 100 or 200 Hz input resolutions.
        delta_throttle = np.diff(throttle, prepend=throttle[0]) / 100.0
        delta_rpm = np.diff(rpms, prepend=rpms[0]) / 2400.0
        delta_gear = np.diff(gears, prepend=gears[0])
        shift = np.sign(delta_gear)
        brake_on = np.maximum(np.diff(braking, prepend=braking[0]), 0.0)
        brake_off = np.maximum(-np.diff(braking, prepend=braking[0]), 0.0)
        accel_g = np.diff(self.signals["speed"], prepend=speed[0]) / (3.6 * self.dt * 9.81)
        accel_g = np.clip(accel_g, -6.0, 3.5)
        delta_accel = np.clip(np.diff(accel_g, prepend=accel_g[0]), -1.5, 1.5)
        drive = (0.85 * delta_throttle - 0.85 * brake_on + 0.28 * brake_off
                 + 0.67 * shift + 0.12 * delta_rpm + 0.075 * delta_accel)
        impact = (0.60 * np.abs(delta_throttle) + 0.85 * brake_on + 0.32 * brake_off
                  + 0.80 * np.abs(shift) + 0.07 * np.abs(delta_rpm))
        self.signals["heave"] = _elastic(drive, self.dt, cfg.heave_hz, 0.19)
        self.signals["twist"] = _elastic(0.75 * shift + 0.6 * delta_throttle - 0.72 * brake_on,
                                          self.dt, cfg.twist_hz, 0.14)
        self.signals["edge"] = _elastic(impact, self.dt, cfg.edge_hz, 0.12)
        self.signals["width_bounce"] = _elastic(0.44 * delta_throttle + 0.10 * shift - 0.12 * brake_on,
                                                 self.dt, 7.4, 0.24)
        # A peak-decay envelope is used for lighting/intensity only, not as a
        # substitute for the continuous measured width, height or RPM colors.
        energy = np.zeros(count, dtype=np.float64)
        decay = math.exp(-self.dt / 0.28)
        for i in range(1, count):
            energy[i] = max(energy[i - 1] * decay, min(1.0, impact[i] * 1.5))
        self.signals["energy"] = energy
        self.signals["accel_g"] = accel_g
        # Integrated phase ties subtle surface flutter to engine effort.  Its
        # visual frequency remains below 10 Hz; it is not literal engine RPM.
        effort = np.clip(rpms / 13000.0, 0.0, 1.0) * throttle / 100.0
        phase = np.cumsum(2.0 * math.pi * (5.5 + 2.3 * effort) * self.dt)
        self.signals["flutter"] = 0.055 * effort * np.sin(phase)
        self.event_counts = {
            "gear_changes": int(np.count_nonzero(shift)),
            "brake_applications": int(np.count_nonzero(brake_on)),
            "throttle_travel_equivalents": float(np.sum(np.abs(delta_throttle))),
        }

    @classmethod
    def from_samples(cls, samples, config: DynamicsConfig | None = None):
        """Adapter for twin_ribbon_cinematic.load_dataset normalized dictionaries."""
        return cls(*[[row[key] for row in samples] for key in ("t", "speed", "rpm", "throttle")],
                   brake=[row.get("brake", 0) for row in samples],
                   gear=[row.get("gear", 0) for row in samples], config=config)

    def _at(self, channel: str, times: np.ndarray, zero_before: bool = False) -> np.ndarray:
        values = self.signals[channel]
        return np.interp(times, self.times, values, left=0.0 if zero_before else values[0])

    def sample(self, now: float, station_count: int = 401, history_seconds: float | None = None):
        """Return newest-first station arrays; geometry units match the old scene.

        ``t`` gives the source sample time and ``age`` drives material transport.
        Early clips grow from the actual source start instead of inventing a
        constant prehistory.  ``depth_extension`` is an artistic perspective
        offset, zero across the newest 80% and smoothly increasing at the tail.
        ``heave/twist/edge`` are artistic response offsets in scene units.
        ``energy`` is a bounded 0..1 recent-impact signal available to lighting.
        """
        if not math.isfinite(now) or station_count < 2:
            raise ValueError("Need a finite time and at least two stations")
        cfg = self.config
        history = cfg.history_seconds if history_seconds is None else float(history_seconds)
        if history <= 0:
            raise ValueError("History must be positive")
        elapsed = max(float(now), self.start_time)
        available = max(0.0, elapsed - self.start_time)
        span = min(history, available)
        age = np.linspace(0.0, span, int(station_count))
        sample_t = elapsed - age
        wave_t = elapsed - cfg.wave_delay_per_history_second * age
        # Keep the newest 80% metrically unchanged.  A C1 smoothstep pushes only
        # the far tail toward a vanishing point.  The squared maturity envelope
        # lets early-lap ribbons grow naturally instead of stretching one second
        # of real measurements across a fully developed 200-unit landscape.
        fraction = age / span if span > 0.0 else np.zeros_like(age)
        maturity = span / history
        depth_extension = (cfg.horizon_extension * maturity * maturity
                           * _smoothstep(cfg.horizon_start_fraction, 1.0, fraction))
        speed = self._at("speed", sample_t)
        throttle = self._at("throttle", sample_t)
        envelope = np.exp(-age / 5.0)
        # Combine motion frozen into moving material with a faster elastic wave.
        # This avoids an inert heightfield: old segments react as impacts pass.
        def mode(name):
            return (0.32 * self._at(name, sample_t, zero_before=True)
                    + 0.88 * self._at(name, wave_t, zero_before=True)) * envelope

        heave = _bounded(1.15 * cfg.intensity * mode("heave"), 1.32)
        twist = _bounded(0.78 * cfg.intensity * mode("twist"), 0.86)
        edge = _bounded(0.60 * cfg.intensity * mode("edge"), 0.64)
        edge += cfg.intensity * self._at("flutter", wave_t, zero_before=True) * envelope
        bounce = _bounded(cfg.intensity * mode("width_bounce"), 0.48)
        width = cfg.width_min + cfg.width_span * (np.clip(throttle / 100.0, 0.0, 1.0) ** 0.75)
        height = 0.35 + 6.0 * _smoothstep(25.0, 305.0, speed) ** 1.25
        return {
            "t": np.clip(sample_t, self.start_time, self.end_time),
            "age": age,
            "y": cfg.y_near + age * cfg.depth_per_second + depth_extension,
            "depth_extension": depth_extension,
            "speed": speed,
            "throttle": throttle,
            "rpm": self._at("rpm", sample_t),
            "brake": self._at("brake", sample_t),
            "gear": self._at("gear", sample_t),
            "width": np.maximum(cfg.width_min * 0.8, width + bounce),
            "width_target": width,
            "height": height,
            "heave": heave,
            "twist": twist,
            "edge": edge,
            "energy": np.clip(self._at("energy", wave_t, zero_before=True) * envelope, 0.0, 1.0),
            "accel_g": self._at("accel_g", sample_t),
        }

    def surface(self, now: float, across: int = 17, station_count: int = 401,
                history_seconds: float | None = None):
        """Return station data plus ``x_grid,y_grid,z_grid`` for one mirror half."""
        if across < 3:
            raise ValueError("Need at least three points across the ribbon")
        station = self.sample(now, station_count, history_seconds)
        u = np.linspace(0.0, 1.0, int(across))[None, :]
        edge_profile = (2.0 * u - 1.0) ** 2
        crown = 0.14 * np.sin(math.pi * u) ** 1.35
        edge_roll = -0.035 * np.abs(2.0 * u - 1.0) ** 5
        # Torsion tilts the two edges in opposition; a second, shallow transverse
        # flex gives highlights a liquid fold without creating detached slabs.
        flex = station["edge"][:, None] * (edge_profile - 0.3 * np.sin(2.0 * math.pi * u))
        z = (station["height"][:, None] + station["heave"][:, None]
             + station["twist"][:, None] * (2.0 * u - 1.0)
             + flex + crown + edge_roll)
        # Smooth collision floor prevents low-speed impulses going through the
        # reflective floor. Above ~0.4 units it has no meaningful visible effect.
        station["z_grid"] = self.config.floor_z + np.logaddexp(0.0, 16.0 * (z - self.config.floor_z)) / 16.0
        station["x_grid"] = self.config.inner_edge_x + station["width"][:, None] * u
        station["y_grid"] = np.broadcast_to(station["y"][:, None], station["x_grid"].shape).copy()
        return station

    def describe(self):
        return {"model": "causal-elastic-telemetry-v2", "config": asdict(self.config),
                "events": dict(self.event_counts),
                "source_start_seconds": self.start_time, "source_end_seconds": self.end_time,
                "elastic_hz": [self.config.heave_hz, self.config.twist_hz, self.config.edge_hz]}


def quantitative_checks():
    """Focused invariants for this creative response model (no Blender needed)."""
    t = np.arange(0.0, 8.001, 0.02)
    speed = np.full_like(t, 230.0)
    rpm = np.full_like(t, 10800.0)
    throttle = np.where(t >= 2.0, 100.0, 0.0)
    gear = np.where(t >= 3.0, 6.0, 5.0)
    brake = ((t >= 4.0) & (t < 4.8)).astype(float)
    test = RibbonDynamics(t, speed, rpm, throttle, brake, gear)
    # No event impulse may precede the throttle transition.
    assert np.max(np.abs(test.sample(1.98)["heave"])) == 0.0
    first = test.surface(4.12)
    test.surface(7.0)
    repeated = test.surface(4.12)
    assert np.array_equal(first["z_grid"], repeated["z_grid"])
    assert first["x_grid"].shape == (401, 17)
    assert np.all(np.isfinite(first["z_grid"]))
    assert np.min(first["z_grid"]) >= test.config.floor_z
    assert np.all(np.diff(first["x_grid"], axis=1) > 0)
    assert abs(test.sample(2.08)["throttle"][0] - 100.0) < 2.0
    early = test.sample(1.5)
    assert early["t"].size == 401
    assert np.isclose(early["age"][-1], 1.5)
    assert np.isclose(early["t"][-1], test.start_time)
    assert np.all(np.diff(early["t"]) < 0.0)
    assert np.all(np.diff(early["y"]) > 0.0)
    assert np.all(early["t"] >= test.start_time)
    newborn = test.sample(test.start_time)
    assert np.count_nonzero(newborn["age"]) == 0
    assert np.count_nonzero(newborn["depth_extension"]) == 0
    mature = test.sample(7.0)
    assert np.all(mature["depth_extension"][:321] == 0.0)
    assert np.isclose(mature["depth_extension"][-1], 120.0)
    assert np.all(np.diff(mature["y"]) > 0.0)
    linear = RibbonDynamics(t, speed, rpm, throttle, brake, gear,
                            DynamicsConfig(horizon_extension=0.0)).sample(7.0)
    for key in ("t", "age", "width", "width_target", "height", "rpm", "heave", "twist", "edge"):
        assert np.array_equal(mature[key], linear[key]), key
    assert np.array_equal(mature["y"][:321], linear["y"][:321])
    # The same old material moves independently of its base history profile:
    # advancing time + age together preserves the source sample but moves waves.
    older = test.sample(3.12, station_count=321, history_seconds=2.0)
    later = test.sample(3.22, station_count=321, history_seconds=2.0)
    assert np.isclose(older["t"][160], later["t"][176])
    a = older["heave"][160]
    b = later["heave"][176]
    assert abs(a - b) > 1e-4
    output_times = np.arange(0.0, 8.0, 0.02)
    heave = np.array([test.sample(float(now), 2)["heave"][0] for now in output_times])
    assert np.max(np.abs(heave)) > 0.5
    assert np.max(np.abs(heave)) <= 1.32
    return {
        "passed": True,
        "deterministic_random_access": True,
        "pre_event_heave": 0.0,
        "throttle_at_80ms_pct": float(test.sample(2.08)["throttle"][0]),
        "peak_heave_units": float(np.max(np.abs(heave))),
        "history_transport_units_per_second": test.config.depth_per_second,
        "history_transport_speedup_vs_legacy": test.config.depth_per_second / 2.2,
        "early_history_seconds": float(early["age"][-1]),
        "early_tail_extension_units": float(early["depth_extension"][-1]),
        "mature_tail_y_units": float(mature["y"][-1]),
        "near_80_percent_and_telemetry_unchanged": True,
        "material_jiggle_delta_units": float(abs(a - b)),
        **test.describe(),
    }


if __name__ == "__main__":
    print(json.dumps(quantitative_checks(), indent=2))
