import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* H3 Timeline Notes.
 *
 * Scrub, drop a marker, type what changes there. The rail's faint dots are
 * H3's 5 + 17n frame grid — a marker between dots won't land where it looks
 * like it will, so the readout says so.
 */

const VERSION = "0.6.1";
console.log(`[H3 Timeline Notes] widget ${VERSION} loaded`);

const GRID_BASE = 5;
const GRID_STEP = 17;
const MIN_PANEL = 360;
// Title bar plus the socket rows above the panel. The panel takes whatever
// node height is left, so dragging the node taller grows the notes list.
const CHROME_HEIGHT = 110;

const uid = () => `n${Math.random().toString(36).slice(2, 9)}`;
const snapGrid = (f) => (f <= GRID_BASE ? GRID_BASE : GRID_BASE + Math.round((f - GRID_BASE) / GRID_STEP) * GRID_STEP);

function timecode(frame, fps) {
  const ms = Math.round((frame / fps) * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

const CSS = `
.h3f { display:flex; flex-direction:column; gap:8px; padding:8px;
  height:100%; overflow-y:auto; box-sizing:border-box;
  font:11px/1.45 var(--font-family, system-ui, sans-serif); color:var(--input-text,#ddd); }
.h3f-bar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.h3f-bar button { background:var(--comfy-input-bg,#222); color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#444); border-radius:3px; padding:3px 8px;
  cursor:pointer; font-size:11px; }
.h3f-bar button:hover { border-color:var(--fg-color,#888); }
.h3f-bar button:focus-visible { outline:2px solid #5ec8f0; outline-offset:1px; }
.h3f-set { display:flex; align-items:center; gap:10px; flex-wrap:wrap; opacity:.85; }
.h3f-set label { display:flex; align-items:center; gap:4px; cursor:pointer; user-select:none; }
.h3f-set input[type=number] { width:52px; background:var(--comfy-input-bg,#222);
  color:var(--input-text,#ddd); border:1px solid var(--border-color,#444);
  border-radius:3px; padding:2px 4px; font:11px var(--font-family,system-ui,sans-serif); }
.h3f-set input[type=checkbox] { accent-color:#5ec8f0; margin:0; }
.h3f-set select { background:var(--comfy-input-bg,#222); color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#444); border-radius:3px; padding:2px 4px;
  font:11px var(--font-family,system-ui,sans-serif); }
.h3f-gap { display:flex; align-items:center; gap:6px; }
.h3f-gap input { flex:1; background:var(--comfy-input-bg,#222); color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#444); border-radius:3px; padding:3px 5px;
  font:11px var(--font-family,system-ui,sans-serif); }
.h3f-read { margin-left:auto; font-variant-numeric:tabular-nums; opacity:.75; }
.h3f-read b { color:#5ec8f0; font-weight:600; }
.h3f-stage { flex:0 0 auto; max-height:46%; position:relative; background:#000; border:1px solid var(--border-color,#444);
  border-radius:3px; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center;
  overflow:hidden; }
.h3f-stage img, .h3f-stage video { width:100%; height:100%; object-fit:contain; }
.h3f-empty { opacity:.4; text-align:center; padding:0 16px; }
.h3f-rail { width:100%; height:52px; display:block; cursor:crosshair;
  border:1px solid var(--border-color,#444); border-radius:3px; background:#151515; }
.h3f-list { display:flex; flex-direction:column; gap:3px; flex:1; min-height:60px; overflow-y:auto; }
.h3f-note { display:flex; align-items:flex-start; gap:6px; padding:4px 6px; border-radius:3px;
  background:var(--comfy-input-bg,#1e1e1e); border-left:2px solid #5ec8f0; }
.h3f-note.off { border-left-color:#e8a13a; }
.h3f-note.active { background:#2a2f33; box-shadow:inset 0 0 0 1px #5ec8f055; }
.h3f-note input { flex:1; background:none; border:none; color:var(--input-text,#ddd);
  font:11px/1.45 var(--font-family,system-ui,sans-serif); padding:0; }
.h3f-note input:focus { outline:none; }
.h3f-note code { opacity:.55; font-size:10px; cursor:pointer; white-space:nowrap; }
.h3f-note button { background:none; border:none; color:#c66; cursor:pointer; padding:0 2px; }
.h3f-note button.range { color:#5ec8f0; opacity:.6; font-size:13px; line-height:1; }
.h3f-note button.range:hover { opacity:1; }
.h3f-note button.range.on { opacity:1; color:#7ad9a5; }
.h3f-hint { opacity:.45; padding:4px 2px; }
`;

class TimelineWidget {
  constructor(node, store, widgets = {}) {
    this.node = node;
    this.store = store;
    this.widgets = widgets;         // native widgets, hidden and mirrored above
    this.snapOn = true;
    this.frame = 0;
    this.fps = 24;
    this.totalFrames = 243;
    this.images = [];
    this.data = this.load();
    this.build();
    this.fps = this.widgets.fps?.value ?? 24;
    if (!this.strip) this.recomputeLength();
    this.render();
  }

  /** Grid snapping only applies when the toggle is on. */
  snap(frame) {
    return this.snapOn ? snapGrid(frame) : frame;
  }

  load() {
    try {
      return { notes: [], ...JSON.parse(this.store.value || "{}") };
    } catch {
      return { notes: [] };
    }
  }

  save() {
    this.data.fps = this.fps;
    this.data.total_frames = this.totalFrames;
    this.store.value = JSON.stringify(this.data);
    this.node.graph?.setDirtyCanvas(true, true);
  }

  /* ------------------------------------------------------------ dom */

  build() {
    const root = document.createElement("div");
    root.className = "h3f";
    if (!document.getElementById("h3f-styles")) {
      const style = document.createElement("style");
      style.id = "h3f-styles";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const bar = document.createElement("div");
    bar.className = "h3f-bar";

    bar.append(
      Object.assign(this.button("Add note", () => this.addNote()), {
        title: "Mark a point at the playhead (I or K). Scrub on and press O to make it a range.",
      }),
      this.button("Copy text", () => this.copyText())
    );

    this.readout = document.createElement("div");
    this.readout.className = "h3f-read";
    bar.appendChild(this.readout);

    const stage = document.createElement("div");
    stage.className = "h3f-stage";
    this.img = document.createElement("img");
    this.img.style.display = "none";
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.style.display = "none";
    this.placeholder = document.createElement("div");
    this.placeholder.className = "h3f-empty";
    this.placeholder.textContent =
      "Connect frames to the images input and queue once. You can also drop a file here.";
    stage.append(this.img, this.video, this.placeholder);
    stage.ondragover = (e) => e.preventDefault();
    stage.ondrop = (e) => {
      e.preventDefault();
      this.openMedia(e.dataTransfer?.files);
    };

    this.canvas = document.createElement("canvas");
    this.canvas.className = "h3f-rail";
    this.canvas.onpointerdown = (e) => this.scrubStart(e);

    this.list = document.createElement("div");
    this.list.className = "h3f-list";

    root.tabIndex = 0;
    root.onkeydown = (e) => this.onKey(e);
    // Clicking the rail should give the panel focus so shortcuts work.
    root.onpointerdown = (e) => {
      if (e.target.tagName !== "INPUT") root.focus({ preventScroll: true });
    };
    root.append(bar, this.buildSettings(), stage, this.canvas, this.list);
    this.el = root;
  }

  buildSettings() {
    const row = document.createElement("div");
    row.className = "h3f-set";

    const check = (name, label, onSet, tip) => {
      const w = this.widgets[name];
      if (!w) return;
      const wrap = document.createElement("label");
      if (tip) wrap.title = tip;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!w.value;
      box.onchange = () => {
        w.value = box.checked;
        onSet?.(box.checked);
        this.render();
      };
      wrap.append(box, document.createTextNode(label));
      row.appendChild(wrap);
    };

    const fmt = this.widgets.output_format;
    if (fmt) {
      const wrap = document.createElement("label");
      wrap.title =
        "instants — At MM:SS.mmm, ... (what you have been using)\n" +
        "shots — [Shot N] cut format, the documented pattern for real cuts\n" +
        "segments — [0s-3s] windows, continuous with no gaps\n" +
        "beats — prose timing for one continuous take, no cut syntax";
      const sel = document.createElement("select");
      for (const opt of ["instants", "shots", "segments", "beats"]) {
        const o = document.createElement("option");
        o.value = o.textContent = opt;
        sel.appendChild(o);
      }
      sel.value = fmt.value;
      sel.onchange = () => {
        fmt.value = sel.value;
        this.format = sel.value;
        this.render();
      };
      wrap.append(document.createTextNode("format"), sel);
      row.appendChild(wrap);
      this.format = fmt.value;
    }

    check(
      "snap_to_h3_grid",
      "snap 5+17n",
      (v) => (this.snapOn = v),
      "Round each marker to H3's latent frame positions: 5, 22, 39, 56, 73, 90 ...\n" +
      "Off keeps the exact frame you scrubbed to."
    );
    check("timestamps", "timestamps", null, "Off writes plain ordered sentences with no 'At MM:SS.mmm,'.");

    this.snapOn = !!this.widgets.snap_to_h3_grid?.value;

    const gapWidget = this.widgets.gap_text;
    if (gapWidget) {
      this.gapRow = document.createElement("div");
      this.gapRow.className = "h3f-gap";
      const label = document.createElement("span");
      label.textContent = "fill gaps with";
      label.style.opacity = ".6";
      const input = document.createElement("input");
      input.value = gapWidget.value ?? "";
      input.placeholder = "leave blank to warn instead of filling";
      input.oninput = () => {
        gapWidget.value = input.value;
        this.node.graph?.setDirtyCanvas(true, true);
      };
      this.gapRow.append(label, input);
    }

    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.gap = "6px";
    wrapper.append(row);
    if (this.gapRow) wrapper.append(this.gapRow);
    return wrapper;
  }

  recomputeLength() {
    const secs = this.widgets.duration_seconds?.value ?? 10;
    this.totalFrames = Math.max(1, Math.round(secs * this.fps));
  }

  button(label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  /* ---------------------------------------------------------- media */

  /** Frames sent up by the node after a queue, from the connected IMAGE input. */
  loadFrames(frames, totalFrames) {
    if (!frames?.length) return;
    this.revoke();
    // Each entry knows its real frame index, so a subsampled strip still maps
    // the playhead to the right picture.
    this.strip = frames.map((f) => ({
      frame: f.frame ?? 0,
      url: api.apiURL(
        `/view?filename=${encodeURIComponent(f.filename)}` +
        `&subfolder=${encodeURIComponent(f.subfolder ?? "")}&type=${f.type ?? "temp"}`
      ),
    }));
    if (totalFrames) this.totalFrames = totalFrames;
    this.video.style.display = "none";
    this.img.style.display = "";
    this.placeholder.style.display = "none";
    this.seek(this.frame);
    this.render();
  }

  openMedia(files) {
    if (!files?.length) return;
    const list = [...files];

    const video = list.find((f) => f.type.startsWith("video/"));
    if (video) return this.openVideo(video);

    this.revoke();
    this.strip = null;
    // Filenames usually carry the frame order (frame_0001.png); byte order does not.
    this.images = list
      .filter((f) => f.type.startsWith("image/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => URL.createObjectURL(f));

    if (!this.images.length) return;
    this.video.style.display = "none";
    this.img.style.display = "";
    this.placeholder.style.display = "none";
    this.seek(0);
  }

  openVideo(file) {
    this.revoke();
    this.videoUrl = URL.createObjectURL(file);
    this.video.src = this.videoUrl;
    this.video.style.display = "";
    this.img.style.display = "none";
    this.placeholder.style.display = "none";

    this.video.onloadedmetadata = () => {
      this.totalFrames = Math.max(1, Math.round(this.video.duration * this.fps));
      this.seek(0);
      this.render();
    };
    // timeupdate fires at ~4Hz and the playhead visibly lags; rVFC is exact.
    if (this.video.requestVideoFrameCallback) {
      const tick = (_, meta) => {
        this.frame = Math.round(meta.mediaTime * this.fps);
        this.drawRail();
        this.updateReadout();
        this.video.requestVideoFrameCallback(tick);
      };
      this.video.requestVideoFrameCallback(tick);
    }
  }

  revoke() {
    this.images.forEach(URL.revokeObjectURL);
    this.images = [];
    this.strip = null;
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = null;
  }

  seek(frame) {
    this.frame = Math.max(0, Math.min(frame, this.totalFrames - 1));
    if (this.strip?.length) {
      // Nearest strip entry by real frame index.
      let best = this.strip[0];
      for (const s of this.strip) {
        if (Math.abs(s.frame - this.frame) < Math.abs(best.frame - this.frame)) best = s;
      }
      if (this.img.src !== best.url) this.img.src = best.url;
    } else if (this.images.length) {
      // Map the playhead across however many stills were loaded.
      const i = Math.round((this.frame / Math.max(1, this.totalFrames - 1)) * (this.images.length - 1));
      this.img.src = this.images[i];
    } else if (this.videoUrl) {
      this.video.currentTime = this.frame / this.fps;
    }
    this.drawRail();
    this.updateReadout();
  }

  /* ---------------------------------------------------------- notes */

  addNote() {
    console.log(`[H3 Timeline Notes] addNote at frame ${this.frame}`);
    const note = { id: uid(), frame: this.frame, end_frame: null, text: "" };
    this.data.notes.push(note);
    this.activeId = note.id;
    this.save();
    this.render();
    // Focus the row that was just added so it can be typed into immediately.
    const rows = this.list.querySelectorAll("input");
    rows[rows.length - 1]?.focus();
  }

  /** A note with an end frame reads "From X to Y"; without one, "At X". */
  toggleRange(note) {
    if (note.end_frame != null) {
      note.end_frame = null;
    } else if (this.frame === note.frame) {
      // Nothing to span — the playhead hasn't moved off the start.
      return;
    } else if (this.frame < note.frame) {
      // Scrubbed backwards: treat the playhead as the new start.
      note.end_frame = note.frame;
      note.frame = this.frame;
    } else {
      note.end_frame = this.frame;
    }
    this.save();
    this.render();
  }

  removeNote(id) {
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    this.save();
    this.render();
  }

  copyText() {
    const text = [...this.data.notes]
      .sort((a, b) => a.frame - b.frame)
      .filter((n) => n.text.trim())
      .map((n) => {
        const body = n.text.trim().replace(/\.$/, "");
        const clause = `${body.charAt(0).toLowerCase()}${body.slice(1)}`;
        const start = timecode(this.snap(n.frame), this.fps);
        return n.end_frame != null && n.end_frame > n.frame
          ? `From ${start} to ${timecode(this.snap(n.end_frame), this.fps)}, ${clause}.`
          : `At ${start}, ${clause}.`;
      })
      .join("\n");
    navigator.clipboard?.writeText(text);
  }

  /* ---------------------------------------------------- interaction */

  scrubStart(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      this.seek(Math.round(ratio * (this.totalFrames - 1)));
    };
    move(e);
    this.canvas.onpointermove = move;
    this.canvas.onpointerup = () => (this.canvas.onpointermove = null);
  }

  onKey(e) {
    // Typing into a note must never trigger shortcuts.
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return;

    if (e.repeat) return;            // holding a key must not spawn a row per tick

    const key = e.key.toLowerCase();
    const step = e.shiftKey ? GRID_STEP : 1;

    if (e.key === "ArrowLeft") this.seek(this.frame - step);
    else if (e.key === "ArrowRight") this.seek(this.frame + step);
    else if (key === "k" || key === "i") this.addNote();
    else if (key === "o") this.setOut();
    else return;
    e.preventDefault();
  }

  /** Mark a row active without rebuilding the list. */
  setActive(id) {
    this.activeId = id;
    for (const row of this.list.children) {
      row.classList?.toggle("active", row.dataset.noteId === id);
    }
  }

  /** The note I and O act on: whichever was last touched, else the one
   *  the playhead is sitting in or just after. */
  target() {
    const active = this.data.notes.find((n) => n.id === this.activeId);
    if (active) return active;
    const before = this.data.notes
      .filter((n) => n.frame <= this.frame)
      .sort((a, b) => b.frame - a.frame);
    return before[0] ?? null;
  }

  setOut() {
    const n = this.target();
    if (!n) return;
    if (this.frame > n.frame) {
      n.end_frame = this.frame;
    } else if (this.frame < n.frame) {
      // Marked out before in: treat the playhead as the new in point.
      n.end_frame = n.frame;
      n.frame = this.frame;
    } else {
      return;
    }
    this.activeId = n.id;
    this.save();
    this.render();
  }

  /* ----------------------------------------------------------- draw */

  drawRail() {
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const x = (f) => (f / Math.max(1, this.totalFrames - 1)) * w;

    ctx.strokeStyle = "#2e2e2e";
    ctx.fillStyle = "#666";
    ctx.font = "9px system-ui";
    for (let s = 0; s * this.fps < this.totalFrames; s++) {
      const px = x(s * this.fps);
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, 8);
      ctx.stroke();
      if (s % 2 === 0) ctx.fillText(`${s}s`, px + 2, 16);
    }

    // H3 grid — the positions a marker can actually land on
    ctx.fillStyle = "#3a3a3a";
    for (let f = GRID_BASE; f < this.totalFrames; f += GRID_STEP) {
      ctx.fillRect(x(f) - 0.5, h - 8, 1, 4);
    }

    for (const n of this.data.notes) {
      const a = x(this.snap(n.frame));
      if (n.end_frame != null && n.end_frame > n.frame) {
        const b = x(this.snap(n.end_frame));
        ctx.fillStyle = "#7ad9a555";
        ctx.fillRect(a, h - 30, Math.max(2, b - a), 20);
        ctx.fillStyle = "#7ad9a5";
        ctx.fillRect(a - 1, h - 30, 2, 20);
        ctx.fillRect(b - 1, h - 30, 2, 20);
      } else {
        ctx.fillStyle = "#5ec8f0";
        ctx.fillRect(a - 1, h - 30, 2, 20);
      }
    }

    ctx.strokeStyle = "#ff4d4d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(this.frame), 0);
    ctx.lineTo(x(this.frame), h);
    ctx.stroke();
  }

  updateReadout() {
    const onGrid = !this.snapOn || (this.frame >= GRID_BASE && (this.frame - GRID_BASE) % GRID_STEP === 0);
    this.readout.innerHTML =
      `frame <b>${this.frame}</b> / ${this.totalFrames} &nbsp; ${timecode(this.frame, this.fps)}` +
      (onGrid ? "" : ` &nbsp; <span class="h3f-hint">snaps to ${timecode(this.snap(this.frame), this.fps)}</span>`);
  }

  render() {
    // The gap filler only means anything for continuous segment output.
    if (this.gapRow) this.gapRow.style.display = this.format === "segments" ? "" : "none";

    this.list.innerHTML = "";
    const notes = [...this.data.notes].sort((a, b) => a.frame - b.frame);

    if (!notes.length) {
      const hint = document.createElement("div");
      hint.className = "h3f-hint";
      hint.textContent = "Press I (or K) to mark a point, scrub on, then press O to close the range.";
      this.list.appendChild(hint);
    }

    for (const n of notes) {
      const row = document.createElement("div");
      const snapped = this.snap(n.frame);
      row.className = `h3f-note${snapped === n.frame ? "" : " off"}` +
        (n.id === this.activeId ? " active" : "");
      row.dataset.noteId = n.id;
      row.onpointerdown = (e) => {
        // Let the row's own buttons handle their clicks untouched.
        if (e.target.closest("button")) return;
        this.setActive(n.id);
      };

      const ranged = n.end_frame != null && n.end_frame > n.frame;
      const time = document.createElement("code");
      time.textContent = ranged
        ? `From ${timecode(snapped, this.fps)} to ${timecode(this.snap(n.end_frame), this.fps)},`
        : `At ${timecode(snapped, this.fps)},`;
      time.title = "Click to move the playhead here";
      time.onclick = () => this.seek(n.frame);

      const input = document.createElement("input");
      input.value = n.text;
      input.placeholder = "what changes here";
      input.onfocus = () => this.setActive(n.id);
      input.oninput = () => {
        n.text = input.value;
        this.save();
      };

      const rangeBtn = this.button(ranged ? "↔" : "→", () => this.toggleRange(n));
      rangeBtn.className = `range${ranged ? " on" : ""}`;
      rangeBtn.title = ranged
        ? "Clear the out point and make this an instant"
        : "Set the out point at the playhead (or press O)";

      row.append(time, input, rangeBtn, this.button("×", () => this.removeNote(n.id)));
      this.list.appendChild(row);
    }

    this.drawRail();
    this.updateReadout();
    this.save();
  }
}

if (window.__h3TimelineRegistered) {
  console.warn("[H3 Timeline Notes] extension loaded more than once");
}
window.__h3TimelineRegistered = true;

app.registerExtension({
  name: "h3.promptforge.timeline",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3TimelineNotes") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);

      if (this.h3Timeline) {
        console.warn("[H3 Timeline Notes] node initialised twice — ignoring the second pass");
        return;
      }

      const store = this.widgets.find((w) => w.name === "timeline_data");
      if (!store) return;

      const hide = (w) => {
        if (!w) return;
        w.hidden = true;                 // frontend >= 1.16
        w.origType = w.type;
        w.type = "hidden";               // older frontends
        w.computeSize = () => [0, -4];
        w.onDrawBackground = () => {};
        w.draw = () => {};
        if (w.inputEl) w.inputEl.style.display = "none";
      };

      // The store must NOT use hide(): newer frontends drop `hidden` widgets
      // from widgets_values, so the JSON would silently stop reaching Python.
      // Shrink it to nothing instead, and pin serialisation explicitly.
      store.computeSize = () => [0, -4];
      store.draw = () => {};
      store.onDrawBackground = () => {};
      if (store.inputEl) store.inputEl.style.display = "none";
      store.serializeValue = () => store.value;

      const natives = {};
      for (const name of ["fps", "duration_seconds", "snap_to_h3_grid", "timestamps",
                          "output_format", "gap_text"]) {
        const w = this.widgets.find((x) => x.name === name);
        natives[name] = w;
        hide(w);
        if (w) w.serializeValue = () => w.value;
      }

      const node = this;
      const panelHeight = () => Math.max(MIN_PANEL, node.size[1] - CHROME_HEIGHT);

      const widget = new TimelineWidget(this, store, natives);
      const dom = this.addDOMWidget("h3_timeline", "div", widget.el, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => MIN_PANEL,
        getHeight: panelHeight,
      });
      // Older frontends size DOM widgets from computeSize alone; without this
      // the node reports zero height and the panel renders outside its frame.
      dom.computeSize = (width) => [width, panelHeight()];

      this.h3Timeline = widget;
      this.size = [Math.max(this.size[0], 420), MIN_PANEL + CHROME_HEIGHT + 80];

      const onResize = this.onResize;
      this.onResize = function (size) {
        onResize?.apply(this, arguments);
        // Stop the node shrinking past what the panel needs.
        if (size[1] < MIN_PANEL + CHROME_HEIGHT) size[1] = MIN_PANEL + CHROME_HEIGHT;
        widget.drawRail();
      };

      // clientWidth is 0 on the first frame, so the rail draws blank unless
      // it redraws once the element is actually laid out.
      const ro = new ResizeObserver(() => widget.drawRail());
      ro.observe(widget.el);
      widget.resizeObserver = ro;

      requestAnimationFrame(() => widget.render());
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const frames = message?.h3_frames;
      const total = message?.h3_total?.[0];
      if (frames?.length) this.h3Timeline?.loadFrames(frames, total);
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.h3Timeline?.resizeObserver?.disconnect();
      this.h3Timeline?.revoke();
      onRemoved?.apply(this, arguments);
    };
  },
});
