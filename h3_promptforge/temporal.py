"""Per-frame mask strength over time.

Sigma curves run over *steps* -- every frame shares one schedule, so they can't
say "denoise less here". The thing that can is the latent mask: it decides, per
latent position, how much gets regenerated. This node scales an existing mask
frame by frame, then hands it to NKD Mask Ops as usual so the mask still lands
on the model's real grid.

Open question this node is built to answer either way: MiniMax H3 takes the mask
into its own forward and regenerates a whole token as soon as any part of it is
covered. If that makes intermediate values behave as fully-on, `hold` mode gives
you honest on/off blocks instead of a curve that lies.
"""

from __future__ import annotations

import json

from .timing import DEFAULT_FPS, frame_to_timecode

CATEGORY = "H3 PromptForge"

INTERPOLATIONS = ["hold", "linear", "smooth"]


# ------------------------------------------------------------------ curve


def _smoothstep(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def sample_curve(points, frame: int, interpolation: str = "linear", default: float = 1.0) -> float:
    """Value of the curve at `frame`.

    `hold` keeps each point's value until the next one -- the right shape if
    H3 treats a covered token as fully regenerated regardless of mask value.
    """
    if not points:
        return default

    pts = sorted(points, key=lambda p: p["frame"])
    if frame <= pts[0]["frame"]:
        return float(pts[0]["value"])
    if frame >= pts[-1]["frame"]:
        return float(pts[-1]["value"])

    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if a["frame"] <= frame <= b["frame"]:
            if interpolation == "hold":
                return float(a["value"])
            span = max(1, b["frame"] - a["frame"])
            t = (frame - a["frame"]) / span
            if interpolation == "smooth":
                t = _smoothstep(t)
            return float(a["value"]) + (float(b["value"]) - float(a["value"])) * t
    return default


class H3TemporalMaskCurve:
    """Scale a mask over time with a drawn curve."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK", {"tooltip": "Your existing mask. Each frame is scaled by the curve."}),
                "curve_data": ("STRING", {"multiline": True, "default": "{}"}),
                "fps": ("FLOAT", {"default": DEFAULT_FPS, "min": 1.0, "max": 120.0, "step": 0.001}),
                "interpolation": (INTERPOLATIONS, {
                    "default": "linear",
                    "tooltip": "hold: step blocks. linear/smooth: ramps between points.",
                }),
                "default_value": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "Used where the curve has no points.",
                }),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "Frames to scrub. Queue once to load them. Not forwarded."}),
            },
        }

    RETURN_TYPES = ("MASK", "STRING")
    RETURN_NAMES = ("mask", "debug")
    FUNCTION = "apply"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def apply(self, mask, curve_data, fps, interpolation, default_value, images=None):
        from .nodes import _save_previews

        try:
            data = json.loads(curve_data or "{}") or {}
        except json.JSONDecodeError as exc:
            raise ValueError(f"Curve data is not valid JSON ({exc}).") from exc

        points = [p for p in data.get("points", []) if "frame" in p and "value" in p]

        if mask.dim() == 2:                      # a single mask, no batch axis
            mask = mask.unsqueeze(0)
        count = int(mask.shape[0])

        out = mask.clone()
        values = []
        for i in range(count):
            v = sample_curve(points, i, interpolation, default_value)
            v = min(1.0, max(0.0, v))
            values.append(v)
            if v != 1.0:
                out[i] = out[i] * v

        frames = _save_previews(images) if images is not None else []

        # Where the curve actually changes -- the only places behaviour differs.
        edges = [
            f"  frame {i} ({frame_to_timecode(i, fps)}): {values[i - 1]:.2f} -> {values[i]:.2f}"
            for i in range(1, count) if abs(values[i] - values[i - 1]) > 1e-4
        ]
        debug = (
            f"interpolation={interpolation}  points={len(points)}  frames={count}\n"
            f"min={min(values):.3f}  max={max(values):.3f}  mean={sum(values) / count:.3f}\n"
            + ("changes:\n" + "\n".join(edges[:40]) if edges else "curve is flat -- no per-frame difference")
        )
        print("[H3 Temporal Mask Curve]\n" + debug, flush=True)

        return {
            "ui": {"h3_frames": frames, "h3_total": [count]},
            "result": (out, debug),
        }


class H3LatentGridProbe:
    """Phase 0 diagnostic: how many frames collapse into one latent frame.

    Encodes a few tiny clips and reports where the latent frame count steps up.
    That boundary list is the real control resolution for any temporal mask --
    finer than that and the curve is describing something the model can't see.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": ("VAE",),
                "max_frames": ("INT", {"default": 40, "min": 2, "max": 200}),
                "probe_size": ("INT", {
                    "default": 64, "min": 32, "max": 256, "step": 8,
                    "tooltip": "Tiny on purpose -- only the temporal axis is being measured.",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report",)
    FUNCTION = "probe"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def probe(self, vae, max_frames, probe_size):
        import torch

        lines, groups, prev_t = [], [], None
        for n in range(1, max_frames + 1):
            pixels = torch.zeros((n, probe_size, probe_size, 3))
            try:
                latent = vae.encode(pixels)
            except Exception as exc:
                lines.append(f"{n:>3} frames -> encode failed: {exc}")
                break

            shape = tuple(latent.shape)
            # 5D is (B, C, T, H, W); 4D video latents put frames on the batch axis.
            t = int(latent.shape[2]) if latent.dim() == 5 else int(latent.shape[0])
            if t != prev_t:
                groups.append((n, t))
                lines.append(f"{n:>3} frames -> {t} latent frames   {shape}")
                prev_t = t

        report = ["Latent frames step up at these input counts:", *lines, ""]
        if len(groups) >= 3:
            sizes = [groups[i + 1][0] - groups[i][0] for i in range(len(groups) - 1)]
            report.append(f"First latent covers {groups[0][0]} frame(s).")
            report.append(f"Then groups of: {sizes}")
            if len(set(sizes)) == 1:
                secs = sizes[0] / 24.0
                report.append(f"Even grouping of {sizes[0]} -> finest control is ~{secs:.2f}s at 24fps.")
            else:
                report.append("Uneven grouping -- snap curve points to the boundaries above.")

        text = "\n".join(report)
        print("[H3 Latent Grid Probe]\n" + text, flush=True)
        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {
    "H3TemporalMaskCurve": H3TemporalMaskCurve,
    "H3LatentGridProbe": H3LatentGridProbe,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3TemporalMaskCurve": "H3 Temporal Mask Curve",
    "H3LatentGridProbe": "H3 Latent Grid Probe",
}


# ------------------------------------------------------- per-frame denoise


class CurveNoise:
    """Noise whose magnitude varies along the latent's temporal axis.

    SamplerCustomAdvanced begins at `latent + noise * sigmas[0]`. Scaling the
    noise per frame gives each frame its own effective starting sigma, which is
    per-frame denoise without touching the mask. The model is still told one
    timestep for the whole latent, so a scaled-down frame is under-noised
    relative to what the model expects -- that reads as staying closer to the
    input, which is the point, but push it far enough and it turns into mush.
    """

    def __init__(self, seed, values, report):
        self.seed = int(seed)
        self.values = values
        self.report = report

    def generate_noise(self, input_latent):
        import comfy.sample
        import torch

        samples = input_latent["samples"]
        noise = comfy.sample.prepare_noise(samples, self.seed, input_latent.get("batch_index", None))
        if not self.values:
            return noise

        # 5D video latents are (B, C, T, H, W); 4D put frames on the batch axis.
        axis = 2 if noise.dim() == 5 else 0
        length = noise.shape[axis]

        scales = torch.tensor(
            [self.values[min(len(self.values) - 1, round(i * (len(self.values) - 1) / max(1, length - 1)))]
             for i in range(length)],
            dtype=noise.dtype, device=noise.device,
        )
        shape = [1] * noise.dim()
        shape[axis] = length
        return noise * scales.reshape(shape)


class H3CurveScheduler:
    """Drop-in for BasicScheduler that also carries a per-frame noise curve."""

    @classmethod
    def INPUT_TYPES(cls):
        import comfy.samplers
        return {
            "required": {
                "model": ("MODEL",),
                "curve_data": ("STRING", {"multiline": True, "default": "{}"}),
                "scheduler": (comfy.samplers.SCHEDULER_NAMES, {"default": "beta"}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
                "denoise": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "Global denoise, same as BasicScheduler. The curve scales it per frame.",
                }),
                "noise_seed": ("INT", {"default": 12, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "fps": ("FLOAT", {"default": DEFAULT_FPS, "min": 1.0, "max": 120.0, "step": 0.001}),
                "interpolation": (INTERPOLATIONS, {"default": "linear"}),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "Frames to scrub. Queue once to load them. Not forwarded."}),
            },
        }

    RETURN_TYPES = ("SIGMAS", "NOISE", "STRING")
    RETURN_NAMES = ("sigmas", "noise", "debug")
    FUNCTION = "build"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def build(self, model, curve_data, scheduler, steps, denoise, noise_seed,
              fps, interpolation, images=None):
        import comfy.samplers
        import torch

        from .nodes import _save_previews

        try:
            data = json.loads(curve_data or "{}") or {}
        except json.JSONDecodeError as exc:
            raise ValueError(f"Curve data is not valid JSON ({exc}).") from exc

        points = [p for p in data.get("points", []) if "frame" in p and "value" in p]
        total = int(data.get("total_frames") or 0)
        if images is not None:
            total = int(images.shape[0])
        total = max(total, 1)

        # --- sigmas, exactly as BasicScheduler builds them
        if denoise <= 0.0:
            sigmas = torch.FloatTensor([])
        else:
            total_steps = steps if denoise >= 1.0 else int(steps / denoise)
            sigmas = comfy.samplers.calculate_sigmas(
                model.get_model_object("model_sampling"), scheduler, total_steps
            ).cpu()[-(steps + 1):]

        # --- per-frame noise scale
        # An empty curve means full denoise everywhere -- identical to BasicScheduler.
        values = [
            min(1.0, max(0.0, sample_curve(points, i, interpolation, 1.0)))
            for i in range(total)
        ]

        flat = max(values) - min(values) < 1e-4
        debug = (
            f"scheduler={scheduler}  steps={steps}  denoise={denoise}  seed={noise_seed}\n"
            f"curve points={len(points)}  frames={total}  interpolation={interpolation}\n"
            f"noise scale  min={min(values):.3f}  max={max(values):.3f}  mean={sum(values) / total:.3f}\n"
            f"effective denoise  min={min(values) * denoise:.3f}  max={max(values) * denoise:.3f}\n"
            f"sigmas[0]={float(sigmas[0]) if len(sigmas) else 0:.4f}  count={len(sigmas)}\n"
            + ("curve is flat -- identical to BasicScheduler + RandomNoise"
               if flat else
               "effective start sigma per frame ranges "
               f"{float(sigmas[0]) * min(values) if len(sigmas) else 0:.4f} "
               f"to {float(sigmas[0]) * max(values) if len(sigmas) else 0:.4f}")
        )
        print("[H3 Curve Scheduler]\n" + debug, flush=True)

        frames = _save_previews(images) if images is not None else []
        return {
            "ui": {"h3_frames": frames, "h3_total": [total]},
            "result": (sigmas, CurveNoise(noise_seed, values, debug), debug),
        }


NODE_CLASS_MAPPINGS["H3CurveScheduler"] = H3CurveScheduler
NODE_DISPLAY_NAME_MAPPINGS["H3CurveScheduler"] = "H3 Curve Scheduler"
