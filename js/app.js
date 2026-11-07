// 画面全体の状態管理とイベント処理
(function () {
  'use strict';

  const { parseLog, formatLapTime } = window.RaceLogParser;
  const { SpeedChart, GGChart, TrackMap } = window.RaceLogCharts;

  const MAX_SELECTED = 8; // カテゴリカラーの数
  const SAMPLE_URL = 'samples/Log-20261004-103231_Sodegaura_-_Full_-_1.15.937.csv';

  const state = {
    data: null,
    fileName: '',
    selected: new Map(), // lap number -> color slot (1..8)
    xMode: 'time',
    speedSrc: 'gps', // 'gps' | 'obd'
    view: null,
    cursorX: null,
    gg: { swap: false, invX: false, invY: false },
  };

  const $ = (id) => document.getElementById(id);
  const speedChart = new SpeedChart($('speed-canvas'), {
    onCursor(x) { state.cursorX = x; requestDraw(); },
    onView(v) { state.view = v; requestDraw(); },
  });
  const ggChart = new GGChart($('gg-canvas'));
  const trackMap = new TrackMap($('track-canvas'));

  function slotColor(slot) {
    return getComputedStyle(document.documentElement).getPropertyValue('--series-' + slot).trim();
  }

  function selectedSeries() {
    if (!state.data) return [];
    return state.data.laps
      .filter((lap) => state.selected.has(lap.number))
      .map((lap) => ({
        lap,
        color: slotColor(state.selected.get(lap.number)),
        speed: state.speedSrc === 'obd' ? lap.speedObd : lap.speed,
      }));
  }

  // --- 描画 -------------------------------------------------------------------
  let rafId = 0;
  function requestDraw() {
    if (!rafId) rafId = requestAnimationFrame(drawAll);
  }

  function drawAll() {
    rafId = 0;
    if (!state.data) return;
    const series = selectedSeries();
    speedChart.setData(series, state.xMode);
    if (!state.view) state.view = speedChart.view;
    speedChart.view = state.view;
    speedChart.cursorX = state.cursorX;

    const full = speedChart.fullRange();
    const zoomed = state.view && (state.view[0] > full[0] + 1e-9 || state.view[1] < full[1] - 1e-9);
    const range = zoomed ? state.view : null;

    ggChart.setData(series, state.xMode, range, state.gg);
    ggChart.cursorX = state.cursorX;
    trackMap.setData(series, state.xMode, range);
    trackMap.cursorX = state.cursorX;

    speedChart.draw();
    ggChart.draw();
    trackMap.draw();
    updateLegend(series);
  }

  function updateLegend(series) {
    const el = $('legend');
    el.innerHTML = '';
    for (const s of series) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      item.innerHTML = '<i style="background:' + s.color + '"></i>Lap ' + s.lap.number +
        ' <b>' + formatLapTime(s.lap.lapTime) + '</b>';
      el.appendChild(item);
    }
  }

  // --- ラップ一覧 ---------------------------------------------------------------
  function renderLapList() {
    const tbody = $('lap-rows');
    tbody.innerHTML = '';
    const best = state.data.laps.find((l) => l.best);
    for (const lap of state.data.laps) {
      const tr = document.createElement('tr');
      if (!lap.complete) tr.className = 'incomplete';
      const checked = state.selected.has(lap.number);
      const full = !checked && state.selected.size >= MAX_SELECTED;
      const color = checked ? slotColor(state.selected.get(lap.number)) : 'transparent';
      const delta = best && lap.complete && !lap.best
        ? '+' + (lap.lapTime - best.lapTime).toFixed(3)
        : '';
      const note = lap.best ? '<span class="badge">BEST</span>'
        : !lap.complete ? '<span class="note">' + (lap.number === state.data.laps[0].number ? 'OUT' : 'IN') + '</span>' : '';
      tr.innerHTML =
        '<td><label class="chk"><input type="checkbox" data-lap="' + lap.number + '"' +
        (checked ? ' checked' : '') + (full ? ' disabled' : '') + '>' +
        '<i class="swatch" style="background:' + color + '"></i>Lap ' + lap.number + '</label></td>' +
        '<td class="num">' + formatLapTime(lap.lapTime) + '</td>' +
        '<td class="num delta">' + delta + '</td>' +
        '<td>' + note + '</td>';
      tbody.appendChild(tr);
    }
  }

  function toggleLap(num, on) {
    if (on) {
      if (state.selected.size >= MAX_SELECTED) return;
      const used = new Set(state.selected.values());
      let slot = 1;
      while (used.has(slot)) slot++;
      state.selected.set(num, slot); // 色はラップに紐づき、他ラップの選択で変わらない
    } else {
      state.selected.delete(num);
    }
    state.view = null;
    speedChart.view = null;
    renderLapList();
    requestDraw();
  }

  $('lap-rows').addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[type=checkbox]')) toggleLap(Number(t.dataset.lap), t.checked);
  });

  // --- 操作パネル ---------------------------------------------------------------
  document.querySelectorAll('input[name=xmode]').forEach((r) => {
    r.addEventListener('change', () => {
      state.xMode = r.value;
      state.view = null;
      state.cursorX = null;
      speedChart.view = null;
      requestDraw();
    });
  });
  document.querySelectorAll('input[name=speedsrc]').forEach((r) => {
    r.addEventListener('change', () => {
      state.speedSrc = r.value;
      requestDraw();
    });
  });
  for (const key of ['swap', 'invX', 'invY']) {
    $('gg-' + key).addEventListener('change', (e) => {
      state.gg = { ...state.gg, [key]: e.target.checked };
      requestDraw();
    });
  }
  $('reset-zoom').addEventListener('click', () => {
    state.view = null;
    speedChart.view = null;
    requestDraw();
  });

  // --- ファイル読み込み -----------------------------------------------------------
  function loadText(text, name) {
    let data;
    try {
      data = parseLog(text);
    } catch (err) {
      showError('CSV を読み込めませんでした: ' + err.message);
      return;
    }
    state.data = data;
    state.fileName = name;
    state.selected = new Map();
    state.view = null;
    state.cursorX = null;
    speedChart.view = null;

    // 既定選択: ベストラップ + その前後の完走ラップ
    const complete = data.laps.filter((l) => l.complete);
    const bestIdx = complete.findIndex((l) => l.best);
    const initial = bestIdx >= 0
      ? [complete[bestIdx], complete[bestIdx - 1], complete[bestIdx + 1]].filter(Boolean)
      : data.laps.slice(0, 3);
    initial.forEach((lap, k) => state.selected.set(lap.number, k + 1));

    // OBD 車速は更新頻度が高い(約7Hz)ため、あれば既定にする
    state.speedSrc = data.hasObd ? 'obd' : 'gps';
    document.querySelectorAll('input[name=speedsrc]').forEach((r) => {
      r.checked = r.value === state.speedSrc;
      r.disabled = r.value === 'obd' && !data.hasObd;
    });
    trackMap.setAllLaps(data.laps);
    $('file-name').textContent = name;
    const vehicle = data.meta.find((m) => m.startsWith('Vehicle:'));
    $('file-meta').textContent = [vehicle, data.laps.length + ' laps'].filter(Boolean).join(' · ');
    document.body.classList.add('loaded');
    hideError();
    renderLapList();
    requestDraw();
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result), file.name);
    reader.onerror = () => showError('ファイルを読み込めませんでした');
    reader.readAsText(file);
  }

  function showError(msg) {
    const el = $('error');
    el.textContent = msg;
    el.hidden = false;
  }
  function hideError() { $('error').hidden = true; }

  document.querySelectorAll('.file-input').forEach((input) => {
    input.addEventListener('change', (e) => {
      if (e.target.files[0]) loadFile(e.target.files[0]);
      e.target.value = '';
    });
  });
  $('load-sample').addEventListener('click', async () => {
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(res.status);
      loadText(await res.text(), SAMPLE_URL.split('/').pop());
    } catch (err) {
      showError('サンプルを取得できませんでした（file:// で開いている場合はファイル選択から読み込んでください）');
    }
  });

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    document.body.classList.remove('dragging');
  }));
  document.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  window.addEventListener('resize', requestDraw);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.data) renderLapList();
    requestDraw();
  });

  // テスト・デバッグ用
  window.raceLog = { state, loadText };
})();
