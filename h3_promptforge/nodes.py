"""Minimal timeline-to-text node.

One job: turn markers placed on a timeline into timestamped lines.

    At 00:04.208, he closes his mouth.
    At 00:07.208, he glances toward the door.

No shots, no reference labels, no encoder. The six-section full-reference
compiler still lives in compiler.py if it's ever wanted back.
"""

from __future__ import annotations

import json
import os
import random

from .timing import DEFAULT_FPS, seconds_to_frames, snap_to_grid, frame_to_timecode

CATEGORY = "H3 PromptForge"

# Cap what gets written to disk. A 10s clip is 243 frames; every one of them at
# full resolution is slow to write and pointless to scrub through.
PREVIEW_MAX_FRAMES = 150
PREVIEW_WIDTH = 360


def _save_previews(images):
    """Write a downscaled strip to ComfyUI's temp dir for the widget to fetch.

    Returns [] rather than raising if anything is unavailable -- a broken
    preview should never stop the text from being built.
    """
    try:
        import numpy as np
        from PIL import Image
        import folder_paths
    except ImportError:
        return []

    try:
        count = int(images.shape[0])
        if count == 0:
            return []

        subfolder = f"h3notes_{random.randint(0, 0xFFFFFFFF):08x}"
        target = os.path.join(folder_paths.get_temp_directory(), subfolder)
        os.makedirs(target, exist_ok=True)

        step = max(1, -(-count // PREVIEW_MAX_FRAMES))
        frames = []
        for i in range(0, count, step):
            arr = (images[i].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            img = Image.fromarray(arr)
            if img.width > PREVIEW_WIDTH:
                h = max(1, round(img.height * PREVIEW_WIDTH / img.width))
                img = img.resize((PREVIEW_WIDTH, h), Image.BILINEAR)
            name = f"f{i:06d}.webp"
            img.save(os.path.join(target, name), quality=72, method=4)
            frames.append({"filename": name, "subfolder": subfolder, "type": "temp", "frame": i})
        return frames
    except Exception:
        return []


def _clause(text: str) -> str:
    """Lowercase-leading, no terminal period -- it follows 'At 00:00.000,'."""
    text = (text or "").strip().rstrip(".")
    if not text:
        return ""
    # Leave labels and proper nouns alone.
    if text[0] == "<" or (len(text) > 1 and text[1].isupper()):
        return text
    return text[0].lower() + text[1:]


OUTPUT_FORMATS = ["instants", "shots", "segments", "beats"]


def _seconds(frame: int, fps: float) -> str:
    """0.917s — the shape H3's segment examples use, kept frame-precise."""
    text = f"{frame / max(fps, 1e-6):.3f}".rstrip("0").rstrip(".")
    return f"{text or '0'}s"


def format_beats(notes, fps: float) -> str:
    """Prose timing for a single continuous take.

    The guide says not to timestamp continuous action inside one shot -- a bare
    `At 00:02.333,` reads like a cut. For lip-sync and other single-take work
    this says when without borrowing the cut syntax.
    """
    lines = []
    for note in sorted(notes, key=lambda n: n.get("frame", 0)):
        body = _clause(note.get("text", ""))
        if not body:
            continue
        start = int(note.get("frame", 0))
        end = note.get("end_frame")
        a = f"{start / max(fps, 1e-6):.1f}".rstrip("0").rstrip(".")
        if end is not None and int(end) > start:
            b = f"{int(end) / max(fps, 1e-6):.1f}".rstrip("0").rstrip(".")
            lines.append(f"Between {a} and {b} seconds, {body}.")
        else:
            lines.append(f"About {a} seconds in, {body}.")
    return "\n".join(lines)


def format_shots(notes, fps: float) -> str:
    """[Shot 1] takes no timestamp; later shots open with their cut time.

    This is the documented pattern, but every note becomes a cut -- only use it
    when the notes really are shot changes.
    """
    lines = []
    for i, note in enumerate(sorted(notes, key=lambda n: n.get("frame", 0))):
        body = (note.get("text") or "").strip().rstrip(".")
        if not body:
            continue
        if not lines:
            lines.append(f"[Shot 1] {body[0].upper()}{body[1:]}.")
        else:
            clause = _clause(body)
            tc = frame_to_timecode(int(note.get("frame", 0)), fps)
            lines.append(f"[Shot {len(lines) + 1}] At {tc}, {clause}.")
    return "\n".join(lines)


def format_segments(notes, fps: float, total_frames: int, gap_text: str = ""):
    """[0s-3s] style windows: sequential, no gaps, no overlaps.

    Returns (text, warnings). A note without an out point runs until the next
    note starts. Overlaps are trimmed. Gaps are filled with `gap_text` so the
    timeline stays continuous, which the segment format requires.
    """
    ordered = [n for n in sorted(notes, key=lambda n: n.get("frame", 0)) if (n.get("text") or "").strip()]
    if not ordered:
        return "", ["No notes with text."]

    warnings, spans = [], []
    for i, note in enumerate(ordered):
        start = max(0, int(note.get("frame", 0)))
        end = note.get("end_frame")
        end = int(end) if end is not None else None

        next_start = int(ordered[i + 1].get("frame", 0)) if i + 1 < len(ordered) else total_frames
        if end is None:
            end = next_start                      # run until the next note begins
        if end > next_start:
            warnings.append(f"Trimmed '{note['text'][:30]}' — it overlapped the next note.")
            end = next_start
        end = min(end, total_frames)
        if end > start:
            spans.append([start, end, note["text"].strip().rstrip(".")])

    if not spans:
        return "", ["Every note collapsed to zero length."]

    # The format needs full coverage from 0 to the end of the clip.
    filled, cursor = [], 0
    for start, end, text in spans:
        if start > cursor:
            if gap_text.strip():
                filled.append([cursor, start, gap_text.strip()])
            else:
                warnings.append(f"Gap {_seconds(cursor, fps)}-{_seconds(start, fps)} left unfilled.")
        filled.append([start, end, text])
        cursor = end
    if cursor < total_frames:
        if gap_text.strip():
            filled.append([cursor, total_frames, gap_text.strip()])
        else:
            warnings.append(f"Clip ends at {_seconds(total_frames, fps)} but notes stop at {_seconds(cursor, fps)}.")

    lines = [
        f"[{_seconds(a, fps)}-{_seconds(b, fps)}] {t[0].upper()}{t[1:]}."
        for a, b, t in filled
    ]
    return "\n".join(lines), warnings


def format_notes(notes, fps: float, timestamps: bool = True) -> str:
    """A note with an end frame spans a range; without one it marks an instant."""
    lines = []
    for note in sorted(notes, key=lambda n: n.get("frame", 0)):
        body = _clause(note.get("text", ""))
        if not body:
            continue
        if not timestamps:
            lines.append(f"{body[0].upper()}{body[1:]}.")
            continue

        start = int(note.get("frame", 0))
        end = note.get("end_frame")
        if end is not None and int(end) > start:
            lines.append(
                f"From {frame_to_timecode(start, fps)} to "
                f"{frame_to_timecode(int(end), fps)}, {body}."
            )
        else:
            lines.append(f"At {frame_to_timecode(start, fps)}, {body}.")
    return "\n".join(lines)


class H3TimelineNotes:
    """Scrub, drop a marker, type what changes there. Out comes the text."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeline_data": ("STRING", {
                    "multiline": True,
                    "default": "{}",
                    "tooltip": "Written by the timeline widget.",
                }),
                "fps": ("FLOAT", {"default": DEFAULT_FPS, "min": 1.0, "max": 120.0, "step": 0.001}),
                "duration_seconds": ("FLOAT", {"default": 10.0, "min": 0.2, "max": 120.0, "step": 0.1}),
                "snap_to_h3_grid": ("BOOLEAN", {"default": True, "tooltip": "Snap markers to 5 + 17n frames."}),
                "timestamps": ("BOOLEAN", {"default": True, "tooltip": "Instants only. Off writes plain ordered sentences."}),
                "output_format": (OUTPUT_FORMATS, {
                    "default": "instants",
                    "tooltip": "instants: At MM:SS.mmm, ...  |  shots: [Shot N] cut format  |  "
                               "segments: [0s-3s] windows",
                }),
                "gap_text": ("STRING", {
                    "multiline": False,
                    "default": "the shot continues unchanged",
                    "tooltip": "Segments mode only. Fills time not covered by a note, since the "
                               "segment format needs an unbroken timeline.",
                }),
            },
            "optional": {
                "prefix": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Existing prompt to place above the timing lines. Wire your "
                               "reference-mode prompt here so the labels survive.",
                }),
                "images": ("IMAGE", {
                    "tooltip": "Frames to scrub. Queue once to load them into the timeline. "
                               "Never forwarded downstream.",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("prompt", "total_frames", "debug")
    FUNCTION = "build"
    CATEGORY = CATEGORY
    # Always execute, so connecting frames and re-queueing refreshes the strip
    # even when nothing downstream is wired up yet.
    OUTPUT_NODE = True

    def build(self, timeline_data, fps, duration_seconds, snap_to_h3_grid, timestamps,
              output_format, gap_text, prefix="", images=None):
        try:
            data = json.loads(timeline_data or "{}") or {}
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Timeline data is not valid JSON ({exc}). Reopen the node and re-save the timeline."
            ) from exc

        frames = _save_previews(images) if images is not None else []
        if images is not None:
            # A connected batch is the real clip length; the duration widget is
            # only a fallback for when nothing is wired in.
            total_frames = int(images.shape[0])
        else:
            total_frames = seconds_to_frames(duration_seconds, fps, snap=snap_to_h3_grid)

        notes = list(data.get("notes", []))

        if snap_to_h3_grid:
            for note in notes:
                note["frame"] = snap_to_grid(int(note.get("frame", 0)))
                if note.get("end_frame") is not None:
                    note["end_frame"] = snap_to_grid(int(note["end_frame"]))

        fmt_warnings = []
        if output_format == "shots":
            prompt = format_shots(notes, float(fps))
        elif output_format == "segments":
            prompt, fmt_warnings = format_segments(notes, float(fps), total_frames, gap_text)
        elif output_format == "beats":
            prompt = format_beats(notes, float(fps))
        else:
            prompt = format_notes(notes, float(fps), timestamps)

        if (prefix or "").strip():
            prompt = f"{prefix.rstrip()}\n{prompt}".strip()

        debug = (
            f"format={output_format}  snap={snap_to_h3_grid}  timestamps={timestamps}  fps={fps}  "
            f"duration={duration_seconds}  total_frames={total_frames}\n"
            f"notes received: {len(notes)}\n"
            + "\n".join(
                f"  frame={n.get('frame')}  end_frame={n.get('end_frame')}  text={n.get('text')!r}"
                for n in notes
            )
            + ("\n\n" + "\n".join(f"  ! {w}" for w in fmt_warnings) if fmt_warnings else "")
            + f"\n\nraw timeline_data ({len(timeline_data or '')} chars):\n{(timeline_data or '')[:900]}"
        )
        print("[H3 Timeline Notes]\n" + debug, flush=True)

        return {
            "ui": {"h3_frames": frames, "h3_total": [total_frames]},
            "result": (prompt, total_frames, debug),
        }


class H3PromptPreview:
    """Shows the built text without running anything downstream."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"prompt": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ()
    FUNCTION = "show"
    OUTPUT_NODE = True
    CATEGORY = CATEGORY

    def show(self, prompt):
        return {"ui": {"text": [prompt]}}


NODE_CLASS_MAPPINGS = {
    "H3TimelineNotes": H3TimelineNotes,
    "H3PromptPreview": H3PromptPreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3TimelineNotes": "H3 Timeline Notes",
    "H3PromptPreview": "H3 Prompt Preview",
}
