"""Reference implementation of the generator spreadsheet.

It reproduces the spreadsheet formulas step by step (same hash, same transforms),
so a value read back from Google Sheets can be checked against this model, and
the dashboard has an offline sample dataset.

    output(m, t) = max(0, F^-1(Phi(z[m, t])))           # chosen distribution
                   * weekday(t) * trend(t)               # periodic pattern, trend
                   * prod_e (1 + (F_e - 1) w_e(t) hit[e, m])   # events

    z[m, t] = rho z[m, t-1] + sqrt(1 - rho^2) (sqrt(c) common[t] + sqrt(1 - c) eps[m, t])
"""
from __future__ import annotations

import datetime as dt
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from scipy.stats import norm

MAX_MINES = 8
MAX_EVENTS = 8
SHEETS_EPOCH = dt.date(1899, 12, 30)


@dataclass
class Event:
    day: dt.date
    duration: float
    factor: float
    probability: float | None = None
    mines: int | None = None
    shape: str = "Bell"


@dataclass
class Params:
    start: dt.date = dt.date(2099, 11, 2)
    days: int = 40
    mines: list[str] = field(default_factory=lambda: ["LV-426", "Origae-6", "Fiorina 151"])
    distribution: str = "Normal"
    a: float | None = 50.0
    b: float | None = 6.0
    c: float | None = None
    smoothing: float = 0.5
    correlation: float = 0.2
    seed: float = 2099
    weekday: list[float] = field(default_factory=lambda: [1, 1, 1, 1, 1, 0.8, 0.4])
    growth: float = 0.02
    trend: str = "Compound"
    events: list[Event] = field(default_factory=lambda: [
        Event(dt.date(2099, 11, 10), 3, 0.4, probability=1.0),
        Event(dt.date(2099, 11, 20), 1, 1.4, probability=0.33),
        Event(dt.date(2099, 11, 25), 2, 1.9, mines=1),
        Event(dt.date(2099, 12, 3), 4, 0.55, probability=0.5, shape="Flat"),
    ])


def serial(d: dt.date) -> int:
    return (d - SHEETS_EPOCH).days


def u(seed: float, t: float, k: float, s: float) -> float:
    """MOD(SIN(Seed*0.6180339887 + t*12.9898 + k*78.233 + s*37.719) * 43758.5453, 1)"""
    x = seed * 0.6180339887 + t * 12.9898 + k * 78.233 + s * 37.719
    return (math.sin(x) * 43758.5453) % 1.0


def nsinv(p: float) -> float:
    return float(norm.ppf(min(max(p, 1e-9), 1 - 1e-9)))


def base_value(p: Params, z: float) -> float:
    a = p.a or 0.0
    b = p.b or 0.0
    if p.distribution == "Uniform":
        lo, hi = min(a, b), max(a, b)
        return lo + (hi - lo) * float(norm.cdf(z))
    if p.distribution == "Log-normal":
        mean = max(a, 1e-9)
        log_sd = math.sqrt(math.log(1 + (max(0.0, b) / mean) ** 2))
        log_mu = math.log(mean) - log_sd ** 2 / 2
        return math.exp(log_mu + log_sd * z)
    if p.distribution == "Triangular":
        vals = sorted(v for v in (p.a, p.b, p.c) if v is not None)
        lo, hi = vals[0], vals[-1]
        mode = vals[len(vals) // 2] if len(vals) % 2 else (vals[0] + vals[1]) / 2
        if hi == lo:
            return lo
        q = float(norm.cdf(z))
        f = (mode - lo) / (hi - lo)
        if q < f:
            return lo + math.sqrt(q * (hi - lo) * (mode - lo))
        return hi - math.sqrt((1 - q) * (hi - lo) * (hi - mode))
    return a + max(0.0, b) * z  # Normal


def event_weight(ev: Event, day_serial: int) -> float:
    start = serial(ev.day)
    dur = max(1.0, ev.duration or 0)
    if ev.shape == "Flat":
        return 1.0 if start <= day_serial < start + dur else 0.0
    center = start + (dur - 1) / 2
    sigma = dur / 2.3548  # full width at half maximum = duration
    w = math.exp(-((day_serial - center) ** 2) / (2 * sigma ** 2))
    return w if w >= 0.01 else 0.0


def event_hits(p: Params) -> list[list[int]]:
    """hit[e][m] for event slot e (0-based) and mine slot m (0-based)."""
    names = (p.mines + [""] * MAX_MINES)[:MAX_MINES]
    hits = []
    for e in range(MAX_EVENTS):
        ev = p.events[e] if e < len(p.events) else None
        draws = [u(p.seed, e + 1, m + 1, 3) for m in range(MAX_MINES)]
        row = []
        for m in range(MAX_MINES):
            if ev is None or not names[m]:
                row.append(0)
                continue
            if ev.mines is not None:
                rank = 1 + sum(1 for k in range(MAX_MINES) if names[k] and draws[k] < draws[m])
                row.append(1 if rank <= ev.mines else 0)
            else:
                prob = 1.0 if ev.probability is None else ev.probability
                row.append(1 if draws[m] < prob else 0)
        hits.append(row)
    return hits


def generate(p: Params) -> dict:
    rho = min(max(p.smoothing, 0.0), 0.99)
    c = min(max(p.correlation, 0.0), 1.0)
    names = (p.mines + [""] * MAX_MINES)[:MAX_MINES]
    hits = event_hits(p)
    dates = [p.start + dt.timedelta(days=i) for i in range(p.days)]
    common = [nsinv(u(p.seed, t, 0, 1)) for t in range(1, p.days + 1)]

    columns: dict[str, list[float]] = {}
    for m in range(MAX_MINES):
        if not names[m]:
            continue
        slot = m + 1
        z = nsinv(u(p.seed, 0, slot, 2))
        out = []
        for i, d in enumerate(dates):
            t = i + 1
            eps = math.sqrt(c) * common[i] + math.sqrt(1 - c) * nsinv(u(p.seed, t, slot, 1))
            z = rho * z + math.sqrt(1 - rho ** 2) * eps
            weekday = p.weekday[d.isoweekday() - 1]
            trend = max(0.0, 1 + p.growth * (t - 1)) if p.trend == "Linear" else (1 + p.growth) ** (t - 1)
            factor = 1.0
            for e, ev in enumerate(p.events[:MAX_EVENTS]):
                factor *= 1 + (ev.factor - 1) * event_weight(ev, serial(d)) * hits[e][m]
            out.append(round(max(0.0, base_value(p, z)) * weekday * trend * factor, 2))
        columns[names[m]] = out
    total = [round(sum(col[i] for col in columns.values()), 2) for i in range(p.days)]
    return {"dates": [d.isoformat() for d in dates], "mines": columns, "total": total, "hits": hits}


def events_table(p: Params) -> list[dict]:
    hits = event_hits(p)
    names = (p.mines + [""] * MAX_MINES)[:MAX_MINES]
    rows = []
    for e, ev in enumerate(p.events):
        rows.append({
            "id": e + 1, "day": ev.day.isoformat(), "duration": ev.duration, "factor": ev.factor,
            "probability": ev.probability, "mines": ev.mines, "shape": ev.shape,
            "affected": [names[m] for m in range(MAX_MINES) if hits[e][m]],
        })
    return rows


if __name__ == "__main__":
    params = Params()
    data = generate(params)
    sample = {
        "source": "offline sample generated by generator/model.py with the default spreadsheet parameters",
        "dates": data["dates"], "mines": data["mines"], "events": events_table(params),
    }
    out = Path(__file__).resolve().parents[1] / "dashboard" / "public" / "sample-data.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(sample, indent=1))
    print("wrote", out)
    for i in (0, 1, 8, 9, 10, 18, 39):
        print(data["dates"][i], {k: v[i] for k, v in data["mines"].items()}, data["total"][i])
    print("hits:", [r[:3] for r in data["hits"][:4]])
