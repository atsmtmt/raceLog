// TrackAddict / RaceRender 形式の CSV ログを解析する
(function (global) {
  'use strict';

  const COL = {
    time: 'Time',
    lap: 'Lap',
    lat: 'Latitude',
    lon: 'Longitude',
    speed: 'Speed (Km/h)',
    ax: 'Accel X',
    ay: 'Accel Y',
  };
  // 任意列（無ければ使わない）
  const OPT_COL = {
    gpsUpdate: 'GPS_Update',
    obdUpdate: 'OBD_Update',
    obdSpeed: 'Vehicle Speed (km/h) *OBD',
  };

  function splitCsvLine(line) {
    // 引用符付きフィールドにも対応した簡易 CSV 分割
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQ = true;
      } else if (c === ',') {
        out.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out;
  }

  /**
   * CSV テキストを解析し、ラップごとのデータを返す。
   * @returns {{meta: string[], laps: Lap[], bestLap: number|null}}
   */
  function parseLog(text) {
    const lines = text.split(/\r?\n/);
    const meta = [];
    const officialTimes = {};
    let header = null;
    const idx = {};
    const raw = { time: [], lap: [], lat: [], lon: [], speed: [], ax: [], ay: [], gpsUpdate: [], obdUpdate: [], obdSpeed: [] };

    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('#')) {
        // "# Lap 4: 00:01:15.937" は計測器が記録した正式ラップタイム
        const m = /^#\s*Lap\s+(\d+):\s*(\d+):(\d+):([\d.]+)/.exec(line);
        if (m) {
          officialTimes[m[1]] = (+m[2]) * 3600 + (+m[3]) * 60 + parseFloat(m[4]);
        } else if (!header) {
          meta.push(line.replace(/^#\s*/, ''));
        }
        continue;
      }
      if (!header) {
        header = splitCsvLine(line).map((s) => s.trim());
        for (const [key, name] of Object.entries({ ...COL, ...OPT_COL })) {
          idx[key] = header.indexOf(name);
        }
        const missing = Object.entries(COL).filter(([k]) => idx[k] < 0).map(([, n]) => n);
        if (missing.length) {
          throw new Error('必要な列が見つかりません: ' + missing.join(', '));
        }
        continue;
      }
      const f = splitCsvLine(line);
      const t = parseFloat(f[idx.time]);
      if (!Number.isFinite(t)) continue;
      for (const key of Object.keys(raw)) {
        raw[key].push(idx[key] >= 0 ? parseFloat(f[idx[key]]) : NaN);
      }
    }
    if (!header) throw new Error('ヘッダ行が見つかりません');
    if (!raw.time.length) throw new Error('データ行がありません');

    // GPS (約1Hz) / OBD (約7Hz) は更新行の間で値が保持されているだけなので、
    // 更新行をキーフレームとして線形補間し滑らかな時系列にする
    const gpsKeys = keyframes(raw.gpsUpdate, [raw.speed, raw.lat, raw.lon]);
    raw.speed = interpolate(raw.time, raw.speed, gpsKeys);
    raw.lat = interpolate(raw.time, raw.lat, gpsKeys);
    raw.lon = interpolate(raw.time, raw.lon, gpsKeys);
    const hasObd = idx.obdSpeed >= 0 && raw.obdSpeed.some((v) => Number.isFinite(v) && v > 0);
    if (hasObd) {
      raw.obdSpeed = interpolate(raw.time, raw.obdSpeed, keyframes(raw.obdUpdate, [raw.obdSpeed]));
    }

    // ラップごとに分割（Lap 値の連続区間）
    const laps = [];
    let start = 0;
    for (let i = 1; i <= raw.time.length; i++) {
      if (i === raw.time.length || raw.lap[i] !== raw.lap[start]) {
        laps.push(buildLap(raw, start, i));
        start = i;
      }
    }

    // ラップタイム: 次ラップの開始時刻 - 自ラップの開始時刻
    for (let i = 0; i < laps.length; i++) {
      const lap = laps[i];
      const end = i + 1 < laps.length ? laps[i + 1].t0 : lap.t0 + lap.t[lap.t.length - 1];
      lap.lapTime = officialTimes[lap.number] !== undefined ? officialTimes[lap.number] : end - lap.t0;
      // 先頭(アウトラップ)と最後(インラップ)は不完全ラップ扱い
      lap.complete = laps.length > 2 && i > 0 && i < laps.length - 1;
    }

    let bestLap = null;
    for (const lap of laps) {
      if (lap.complete && (bestLap === null || lap.lapTime < bestLap.lapTime)) bestLap = lap;
    }
    if (bestLap) bestLap.best = true;

    return { meta, laps, bestLap: bestLap ? bestLap.number : null, hasObd };
  }

  /**
   * 更新フラグ列（1 = 新しい値）からキーフレーム行のインデックスを得る。
   * フラグ列が無い場合は値が変化した行をキーフレームとみなす。
   */
  function keyframes(flags, valueCols) {
    const n = valueCols[0].length;
    const keys = [0];
    const hasFlags = flags.some((v) => v === 1);
    for (let i = 1; i < n; i++) {
      const isKey = hasFlags
        ? flags[i] === 1
        : valueCols.some((col) => col[i] !== col[i - 1]);
      if (isKey) keys.push(i);
    }
    return keys;
  }

  function interpolate(time, values, keys) {
    const n = values.length;
    const out = new Array(n);
    if (keys.length < 2) return values.slice();
    for (let i = 0; i <= keys[0]; i++) out[i] = values[keys[0]];
    for (let k = 0; k < keys.length - 1; k++) {
      const a = keys[k];
      const b = keys[k + 1];
      const ta = time[a];
      const tb = time[b];
      for (let i = a; i < b; i++) {
        const r = tb > ta ? (time[i] - ta) / (tb - ta) : 0;
        out[i] = values[a] + (values[b] - values[a]) * r;
      }
    }
    for (let i = keys[keys.length - 1]; i < n; i++) out[i] = values[keys[keys.length - 1]];
    return out;
  }

  function buildLap(raw, s, e) {
    const n = e - s;
    const t = new Float64Array(n);
    const dist = new Float64Array(n);
    const t0 = raw.time[s];
    const pick = (key) => Float64Array.from(raw[key].slice(s, e));
    const speed = pick('speed');
    for (let i = 0; i < n; i++) {
      t[i] = raw.time[s + i] - t0;
      if (i > 0) {
        // 速度を台形積分して走行距離 [km] を算出
        const dt = t[i] - t[i - 1];
        dist[i] = dist[i - 1] + ((speed[i] + speed[i - 1]) / 2 / 3600) * dt;
      }
    }
    return {
      number: raw.lap[s],
      t0,
      t,
      dist,
      speed,
      speedObd: pick('obdSpeed'),
      lat: pick('lat'),
      lon: pick('lon'),
      ax: pick('ax'),
      ay: pick('ay'),
      lapTime: 0,
      complete: false,
      best: false,
    };
  }

  function formatLapTime(sec) {
    if (!Number.isFinite(sec)) return '-';
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m + ':' + s.toFixed(3).padStart(6, '0');
  }

  /** 昇順配列 arr で x に最も近いインデックスを返す */
  function nearestIndex(arr, x) {
    let lo = 0;
    let hi = arr.length - 1;
    if (x <= arr[lo]) return lo;
    if (x >= arr[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid; else hi = mid;
    }
    return x - arr[lo] < arr[hi] - x ? lo : hi;
  }

  const api = { parseLog, formatLapTime, nearestIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.RaceLogParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
