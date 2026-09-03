import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* H3 Temporal Mask Curve.
 *
 * Preview on top, curve strip below it on the same time axis. The curve is
 * kept out of the picture on purpose -- reading a value off a gradient laid
 * over a moving image is guesswork, and this is a number you have to trust.
 */

const VERSION = "0.4.0";
console.log(`[H3 Temporal Mask Curve] widget ${VERSION} loaded`);

const MIN_PANEL = 380;
const CHROME_HEIGHT = 120;
const CURVE_H = 130;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function timecode(frame, fps) {
  const ms = Math.round((frame / fps) * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

const CSS = `
.h3c { display:flex; flex-direction:column; gap:8px; padding:8px;
  height:100%; overflow-y:auto; box-sizing:border-box;
  font:11px/1.45 var(--font-family, system-ui, sans-serif); color:var(--input-text,#ddd); }
.h3c-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.h3c-bar button { background:var(--comfy-input-bg,#222); color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#444); border-radius:3px; padding:3px 8px;
  cursor:pointer; font-size:11px; }
.h3c-bar button:hover { border-color:var(--fg-color,#888); }
.h3c-bar select { background:var(--comfy-input-bg,#222); color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#444); border-radius:3px; padding:2px 4px; font-size:11px; }
.h3c-set { display:flex; align-items:center; gap:10px; flex-wrap:wrap; opacity:.9; }
.h3c-set label { display:flex; align-items:center; gap:4px; }
.h3c-set span { opacity:.6; }
.h3c-set input, .h3c-set select { background:var(--comfy-input-bg,#222); color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#444); border-radius:3px; padding:2px 4px;
  font:11px var(--font-family,system-ui,sans-serif); }
.h3c-set input { width:62px; }
.h3c-read { margin-left:auto; font-variant-numeric:tabular-nums; opacity:.75; }
.h3c-read b { color:#7ad9a5; font-weight:600; }
.h3c-stage { flex:0 1 auto; max-height:240px; position:relative; background:#000;
  border:1px solid var(--border-color,#444); border-radius:3px; aspect-ratio:16/9;
  display:flex; align-items:center; justify-content:center; overflow:hidden; }
.h3c-stage img { width:100%; height:100%; object-fit:contain; }
.h3c-empty { opacity:.4; text-align:center; padding:0 16px; }
.h3c-curve { width:100%; height:${CURVE_H}px; display:block; cursor:crosshair;
  border:1px solid var(--border-color,#444); border-radius:3px; background:#141414; }
.h3c-hint { opacity:.45; }
`;

class CurveWidget {
  constructor(node, store, widgets) {
    this.node = node;
    this.store = store;
    this.widgets = widgets;
    const isScheduler = node.comfyClass === "H3CurveScheduler";
    this.label = isScheduler ? "denoise" : "strength";
    this.fields = isScheduler
      ? { scheduler: "scheduler", steps: "steps", denoise: "denoise", noise_seed: "seed",
          control_after_generate: "after run", fps: "fps", interpolation: "curve" }
      : { fps: "fps", interpolation: "curve", default_value: "default" };
    this.frame = 0;
    this.fps = widgets.fps?.value ?? 24;
    this.totalFrames = 121;
    this.strip = null;
    this.dragging = null;
    this.data = this.load();
    this.build();
    this.render();
  }

  load() {
    try {
      const d = JSON.parse(this.store.value || "{}");
      return { points: [], ...d };
    } catch {
      return { points: [] };
    }
  }

  save() {
    this.data.fps = this.fps;
    this.data.total_frames = this.totalFrames;
    this.store.value = JSON.stringify(this.data);
    this.node.graph?.setDirtyCanvas(true, true);
  }

  /** The curve stores 0-1 multipliers; the axis shows what they mean.
   *  On the scheduler that is real denoise, so it tops out at the denoise
   *  widget rather than at 1. */
  get scale() {
    return this.widgets.denoise ? (this.widgets.denoise.value ?? 1) : 1;
  }

  fmt(v) {
    return parseFloat((v * this.scale).toFixed(3)).toString();
  }

  get interp() {
    return this.widgets.interpolation?.value ?? "linear";
  }

  /* ------------------------------------------------------------ curve */

  valueAt(frame) {
    const pts = [...this.data.points].sort((a, b) => a.frame - b.frame);
    const dflt = this.widgets.default_value?.value ?? 1;
    if (!pts.length) return dflt;
    if (frame <= pts[0].frame) return pts[0].value;
    if (frame >= pts[pts.length - 1].frame) return pts[pts.length - 1].value;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        if (this.interp === "hold") return a.value;
        let t = (frame - a.frame) / Math.max(1, b.frame - a.frame);
        if (this.interp === "smooth") t = t * t * (3 - 2 * t);
        return a.value + (b.value - a.value) * t;
      }
    }
    return dflt;
  }

  /* -------------------------------------------------------------- dom */

  build() {
    const root = document.createElement("div");
    root.className = "h3c";
    if (!document.getElementById("h3c-styles")) {
      const style = document.createElement("style");
      style.id = "h3c-styles";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const bar = document.createElement("div");
    bar.className = "h3c-bar";

    bar.append(
      this.button("Add point", () => this.addPoint(this.frame, this.valueAt(this.frame))),
      this.button("Clear", () => {
        this.data.points = [];
        this.save();
        this.render();
      })
    );

    this.readout = document.createElement("div");
    this.readout.className = "h3c-read";
    bar.appendChild(this.readout);

    const stage = document.createElement("div");
    stage.className = "h3c-stage";
    this.img = document.createElement("img");
    this.img.style.display = "none";
    this.placeholder = document.createElement("div");
    this.placeholder.className = "h3c-empty";
    this.placeholder.textContent = "Connect frames to the images input and queue once.";
    stage.append(this.img, this.placeholder);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "h3c-curve";
    this.canvas.onpointerdown = (e) => this.onPointerDown(e);

    const hint = document.createElement("div");
    hint.className = "h3c-hint";
    hint.textContent = "Click empty space to add a point, drag to move, shift-click to delete. Drag the top strip to scrub.";

    root.append(bar, this.buildSettings(), stage, this.canvas, hint);
    this.el = root;
  }

  /* The native widgets sit under the DOM panel's box and stop receiving
   * clicks, so they are hidden and mirrored here as real HTML controls. */
  buildSettings() {
    const row = document.createElement("div");
    row.className = "h3c-set";

    const STEPS = { denoise: "0.01", default_value: "0.01", fps: "0.001", steps: "1", noise_seed: "1" };
    const TIPS = {
      interpolation:
        "hold — step blocks between points\n" +
        "linear / smooth — ramps between them",
      denoise: "Global denoise. The curve scales this per frame.",
      control_after_generate:
        "What ComfyUI does to the seed after each run.\n" +
        "Keep it on fixed while comparing curves -- a changing seed changes the result on its own.",
      default_value: "Curve value where no points are set.",
    };

    for (const [name, label] of Object.entries(this.fields)) {
      const w = this.widgets[name];
      if (!w) continue;

      const wrap = document.createElement("label");
      if (TIPS[name]) wrap.title = TIPS[name];
      const text = document.createElement("span");
      text.textContent = label;

      let input;
      if (Array.isArray(w.options?.values)) {
        input = document.createElement("select");
        for (const v of w.options.values) {
          const o = document.createElement("option");
          o.value = o.textContent = v;
          input.appendChild(o);
        }
        input.value = w.value;
        input.onchange = () => {
          w.value = input.value;
          this.render();
        };
      } else {
        input = document.createElement("input");
        input.type = "number";
        input.step = STEPS[name] ?? "1";
        input.value = w.value;
        input.oninput = () => {
          const v = parseFloat(input.value);
          if (!Number.isNaN(v)) {
            w.value = name === "steps" || name === "noise_seed" ? Math.round(v) : v;
            this.render();
          }
        };
      }

      wrap.append(text, input);
      row.appendChild(wrap);
    }
    return row;
  }

  button(label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  loadFrames(frames, total) {
    if (!frames?.length) return;
    this.strip = frames.map((f) => ({
      frame: f.frame ?? 0,
      url: api.apiURL(
        `/view?filename=${encodeURIComponent(f.filename)}` +
        `&subfolder=${encodeURIComponent(f.subfolder ?? "")}&type=${f.type ?? "temp"}`
      ),
    }));
    if (total) this.totalFrames = total;
    this.img.style.display = "";
    this.placeholder.style.display = "none";
    this.seek(this.frame);
    this.render();
  }

  seek(frame) {
    this.frame = Math.max(0, Math.min(frame, this.totalFrames - 1));
    if (this.strip?.length) {
      let best = this.strip[0];
      for (const s of this.strip) {
        if (Math.abs(s.frame - this.frame) < Math.abs(best.frame - this.frame)) best = s;
      }
      if (this.img.src !== best.url) this.img.src = best.url;
    }
    this.draw();
    this.updateReadout();
  }

  /* ------------------------------------------------------ interaction */

  geom() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const pad = { l: 30, r: 8, t: 16, b: 14 };
    return {
      w, h, pad,
      x: (f) => pad.l + (f / Math.max(1, this.totalFrames - 1)) * (w - pad.l - pad.r),
      y: (v) => pad.t + (1 - v) * (h - pad.t - pad.b),
      toFrame: (px) => Math.round(((px - pad.l) / Math.max(1, w - pad.l - pad.r)) * (this.totalFrames - 1)),
      toValue: (py) => clamp01(1 - (py - pad.t) / Math.max(1, h - pad.t - pad.b)),
    };
  }

  /** Screen pixels -> canvas CSS pixels. The graph canvas can be zoomed, so
   *  the element's rect and its clientWidth are not the same scale. */
  local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      px: ((e.clientX - rect.left) / Math.max(1, rect.width)) * this.canvas.clientWidth,
      py: ((e.clientY - rect.top) / Math.max(1, rect.height)) * this.canvas.clientHeight,
    };
  }

  onPointerDown(e) {
    const { px, py } = this.local(e);
    const g = this.geom();

    // Top strip scrubs instead of editing, so scrubbing never drops a point.
    if (py < g.pad.t) {
      const scrub = (ev) => this.seek(g.toFrame(this.local(ev).px));
      scrub(e);
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.onpointermove = scrub;
      this.canvas.onpointerup = () => (this.canvas.onpointermove = null);
      return;
    }

    const hit = this.data.points.find(
      (p) => Math.hypot(g.x(p.frame) - px, g.y(p.value) - py) < 9
    );

    if (e.shiftKey) {
      if (hit) {
        this.data.points = this.data.points.filter((p) => p !== hit);
        this.save();
        this.render();
      }
      return;
    }

    const point = hit ?? this.addPoint(g.toFrame(px), g.toValue(py));
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.onpointermove = (ev) => {
      const m = this.local(ev);
      point.frame = Math.max(0, Math.min(this.totalFrames - 1, g.toFrame(m.px)));
      point.value = g.toValue(m.py);
      this.seek(point.frame);
      this.save();
    };
    this.canvas.onpointerup = () => {
      this.canvas.onpointermove = null;
      this.render();
    };
  }

  addPoint(frame, value) {
    const point = { frame: Math.max(0, Math.round(frame)), value: clamp01(value) };
    this.data.points.push(point);
    this.save();
    this.render();
    return point;
  }

  /* ------------------------------------------------------------- draw */

  draw() {
    const c = this.canvas;
    if (!c.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const g = this.geom();
    c.width = g.w * dpr;
    c.height = g.h * dpr;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);

    // value grid
    ctx.font = "9px system-ui";
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      ctx.strokeStyle = v === 0 || v === 1 ? "#3a3a3a" : "#242424";
      ctx.beginPath();
      ctx.moveTo(g.pad.l, g.y(v));
      ctx.lineTo(g.w - g.pad.r, g.y(v));
      ctx.stroke();
      ctx.fillStyle = "#666";
      ctx.fillText(this.fmt(v), 2, g.y(v) + 3);
    }

    // second ticks
    ctx.strokeStyle = "#242424";
    ctx.fillStyle = "#555";
    for (let s = 0; s * this.fps < this.totalFrames; s++) {
      const px = g.x(s * this.fps);
      ctx.beginPath();
      ctx.moveTo(px, g.pad.t);
      ctx.lineTo(px, g.h - g.pad.b);
      ctx.stroke();
      if (s % 2 === 0) ctx.fillText(`${s}s`, px + 2, g.h - 4);
    }

    // the curve itself, sampled per frame so hold really looks like steps
    ctx.strokeStyle = "#7ad9a5";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let f = 0; f < this.totalFrames; f++) {
      const px = g.x(f), py = g.y(this.valueAt(f));
      f === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.lineTo(g.x(this.totalFrames - 1), g.y(0));
    ctx.lineTo(g.x(0), g.y(0));
    ctx.closePath();
    ctx.fillStyle = "#7ad9a51f";
    ctx.fill();

    for (const p of this.data.points) {
      ctx.fillStyle = "#7ad9a5";
      ctx.beginPath();
      ctx.arc(g.x(p.frame), g.y(p.value), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // scrub strip and playhead
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, g.w, g.pad.t - 2);
    ctx.strokeStyle = "#ff4d4d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.x(this.frame), 0);
    ctx.lineTo(g.x(this.frame), g.h - g.pad.b);
    ctx.stroke();
  }

  updateReadout() {
    this.readout.innerHTML =
      `frame ${this.frame} / ${this.totalFrames} &nbsp; ${timecode(this.frame, this.fps)} ` +
      `&nbsp; ${this.label} <b>${this.fmt(this.valueAt(this.frame))}</b>`;
  }

  render() {
    this.fps = this.widgets.fps?.value ?? 24;
    this.draw();
    this.updateReadout();
    this.save();
  }
}

app.registerExtension({
  name: "h3.promptforge.curve",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!["H3TemporalMaskCurve", "H3CurveScheduler"].includes(nodeData.name)) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      if (this.h3Curve) return;

      const store = this.widgets.find((w) => w.name === "curve_data");
      if (!store) return;

      // Shrink rather than hide: hidden widgets get dropped from widgets_values
      // on newer frontends and the JSON never reaches Python.
      store.computeSize = () => [0, -4];
      store.draw = () => {};
      if (store.inputEl) store.inputEl.style.display = "none";
      store.serializeValue = () => store.value;

      const hide = (w) => {
        if (!w) return;
        w.hidden = true;                 // newer frontends
        w.type = "hidden";               // older ones
        w.computeSize = () => [0, -4];
        w.draw = () => {};
        w.onDrawBackground = () => {};
        if (w.inputEl) w.inputEl.style.display = "none";
        w.serializeValue = () => w.value;
      };

      const widgets = {};
      const owned = ["scheduler", "steps", "denoise", "noise_seed",
                     "fps", "interpolation", "default_value"];
      // default_value only exists on the mask node; harmless in the list.
      for (const w of [...this.widgets]) {
        if (w === store) continue;
        // ComfyUI appends its own control_after_generate next to a seed widget.
        const isControl = String(w.name).includes("control_after_generate");
        if (owned.includes(w.name) || isControl) {
          widgets[isControl ? "control_after_generate" : w.name] = w;
          // Randomize is ComfyUI's default and quietly ruins A/B comparisons.
          if (isControl && w.value === "randomize") w.value = "fixed";
          hide(w);
        }
      }

      const widget = new CurveWidget(this, store, widgets);

      // Height is stored, never derived from node.size inside computeSize --
      // ComfyUI sets node.size *from* computeSize, so reading it there makes
      // the node grow a little on every frame forever.
      let panelH = MIN_PANEL;
      const dom = this.addDOMWidget("h3_curve", "div", widget.el, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => panelH,
        getHeight: () => panelH,
      });
      dom.computeSize = (width) => [width, panelH];

      this.h3Curve = widget;
      this.size = [Math.max(this.size[0], 440), MIN_PANEL + CHROME_HEIGHT + 60];

      const ro = new ResizeObserver(() => widget.draw());
      ro.observe(widget.el);
      widget.resizeObserver = ro;

      const onResize = this.onResize;
      this.onResize = function (size) {
        onResize?.apply(this, arguments);
        if (size[1] < MIN_PANEL + CHROME_HEIGHT) size[1] = MIN_PANEL + CHROME_HEIGHT;
        panelH = Math.max(MIN_PANEL, size[1] - CHROME_HEIGHT);
        widget.draw();
      };

      requestAnimationFrame(() => widget.render());
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      if (message?.h3_frames?.length) {
        this.h3Curve?.loadFrames(message.h3_frames, message.h3_total?.[0]);
      }
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.h3Curve?.resizeObserver?.disconnect();
      onRemoved?.apply(this, arguments);
    };
  },
});
