"""Frame <-> timecode conversion and MiniMax H3 frame-grid snapping.

H3 works on a latent frame grid of 5 + 17n:  5, 22, 39, 56, 73, ... 243, ...
Total clip lengths land on the same grid, which is why 10.0s at 24 fps is
243 frames rather than 240.

Everything upstream of the compiler stores integer frames. Timecodes are
derived only at emit time, so changing fps never corrupts stored markers.
"""

from __future__ import annotations

DEFAULT_FPS = 24.0
GRID_BASE = 5
GRID_STEP = 17


def grid_positions(total_frames: int) -> list[int]:
    """Every valid H3 grid frame inside a clip of `total_frames`."""
    out, f = [], GRID_BASE
    while f < max(total_frames, 1):
        out.append(f)
        f += GRID_STEP
    return out


def snap_to_grid(frame: int, mode: str = "nearest") -> int:
    """Snap a frame index onto the H3 grid.

    mode: 'nearest' | 'floor' | 'ceil'
    """
    if frame <= GRID_BASE:
        return GRID_BASE
    offset = frame - GRID_BASE
    if mode == "floor":
        n = offset // GRID_STEP
    elif mode == "ceil":
        n = -(-offset // GRID_STEP)
    else:
        n = round(offset / GRID_STEP)
    return GRID_BASE + int(n) * GRID_STEP


def seconds_to_frames(seconds: float, fps: float = DEFAULT_FPS, snap: bool = True) -> int:
    """10.0s @ 24fps -> 243 when snapping, 240 when not."""
    raw = int(round(seconds * fps))
    return snap_to_grid(raw, "ceil") if snap else raw


def frames_to_seconds(frame: int, fps: float = DEFAULT_FPS) -> float:
    return frame / max(fps, 1e-6)


def frame_to_timecode(frame: int, fps: float = DEFAULT_FPS) -> str:
    """Emit the MM:SS.mmm form the H3 prompt spec expects for cut times."""
    total_ms = int(round(frames_to_seconds(frame, fps) * 1000.0))
    minutes, rem_ms = divmod(total_ms, 60_000)
    seconds, ms = divmod(rem_ms, 1000)
    return f"{minutes:02d}:{seconds:02d}.{ms:03d}"


def timecode_to_frame(tc: str, fps: float = DEFAULT_FPS) -> int:
    mm, rest = tc.split(":", 1)
    ss, ms = rest.split(".", 1)
    total_s = int(mm) * 60 + int(ss) + int(ms) / 1000.0
    return int(round(total_s * fps))
