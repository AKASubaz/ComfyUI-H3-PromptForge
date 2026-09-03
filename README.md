# ComfyUI-H3-PromptForge

Timing tools for MiniMax H3. Three nodes that let you point at a moment in the
footage instead of guessing which second it was.

- **H3 Timeline Notes** — mark moments on a timeline, get timestamped prompt text
- **H3 Curve Scheduler** — draw denoise per frame instead of one value for the shot
- **H3 Temporal Mask Curve** — the same idea applied to a mask

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOURNAME/ComfyUI-H3-PromptForge
```

Restart ComfyUI, then hard-refresh the browser. No dependencies beyond ComfyUI.
Nodes appear under **H3 PromptForge**.

---

## H3 Timeline Notes

Scrub the clip, mark the moments you want changed, type what happens there.

```
Load Video (VideoHelperSuite) ──IMAGE──► images
your existing prompt ──STRING──────────► prefix
                                          └──► prompt ──► wherever it goes
```

Frames can't reach the browser until the node runs, so **queue once** after
connecting `images`. The panel then fills and you can work.

| key | |
|---|---|
| `I` or `K` | mark a point at the playhead |
| `O` | close the range at the playhead |
| `←` `→` | step one frame |
| `Shift` + `←` `→` | step one grid position |

`I` where it starts, scrub, `O` where it ends, type. **Copy text** puts the
result on your clipboard without queueing.

### Output formats

| | |
|---|---|
| `instants` | `At 00:01.417, she dances.` |
| `shots` | `[Shot 1] ...` then `[Shot 2] At 00:02.333, ...` — every note becomes a cut |
| `segments` | `[0.9s-1.6s] ...` continuous windows, gaps auto-filled |
| `beats` | `About 1.4 seconds in, ...` — prose timing, no cut syntax |

For one continuous take — lip-sync, dubbing — use **beats**. H3's docs say not
to timestamp continuous action inside a shot, because `At 00:02.333,` is the cut
syntax and the model may cut there. Use `shots` only when the notes really are
shot changes.

`segments` reveals a **fill gaps with** field, since that format needs unbroken
coverage from 0 to the clip end. Every second you didn't mark gets declared
unchanged, which is what stops the model reinventing those parts.

Wire your existing prompt into **prefix** for reference-mode work, or the node
replaces it and you lose `<Picture 1>`, `<Video 1>`, `<Audio 1>`.

### snap 5+17n

Rounds markers to H3's latent frame positions — 5, 22, 39, 56 and so on. A
marker at frame 60 becomes 56. Turn it off to keep the exact frame you scrubbed
to. Whether snapping helps a *text* timestamp is unsettled; the grid is real for
where conditioning attaches, less obviously so for prose the model reads.

---

## H3 Curve Scheduler

Replaces **BasicScheduler** and **RandomNoise** together.

```
model ─────────────────► model            sigmas ──► SamplerCustomAdvanced.sigmas
Load Video ──IMAGE─────► images            noise ──► SamplerCustomAdvanced.noise
                                           debug ──► a text preview
```

Delete your `RandomNoise` node — this one carries the seed.

### Why the noise socket and not sigmas

SIGMAS is one value per *step*, shared by every frame. Nothing can put per-frame
data through it.

The sampler starts at `latent + noise × sigmas[0]`. Scale the **noise** per frame
and each frame gets its own effective starting sigma — frames with less injected
noise stay closer to the plate. That is per-frame denoise, and it leaves your
mask chain alone.

### Using it

Start with an empty curve. That is identical to `BasicScheduler` + `RandomNoise`,
and the debug output says so. Confirm your render matches, then pull points down.

Click empty space to add a point, drag to move, shift-click to delete. The thin
strip along the top of the curve scrubs, so scrubbing never drops a point.

The axis is in real denoise units — at `denoise 0.5` it reads 0 to 0.5. Points
store as 0–1 multipliers underneath, so changing `denoise` rescales the whole
curve proportionally and keeps the shape you drew.

**Points hold outward.** Before your first point the curve holds that value;
after your last it holds that one. Two points at 50 and 75 both at 0.3 gives you
0.3 across the entire clip. To dip only in the middle you need points on both
sides of the dip.

`hold` gives step blocks, `linear` and `smooth` give ramps.

### Caveats

The model is told one timestep for the whole latent, so a scaled-down frame is
under-noised relative to what the model expects. That reads as staying closer to
the input, which is the point — but push a frame far enough down and it goes
soft rather than simply calmer. Find that floor the way you'd find a denoise
floor.

Frames map onto latent positions evenly. H3's VAE groups frames unevenly, so
curve edges may land a frame or so off from where you drew them.

---

## H3 Temporal Mask Curve

Same curve, applied to a MASK instead. Each frame is scaled by the curve value.

```
your mask ──► mask ──► H3 Temporal Mask Curve ──► NKD Mask Ops ──► latent_mask
```

The other route to per-frame denoise: a mask value of 0.4 normally means the
sampler blends 40% denoised against 60% original at that position.

One caution specific to H3 — it takes the mask into its own forward and
regenerates a whole token as soon as any part is covered, so intermediate values
may behave as fully-on. If they do, use `hold` and treat it as on/off regions
rather than a curve.

---

## Notes

Preview frames are subsampled — up to 150 stills at 360px written to ComfyUI's
temp folder. Each keeps its real frame index so scrubbing lands on the right
picture. Nothing is forwarded downstream; `images` is preview only.

Every node has a `debug` output showing exactly what reached Python. Wire it to
a text preview when something looks wrong.

MIT.
