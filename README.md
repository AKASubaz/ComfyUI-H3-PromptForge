# H3 Timeline Notes

Mark moments on a video timeline and get timestamped prompt text out. Built for
MiniMax H3, where changing one moment means naming the second it happens at.

```
At 00:00.917, she closes her mouth.
At 00:02.333, she dances.
At 00:03.042, she flies.
```

Instead of guessing which second to write, scrub to the frame, drop a note, and
type what changes there.

## Install

1. Extract `ComfyUI-H3-PromptForge` into your `custom_nodes` folder:
   `...\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-H3-PromptForge\`
   `__init__.py` must sit directly inside that folder, not in another folder
   of the same name.
2. Fully close ComfyUI — including the console window, not just the browser tab.
3. Start it again, then hard-refresh the browser with **Ctrl+Shift+R**.

No dependencies beyond ComfyUI itself. Nodes appear under **H3 PromptForge**.

## Use

```
Load Video (VideoHelperSuite) ──IMAGE──► H3 Timeline Notes ──prompt──► anywhere
```

1. Connect frames to `images` and **queue once**. Frames can't reach the browser
   until the node runs, so this first pass is what fills the preview.
2. Scrub the timeline. Click **Add note** (or press `N`) at each moment you want
   to change, and type what happens there.
3. **Copy text** puts the whole thing on your clipboard. No second queue needed.

Click a note's timestamp to jump the playhead back to it. Click a row to make it
the active one — `I` and `O` act on that.

| key | |
|---|---|
| `I` or `K` | mark a point at the playhead |
| `O` | close the range at the playhead |
| `←` `→` | step one frame |
| `Shift` + `←` `→` | step one grid position |

So the loop is: `I` where it starts, scrub, `O` where it ends, type what happens.

A note with an out point reads `From 00:01.417 to 00:02.042, she dances.`
Without one it reads `At 00:01.417, she closes her mouth.` Mark out before in and
the playhead becomes the new in point instead of being rejected.

## Output formats

Pick with the **format** dropdown.

| | |
|---|---|
| `instants` | `At 00:01.417, she dances.` |
| `shots` | `[Shot 1] ...` then `[Shot 2] At 00:02.333, ...` — every note becomes a cut |
| `segments` | `[0.9s-1.6s] ...` continuous windows, gaps auto-filled |
| `beats` | `About 1.4 seconds in, ...` — prose timing, no cut syntax |

For a single continuous take — lip-sync, dubbing, one-shot edits — use **beats**.
H3's docs say not to timestamp continuous action inside a shot, because
`At 00:02.333,` is the cut syntax and the model may cut there. `beats` says when
without borrowing it. Use `shots` only when your notes really are shot changes.

`segments` reveals a **fill gaps with** field, since that format needs an
unbroken timeline from 0 to the clip end. Every second you didn't mark gets
declared unchanged, which is what stops the model reinventing those parts.

## Keeping an existing prompt

Wire your current prompt into the **prefix** input and the timing lines are
appended below it. Necessary for reference-mode work — without it the node
replaces your prompt and you lose `<Picture 1>`, `<Video 1>`, `<Audio 1>`.

## The two tick boxes

**snap 5+17n** rounds each marker to H3's latent frame positions —
5, 22, 39, 56, 73, 90 and so on. A marker at frame 60 becomes 56, so
`00:02.500` becomes `00:02.333`. Turn it off to keep the exact frame you
scrubbed to.

Whether snapping helps is unsettled. The grid is real for where conditioning
attaches in latent space; whether a *timestamp inside a prompt* needs to respect
it is a different question, since H3 reads that as language. Try a clip both ways.

**timestamps** off writes plain ordered sentences with no `At MM:SS.mmm,`.
Applies to `instants` only.

## Notes

The `debug` output shows exactly what reached Python — the flags, every note
with its frames, and the raw JSON. Wire it to a text preview when something
comes out wrong.

Frames are subsampled for preview — up to 150 stills at 360px, written to
ComfyUI's temp folder. Each one keeps its real frame index, so scrubbing lands on
the right picture. Nothing is forwarded downstream; `images` is preview only.

Timecodes come from the node's `fps` (hidden, default 24). If your video loader
runs at a different rate, every timestamp will be off by that ratio.

You can also drop an image sequence or video file straight onto the preview area
to scrub without queueing at all.

## What's inside

`compiler.py` holds a fuller implementation targeting H3's six-section
full-reference format — `subject_definitions`, `retention_analysis` and the rest.
It isn't wired to any node right now. It's there if the simple timestamp list
stops being enough.

MIT.
