// Canvas による 3 つのグラフ（速度 / G-G / コース図）
(function (global) {
  'use strict';

  const { nearestIndex } = global.RaceLogParser;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function theme() {
    return {
      surface: cssVar('--surface-1'),
      text: cssVar('--text-primary'),
      text2: cssVar('--text-secondary'),
      muted: cssVar('--text-muted'),
      grid: cssVar('--grid'),
      axis: cssVar('--axis'),
      cursor: cssVar('--cursor'),
      font: '12px system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif',
    };
  }

  /** キャンバスを親要素サイズ × devicePixelRatio に合わせる */
  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  /** 見やすい目盛り間隔 */
  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const s = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
    return s * mag;
  }

  function ticks(min, max, target) {
    const step = niceStep(max - min, target);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
      out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return { step, values: out };
  }

  function decimals(step) {
    return step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------------------------------------------------------------------------
  // 速度グラフ（横軸: 時間 or 距離）
  // ---------------------------------------------------------------------------
  class SpeedChart {
    constructor(canvas, handlers) {
      this.canvas = canvas;
      this.handlers = handlers; // { onCursor(x|null), onView([min,max]) }
      this.series = []; // [{ lap, color }]
      this.xMode = 'time';
      this.view = null; // [xmin, xmax]
      this.cursorX = null;
      this.pad = { l: 52, r: 16, t: 14, b: 34 };
      this.drag = null;
      this.bindEvents();
    }

    xs(lap) {
      return this.xMode === 'time' ? lap.t : lap.dist;
    }

    fullRange() {
      let max = 0;
      for (const s of this.series) {
        const x = this.xs(s.lap);
        max = Math.max(max, x[x.length - 1]);
      }
      return [0, max || 1];
    }

    setData(series, xMode) {
      const modeChanged = xMode !== this.xMode;
      this.series = series;
      this.xMode = xMode;
      if (modeChanged || !this.view) this.view = this.fullRange();
    }

    resetView() {
      this.view = this.fullRange();
      this.handlers.onView(this.view);
    }

    xToPx(x) {
      const [a, b] = this.view;
      return this.pad.l + ((x - a) / (b - a)) * this.plotW;
    }

    pxToX(px) {
      const [a, b] = this.view;
      return a + ((px - this.pad.l) / this.plotW) * (b - a);
    }

    bindEvents() {
      const c = this.canvas;
      const localX = (e) => e.clientX - c.getBoundingClientRect().left;

      c.addEventListener('wheel', (e) => {
        if (!this.ready()) return;
        e.preventDefault();
        const [a, b] = this.view;
        const [fa, fb] = this.fullRange();
        const x = this.pxToX(localX(e));
        const k = Math.exp(e.deltaY * 0.0015);
        const minSpan = (fb - fa) / 200;
        let na = x - (x - a) * k;
        let nb = x + (b - x) * k;
        if (nb - na < minSpan) return;
        if (nb - na >= fb - fa) { na = fa; nb = fb; }
        this.view = this.clampView(na, nb);
        this.handlers.onView(this.view);
      }, { passive: false });

      c.addEventListener('pointerdown', (e) => {
        if (!this.ready()) return;
        c.setPointerCapture(e.pointerId);
        this.drag = { px: localX(e), view: this.view.slice() };
      });
      c.addEventListener('pointermove', (e) => {
        if (!this.ready()) return;
        const px = localX(e);
        if (this.drag) {
          const [a, b] = this.drag.view;
          const dx = ((px - this.drag.px) / this.plotW) * (b - a);
          this.view = this.clampView(a - dx, b - dx);
          this.handlers.onView(this.view);
        }
        const inside = px >= this.pad.l && px <= this.pad.l + this.plotW;
        this.handlers.onCursor(inside ? this.pxToX(px) : null);
      });
      const end = () => { this.drag = null; };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => {
        if (!this.drag) this.handlers.onCursor(null);
      });
      c.addEventListener('dblclick', () => this.resetView());
    }

    /** 操作可能か（描画前に view が未確定ならここで確定させる） */
    ready() {
      if (!this.series.length || !this.plotW) return false;
      if (!this.view) this.view = this.fullRange();
      return true;
    }

    clampView(a, b) {
      const [fa, fb] = this.fullRange();
      const span = b - a;
      if (a < fa) { a = fa; b = fa + span; }
      if (b > fb) { b = fb; a = fb - span; }
      return [Math.max(fa, a), Math.min(fb, b)];
    }

    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const th = theme();
      const p = this.pad;
      this.plotW = w - p.l - p.r;
      this.plotH = h - p.t - p.b;
      ctx.fillStyle = th.surface;
      ctx.fillRect(0, 0, w, h);
      ctx.font = th.font;
      if (!this.series.length) {
        ctx.fillStyle = th.muted;
        ctx.textAlign = 'center';
        ctx.fillText('ラップを選択してください', w / 2, h / 2);
        return;
      }

      const [xa, xb] = this.view;
      let ymax = 0;
      for (const s of this.series) for (const v of s.speed) if (v > ymax) ymax = v;
      ymax = Math.ceil((ymax + 5) / 20) * 20;
      const yToPx = (v) => p.t + this.plotH - (v / ymax) * this.plotH;

      // グリッド・目盛り
      ctx.lineWidth = 1;
      const yt = ticks(0, ymax, Math.max(3, Math.floor(this.plotH / 40)));
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of yt.values) {
        const y = Math.round(yToPx(v)) + 0.5;
        ctx.strokeStyle = v === 0 ? th.axis : th.grid;
        ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(p.l + this.plotW, y); ctx.stroke();
        ctx.fillStyle = th.text2;
        ctx.fillText(String(v), p.l - 8, y);
      }
      const xt = ticks(xa, xb, Math.max(3, Math.floor(this.plotW / 90)));
      const dec = decimals(xt.step);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const v of xt.values) {
        const x = Math.round(this.xToPx(v)) + 0.5;
        ctx.strokeStyle = th.grid;
        ctx.beginPath(); ctx.moveTo(x, p.t); ctx.lineTo(x, p.t + this.plotH); ctx.stroke();
        ctx.fillStyle = th.text2;
        ctx.fillText(v.toFixed(dec), x, p.t + this.plotH + 6);
      }
      ctx.fillStyle = th.muted;
      ctx.textAlign = 'right';
      ctx.fillText(this.xMode === 'time' ? '時間 [s]' : '距離 [km]', p.l + this.plotW, p.t + this.plotH + 20);
      ctx.save();
      ctx.translate(12, p.t + this.plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('速度 [km/h]', 0, 0);
      ctx.restore();

      // 折れ線
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.l, p.t - 2, this.plotW, this.plotH + 4);
      ctx.clip();
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const s of this.series) {
        const xs = this.xs(s.lap);
        const i0 = Math.max(0, nearestIndex(xs, xa) - 1);
        const i1 = Math.min(xs.length - 1, nearestIndex(xs, xb) + 1);
        ctx.strokeStyle = s.color;
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const x = this.xToPx(xs[i]);
          const y = yToPx(s.speed[i]);
          if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();

      // カーソル + ツールチップ
      if (this.cursorX !== null && this.cursorX >= xa && this.cursorX <= xb) {
        const cx = Math.round(this.xToPx(this.cursorX)) + 0.5;
        ctx.strokeStyle = th.cursor;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, p.t); ctx.lineTo(cx, p.t + this.plotH); ctx.stroke();

        const rows = [];
        for (const s of this.series) {
          const xs = this.xs(s.lap);
          if (this.cursorX > xs[xs.length - 1]) continue;
          const i = nearestIndex(xs, this.cursorX);
          const y = yToPx(s.speed[i]);
          ctx.fillStyle = s.color;
          ctx.strokeStyle = th.surface;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          rows.push({ color: s.color, label: 'Lap ' + s.lap.number, value: s.speed[i].toFixed(1) + ' km/h' });
        }
        const head = this.xMode === 'time'
          ? this.cursorX.toFixed(2) + ' s'
          : (this.cursorX * 1000).toFixed(0) + ' m';
        drawTooltip(ctx, th, cx, p.t + 6, head, rows, p.l, p.l + this.plotW);
      }
    }
  }

  function drawTooltip(ctx, th, anchorX, top, head, rows, minX, maxX) {
    ctx.font = th.font;
    const lineH = 17;
    let wMax = ctx.measureText(head).width;
    for (const r of rows) wMax = Math.max(wMax, 16 + ctx.measureText(r.label + '  ' + r.value).width);
    const bw = wMax + 20;
    const bh = 10 + lineH * (rows.length + 1);
    let bx = anchorX + 12;
    if (bx + bw > maxX) bx = anchorX - 12 - bw;
    if (bx < minX) bx = minX;
    ctx.fillStyle = cssVar('--tooltip-bg');
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    roundRect(ctx, bx, top, bw, bh, 6);
    ctx.fill(); ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = th.text2;
    ctx.fillText(head, bx + 10, top + 5 + lineH / 2);
    rows.forEach((r, k) => {
      const y = top + 5 + lineH * (k + 1) + lineH / 2;
      ctx.fillStyle = r.color;
      ctx.beginPath(); ctx.arc(bx + 14, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = th.text2;
      ctx.fillText(r.label, bx + 24, y);
      ctx.fillStyle = th.text;
      ctx.textAlign = 'right';
      ctx.fillText(r.value, bx + bw - 10, y);
      ctx.textAlign = 'left';
    });
  }

  // ---------------------------------------------------------------------------
  // G-G 散布図（Accel X / Accel Y）
  // ---------------------------------------------------------------------------
  class GGChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.series = [];
      this.range = null; // 表示中の x 範囲（速度グラフのズームに連動）
      this.xMode = 'time';
      this.cursorX = null;
      this.opts = { swap: false, invX: false, invY: false };
    }

    setData(series, xMode, range, opts) {
      this.series = series;
      this.xMode = xMode;
      this.range = range;
      this.opts = opts;
    }

    point(lap, i) {
      let gx = lap.ax[i];
      let gy = lap.ay[i];
      if (this.opts.swap) [gx, gy] = [gy, gx];
      if (this.opts.invX) gx = -gx;
      if (this.opts.invY) gy = -gy;
      return [gx, gy];
    }

    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const th = theme();
      ctx.fillStyle = th.surface;
      ctx.fillRect(0, 0, w, h);
      ctx.font = th.font;

      let gmax = 1;
      for (const s of this.series) {
        for (let i = 0; i < s.lap.ax.length; i++) {
          gmax = Math.max(gmax, Math.abs(s.lap.ax[i]), Math.abs(s.lap.ay[i]));
        }
      }
      gmax = Math.ceil(gmax * 2) / 2;
      const pad = 28;
      const r = Math.max(10, Math.min(w, h) / 2 - pad);
      const cx = w / 2;
      const cy = h / 2;
      const toPx = (gx, gy) => [cx + (gx / gmax) * r, cy - (gy / gmax) * r];

      // 同心円 (0.5G 刻み) と十字軸
      ctx.lineWidth = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      for (let g = 0.5; g <= gmax + 1e-9; g += 0.5) {
        ctx.strokeStyle = Math.abs(g - 1) < 1e-9 ? th.axis : th.grid;
        ctx.beginPath(); ctx.arc(cx, cy, (g / gmax) * r, 0, Math.PI * 2); ctx.stroke();
        // 目盛りラベルは軸ラベルと重ならないよう右下 45° 方向に置く
        const rr = (g / gmax) * r * Math.SQRT1_2;
        ctx.fillStyle = th.muted;
        ctx.fillText(g.toFixed(1) + 'G', cx + rr + 3, cy + rr - 2);
      }
      ctx.strokeStyle = th.axis;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy + 0.5); ctx.lineTo(cx + r, cy + 0.5);
      ctx.moveTo(cx + 0.5, cy - r); ctx.lineTo(cx + 0.5, cy + r);
      ctx.stroke();
      const xl = (this.opts.invX ? '−' : '') + (this.opts.swap ? 'Accel Y' : 'Accel X');
      const yl = (this.opts.invY ? '−' : '') + (this.opts.swap ? 'Accel X' : 'Accel Y');
      ctx.fillStyle = th.text2;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(xl + ' [G]', w - 6, cy - 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(yl + ' [G]', cx + 6, 6);

      // 散布点（速度グラフの表示範囲内のサンプルのみ）
      ctx.globalAlpha = 0.45;
      for (const s of this.series) {
        const xs = this.xMode === 'time' ? s.lap.t : s.lap.dist;
        const [i0, i1] = rangeIndices(xs, this.range);
        ctx.fillStyle = s.color;
        for (let i = i0; i <= i1; i++) {
          const [px, py] = toPx(...this.point(s.lap, i));
          ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
        }
      }
      ctx.globalAlpha = 1;

      // カーソル位置のサンプル
      if (this.cursorX !== null) {
        for (const s of this.series) {
          const xs = this.xMode === 'time' ? s.lap.t : s.lap.dist;
          if (this.cursorX > xs[xs.length - 1]) continue;
          const i = nearestIndex(xs, this.cursorX);
          const [px, py] = toPx(...this.point(s.lap, i));
          ctx.fillStyle = s.color;
          ctx.strokeStyle = th.surface;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
  }

  function rangeIndices(xs, range) {
    if (!range) return [0, xs.length - 1];
    const i0 = nearestIndex(xs, range[0]);
    const i1 = nearestIndex(xs, range[1]);
    return [i0, i1];
  }

  // ---------------------------------------------------------------------------
  // コース図（緯度経度の走行ライン）
  // ---------------------------------------------------------------------------
  class TrackMap {
    constructor(canvas) {
      this.canvas = canvas;
      this.allLaps = [];
      this.series = [];
      this.range = null;
      this.xMode = 'time';
      this.cursorX = null;
    }

    setAllLaps(laps) {
      // 全ラップの範囲で投影を固定（ラップ選択で地図が動かないように）
      let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
      for (const lap of laps) {
        for (let i = 0; i < lap.lat.length; i++) {
          const la = lap.lat[i], lo = lap.lon[i];
          if (!la && !lo) continue;
          if (la < latMin) latMin = la;
          if (la > latMax) latMax = la;
          if (lo < lonMin) lonMin = lo;
          if (lo > lonMax) lonMax = lo;
        }
      }
      this.bounds = { latMin, latMax, lonMin, lonMax, k: Math.cos(((latMin + latMax) / 2) * Math.PI / 180) };
    }

    setData(series, xMode, range) {
      this.series = series;
      this.xMode = xMode;
      this.range = range;
    }

    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const th = theme();
      ctx.fillStyle = th.surface;
      ctx.fillRect(0, 0, w, h);
      if (!this.bounds || !Number.isFinite(this.bounds.latMin)) return;
      const b = this.bounds;
      const pad = 20;
      const gw = (b.lonMax - b.lonMin) * b.k;
      const gh = b.latMax - b.latMin;
      const s = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh);
      const ox = (w - gw * s) / 2;
      const oy = (h - gh * s) / 2;
      const toPx = (la, lo) => [ox + (lo - b.lonMin) * b.k * s, oy + (b.latMax - la) * s];

      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const zoomed = this.range !== null;
      for (const ser of this.series) {
        const lap = ser.lap;
        // ラップ全周（ズーム中は薄く）
        ctx.strokeStyle = ser.color;
        ctx.globalAlpha = zoomed ? 0.25 : 0.9;
        ctx.lineWidth = 2;
        strokePath(ctx, lap, 0, lap.lat.length - 1, toPx);
        if (zoomed) {
          const xs = this.xMode === 'time' ? lap.t : lap.dist;
          const [i0, i1] = rangeIndices(xs, this.range);
          ctx.globalAlpha = 1;
          ctx.lineWidth = 3;
          strokePath(ctx, lap, i0, i1, toPx);
        }
      }
      ctx.globalAlpha = 1;

      // 現在位置マーカー（十字 + 円）
      if (this.cursorX !== null) {
        for (const ser of this.series) {
          const lap = ser.lap;
          const xs = this.xMode === 'time' ? lap.t : lap.dist;
          if (this.cursorX > xs[xs.length - 1]) continue;
          const i = nearestIndex(xs, this.cursorX);
          const [px, py] = toPx(lap.lat[i], lap.lon[i]);
          ctx.strokeStyle = th.cursor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px - 14, py); ctx.lineTo(px + 14, py);
          ctx.moveTo(px, py - 14); ctx.lineTo(px, py + 14);
          ctx.stroke();
          ctx.fillStyle = ser.color;
          ctx.strokeStyle = th.surface;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
  }

  function strokePath(ctx, lap, i0, i1, toPx) {
    ctx.beginPath();
    let started = false;
    for (let i = i0; i <= i1; i++) {
      if (!lap.lat[i] && !lap.lon[i]) continue;
      const [x, y] = toPx(lap.lat[i], lap.lon[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  global.RaceLogCharts = { SpeedChart, GGChart, TrackMap };
})(window);
