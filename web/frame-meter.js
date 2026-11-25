// Experimental KOF XI frame meter (Street Fighter 6 style) for the PS2 web recomp.
//
// Off unless the page URL has ?framemeter (any value but 0). It reads the per-frame capture ring the
// runtime fills (runtime/include/ps2/framemeter.hpp), turns it into per-player timelines and draws them
// in a strip above the game (the game shrinks to make room). Addresses and struct offsets are those of the Japanese release (SLPS-25660).
//
// Colours follow SF6: green = startup, crimson = active (an attack or throw box is live), blue = recovery,
// yellow = the defender's hit reaction (hitstun / knockdown / getup), pale yellow = guard stun (block).
// Header per player: Startup / Total / Advantage, using the rule read off SF6's own screenshots: startup =
// cells up to and including the first active frame, total = all cells of the attacker's bar.
//
// "Actionable" is taken from the game's own signals, not from a threshold over the action id (the earlier
// guess). Found on the PS2 practice dummy by the frame-advantage work of ATG-02 (scripts/ps2-research/frameadv,
// scripts/combo-damage-ps2/frameadv_ps2.py, docs/ps2-hacking-notes.md section 10):
//
//   busy = attack (+0x490 & 3) | hit stop (+0x494 bit 27) | hit/throw/knockdown/getup reaction (+0x494 bit 0)
//        | guard stun (+0x530 0x400) | airborne (pose byte +0x27E == 2)
//        | uninterruptible movement (+0x48C mask: jump start 0x20, jump 0x80/0x100/0x400, backdash 0x400000,
//          rolls 0x01000000/0x02000000/0x10000000, shift 0x2000/0x4000)
//
// Advantage follows the same rule as the in-game display: after a contact, each side's FREE frame is the first
// frame in which it is not busy (the game's "guard only / buffer" frame, which is the same offset on both
// sides), and advantage = FREE(P2) - FREE(P1), so it matches the wiki convention. A contact is the rising edge
// of reaction or hit stop on either side; contacts within 3 frames of a window start belong to the same window.
//
// The engine model is the default. ?fm_model=legacy (or ?fm_neutral=N) forces the old guess
// (actionable when action id <= N, default 26) instead of the engine signals, for comparison. ?fm_act overrides
// the action-id offset. ?fm_learn=1 lists the struct bytes that change rarely, to keep finding fields.
(function (root) {
  'use strict';

  const REC = { frame: 0x00, scene: 0x04, mode: 0x06, valid: 0x07, point: 0x08, player: 0x10, extra: 0xC10, combo: 0xC50, pad: 0xC52 };
  const PLAYER_BYTES = 0x600, EXTRA_BYTES = 0x20;
  const HB_OFFSET = 0x39E, HB_ATTACK_MASK = 0x11; // bit 0 attack box, bit 4 throw box (viewer's hitbox slots)
  const ACT_OFFSET = 0xEC;                        // action id (same offset as the arcade map)
  const F_ATTACK = 0x490, ATTACK_MASK = 0x03;     // attack action active
  const F_STATE = 0x494, ST_HITSTOP = 0x08000000, ST_REACT = 0x01;
  const F_GUARD = 0x530, GUARD_STUN = 0x400;      // guard stun (block), pose byte at +0x27E
  const POSE_OFFSET = 0x27E;
  const F_MOVE = 0x48C;
  const BUSY_48C = 0x20 | 0x80 | 0x100 | 0x400 | 0x400000 | 0x01000000 | 0x02000000 | 0x10000000 | 0x2000 | 0x4000;
  const SAME_CONTACT = 3, TIMEOUT = 600;
  const SCENE_COMBAT = 0x03;                      // low byte of the scene word 0x303
  const WINDOW = 80;                              // cells per bar (SF6 shows about 80)

  // One side's reading for a frame, from the captured 0x600-byte player structure.
  function readSide(p) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const f490 = dv.getUint32(F_ATTACK, true), f494 = dv.getUint32(F_STATE, true);
    const f530 = dv.getUint32(F_GUARD, true), f48c = dv.getUint32(F_MOVE, true);
    const attack = (f490 & ATTACK_MASK) !== 0;
    const hitStop = ((f494 >>> 27) & 1) !== 0;
    const react = (f494 & ST_REACT) !== 0;
    const guardStun = (f530 & GUARD_STUN) !== 0;
    const air = (p[POSE_OFFSET] & 0xF) === 2;
    return { f490, f494, f530, f48c, pose: p[POSE_OFFSET] & 0xF, attack, hitStop, react, guardStun, air };
  }

  class Meter {
    constructor(opts) {
      opts = opts || {};
      this.actOffset = opts.actOffset == null ? ACT_OFFSET : opts.actOffset;
      this.neutralMax = opts.neutralMax == null ? 26 : opts.neutralMax;
      this.legacy = !!opts.legacy;        // force the action-id threshold instead of the engine signals
      this.reset();
    }

    reset() {
      this.side = [this.newSide(), this.newSide()];
      this.cells = [[], []];        // per cell: null | { s: 'G'|'R'|'B'|'Y'|'K' }
      this.live = false;            // an interaction is being recorded
      this.frozen = true;           // finished interaction stays on screen until the next one starts
      this.frames = 0;
      this.info = [this.newInfo(), this.newInfo()];
      this.raw = [{}, {}];
      this.win = null;              // advantage window: { start, free: [null, null], kind }
      this.winResult = null;        // { adv, kind } of the last completed window
      this.prev = { react: [false, false], guard: [false, false], hs: [false, false] };
    }

    newSide() { return { char: -1, hp: -1, guard: -1, hadActive: false }; }

    newInfo() { return { startup: null, total: null, adv: null, kind: null }; }

    // rec: { frame, scene, mode, valid, sides: [ { point, p: Uint8Array, ex: Uint8Array, combo } , ... ] }
    push(rec) {
      this.frames++;
      this.rec = rec;
      const inCombat = (rec.scene & 0xFF) === SCENE_COMBAT;
      const frame = rec.frame >>> 0;
      const state = [null, null];
      const busy = [false, false], react = [false, false], guard = [false, false], hs = [false, false], edge = [false, false];
      const pHs = [this.prev.hs[0], this.prev.hs[1]];

      for (let s = 0; s < 2; s++) {
        const S = this.side[s], sd = rec.sides[s];
        if (!inCombat || !(rec.valid & (1 << s)) || !sd) { this.side[s] = this.newSide(); this.prev.react[s] = this.prev.guard[s] = this.prev.hs[s] = false; continue; }
        const ex = sd.ex, p = sd.p;
        const char = ex[0], hp = ex[4] | (ex[5] << 8), gd = ex[0xA] | (ex[0xB] << 8);
        if (S.char !== char) Object.assign(S, this.newSide(), { char });
        const r = readSide(p);
        const engine = !this.legacy;
        const b = engine
          ? (r.attack || r.hitStop || r.react || r.guardStun || r.air || (r.f48c & BUSY_48C) !== 0)
          : p[this.actOffset] > this.neutralMax;   // legacy: the old action-id guess
        busy[s] = b; react[s] = r.react; guard[s] = r.guardStun; hs[s] = r.hitStop;
        edge[s] = engine
          ? ((r.react && !this.prev.react[s]) || (r.guardStun && !this.prev.guard[s]))
          : (S.hp >= 0 && hp < S.hp);              // legacy: a drop in HP is a hit
        this.prev.react[s] = r.react; this.prev.guard[s] = r.guardStun;
        this.prev.hs[s] = r.hitStop;
        const active = r.attack && (p[HB_OFFSET] & HB_ATTACK_MASK) !== 0;
        let st = null;
        if (r.guardStun) st = 'K';
        else if (r.react) st = 'Y';
        else if (r.attack) st = active ? 'R' : (S.hadActive ? 'B' : 'G');
        else if (b) st = 'B';                       // airborne, jump, dash, roll, shift, landing recovery
        if (active) S.hadActive = true;
        if (!b) S.hadActive = false;
        S.hp = hp; S.guard = gd;
        state[s] = st;
        this.raw[s] = {
          act: p[this.actOffset], prev: p[this.actOffset + 2], hb: p[HB_OFFSET], f490: r.f490, f494: r.f494,
          f530: r.f530, f48c: r.f48c, pose: r.pose, busy: b ? 1 : 0, react: r.react ? 1 : 0, hs: r.hitStop ? 1 : 0,
          hp, guard: gd, char, point: sd.point,
        };
      }
      this.state = state;

      const contact = (edge[0] || edge[1] || (hs[0] && !pHs[0]) || (hs[1] && !pHs[1]));
      if (contact && !(this.win && frame - this.win.start <= SAME_CONTACT)) {
        const kind = edge[0] && edge[1] ? 'trade' : (guard[0] && edge[0]) || (guard[1] && edge[1]) ? 'block' : 'hit';
        this.win = { start: frame, free: [null, null], kind };
      }
      if (this.win) {
        for (let s = 0; s < 2; s++) if (this.win.free[s] == null && !busy[s]) this.win.free[s] = frame;
        if (this.win.free[0] != null && this.win.free[1] != null) {
          this.winResult = { adv: this.win.free[1] - this.win.free[0], kind: this.win.kind };
          this.win = null;
        } else if (frame - this.win.start > TIMEOUT) {
          this.win = null;
        }
      }

      const anyBusy = state[0] !== null || state[1] !== null;
      if (anyBusy) {
        if (this.frozen) this.begin();
        for (let s = 0; s < 2; s++) this.cells[s].push(state[s] ? { s: state[s] } : null);
        if (this.cells[0].length > WINDOW) { this.cells[0].shift(); this.cells[1].shift(); this.shifted = (this.shifted || 0) + 1; }
        this.refresh(false);
      } else if (this.live) {
        this.refresh(true);
        this.live = false; this.frozen = true;
      }
    }

    begin() {
      this.cells = [[], []];
      this.info = [this.newInfo(), this.newInfo()];
      this.winResult = null;
      this.shifted = 0;
      this.live = true; this.frozen = false;
    }

    // Startup / total / advantage from the recorded cells and the last completed window; `done` when both
    // sides are idle again.
    refresh(done) {
      const first = (c) => c.findIndex((x) => x), last = (c) => { for (let i = c.length - 1; i >= 0; i--) if (c[i]) return i; return -1; };
      const infos = [this.newInfo(), this.newInfo()];
      for (let s = 0; s < 2; s++) {
        const c = this.cells[s], f = first(c);
        if (f < 0) continue;
        const r = c.findIndex((x) => x && x.s === 'R');
        if (r >= 0 && !c.slice(f, r).some((x) => x && (x.s === 'Y' || x.s === 'K'))) infos[s].startup = r - f + 1;
        if (done && !c.some((x) => x && (x.s === 'Y' || x.s === 'K'))) infos[s].total = last(c) - f + 1;
      }
      if (done && this.winResult) {
        const adv = this.winResult.adv;
        infos[0].adv = adv; infos[1].adv = -adv;
        infos[0].kind = infos[1].kind = this.winResult.kind;
      }
      this.info = infos;
    }
  }

  // ---- run-length markers (a digit in the last cell of a run, as in SF6) ----
  function runs(cells) {
    const out = [];
    let i = 0;
    while (i < cells.length) {
      const c = cells[i];
      if (!c) { i++; continue; }
      let j = i;
      while (j + 1 < cells.length && cells[j + 1] && cells[j + 1].s === c.s) j++;
      out.push({ s: c.s, from: i, to: j, n: j - i + 1 });
      i = j + 1;
    }
    return out;
  }

  const api = { Meter, runs, readSide, WINDOW, REC, PLAYER_BYTES, EXTRA_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KofFrameMeterCore = api;

  // ---------------------------------------------------------------- page glue (browser only)
  if (typeof document === 'undefined') return;
  const params = new URLSearchParams(location.search);
  if (!params.has('framemeter') || params.get('framemeter') === '0') return;

  const num = (v, d) => { if (v == null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
  const legacy = params.get('fm_model') === 'legacy' || params.has('fm_neutral');
  const meter = new Meter({ actOffset: num(params.get('fm_act'), ACT_OFFSET), neutralMax: num(params.get('fm_neutral'), 26), legacy });
  const learn = params.get('fm_learn') === '1';
  const COLORS = { G: '#1fc8a0', R: '#d6336c', B: '#1c70d6', Y: '#ffe600', K: '#fff59d' };
  const CELL = 8, LEFT = 10, BAR_H = 14, W = LEFT * 2 + WINDOW * CELL, H = learn ? 230 : 118;

  // The meter lives in its own strip above the game, in the page's flex column, so the game canvas
  // shrinks to the remaining space instead of being covered. F8 hides the strip (the game grows back).
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText = 'display:block;width:' + W + 'px;max-width:100%;height:auto;'; // the shell's `canvas {width:100%;height:100%}` rule would stretch it
  const dock = document.createElement('div');
  dock.id = 'fm-dock';
  dock.style.cssText = 'flex:none;display:flex;justify-content:center;background:#08080a;border-bottom:1px solid #222;padding:2px 0;';
  dock.appendChild(canvas);
  const stage = document.getElementById('stage');
  document.body.insertBefore(dock, stage || document.body.firstChild);
  const g = canvas.getContext('2d');
  const refit = () => window.dispatchEvent(new Event('resize'));
  let visible = true;
  addEventListener('keydown', (e) => { if (e.key === 'F8') { visible = !visible; dock.style.display = visible ? 'flex' : 'none'; refit(); e.preventDefault(); } });
  requestAnimationFrame(() => requestAnimationFrame(refit));


  // ---- recorder: F9 start/stop, F7 marker (numbered), F10 download CSV (+ full struct JSON with ?fm_full=1) ----
  const full = params.get('fm_full') === '1', MAX_ROWS = 7200;
  let recording = false, rows = [], markerNext = 1, pendingMarker = '', recStart = 0;
  const hexs = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  function recordStep(rec) {
    const row = { frame: rec.frame, scene: rec.scene, mode: rec.mode, marker: pendingMarker, sides: [] };
    pendingMarker = '';
    for (let s = 0; s < 2; s++) {
      const sd = rec.sides[s], ok = rec.valid & (1 << s);
      if (!ok) { row.sides.push(null); continue; }
      const p = sd.p, ex = sd.ex, dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      const act = meter.actOffset;
      row.sides.push({
        char: ex[0], point: sd.point, act: p[act], prev: p[act + 2], hb: p[HB_OFFSET],
        f490: dv.getUint32(F_ATTACK, true), f494: dv.getUint32(F_STATE, true), f530: dv.getUint32(F_GUARD, true), f48c: dv.getUint32(F_MOVE, true), pose: p[POSE_OFFSET] & 0xF,
        busy: meter.raw[s].busy | 0, react: meter.raw[s].react | 0, hs: meter.raw[s].hs | 0,
        hp: ex[4] | (ex[5] << 8), guard: ex[0xA] | (ex[0xB] << 8),
        stunGauge: ex[8] | (ex[9] << 8), stunTimer: dv.getInt16(0x582, true), w1c0: dv.getUint16(0x1C0, true), b4f0: p[0x4F0], facing: p[0x8C],
        x: dv.getFloat32(0, true), y: dv.getFloat32(4, true), pad: sd.pad, combo: sd.combo, cell: (meter.state && meter.state[s]) || '',
        raw: full ? hexs(p) : null,
      });
    }
    rows.push(row);
    if (rows.length >= MAX_ROWS) toggleRecording(false);
  }
  function toggleRecording(on) {
    recording = on === undefined ? !recording : on;
    if (recording) { rows = []; markerNext = 1; pendingMarker = ''; recStart = performance.now(); }
  }
  const COLS = ['char', 'point', 'act', 'prev', 'hb', 'f490', 'f494', 'f530', 'f48c', 'pose', 'busy', 'react', 'hs', 'hp', 'guard', 'stunGauge', 'stunTimer', 'w1c0', 'b4f0', 'facing', 'x', 'y', 'pad', 'combo', 'cell'];
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function saveRecording() {
    if (!rows.length) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const head = ['frame', 'scene', 'mode', 'marker'];
    for (const n of [1, 2]) for (const c of COLS) head.push('p' + n + '_' + c);
    const lines = [head.join(',')];
    for (const r of rows) {
      const cells = [r.frame, '0x' + r.scene.toString(16), r.mode, r.marker];
      for (const sd of r.sides) for (const c of COLS) cells.push(sd ? (typeof sd[c] === 'number' && (c === 'pad' || c === 'f490' || c === 'f494' || c === 'f530' || c === 'f48c') ? '0x' + sd[c].toString(16) : sd[c]) : '');
      lines.push(cells.join(','));
    }
    const note = '# KOF XI frame meter recording; model ' + (meter.legacy ? 'legacy act<= ' + meter.neutralMax : 'engine') + ', act offset +0x' + meter.actOffset.toString(16) + ', ' + rows.length + ' frames\n';
    download('fm-rec-' + stamp + '.csv', note + lines.join('\n') + '\n', 'text/csv');
    if (full) download('fm-rec-' + stamp + '-full.json', JSON.stringify({ actOffset: meter.actOffset, rows: rows.map((r) => ({ frame: r.frame, marker: r.marker, p: r.sides.map((sd) => sd && sd.raw) })) }), 'application/json');
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'F9') { toggleRecording(); e.preventDefault(); }
    else if (e.key === 'F7') { if (recording) pendingMarker = 'M' + markerNext++; e.preventDefault(); }
    else if (e.key === 'F10') { saveRecording(); e.preventDefault(); }
  });

  let last = 0, enabled = false, prevSnap = [null, null];
  const changes = [new Uint16Array(PLAYER_BYTES), new Uint16Array(PLAYER_BYTES)];
  let learnFrames = 0;

  function readRecords() {
    const M = root.Module;
    if (!M || !M.running || !M._ps2web_fm_ring || !M._ps2web_fm_enable) return;
    if (!enabled) { M._ps2web_fm_enable(1); enabled = true; }
    const ptr = M._ps2web_fm_ring(), heap = M.HEAPU8, i32 = new Int32Array(heap.buffer);
    const rb = i32[(ptr + 4) >> 2], count = i32[(ptr + 8) >> 2], head = Atomics.load(i32, (ptr + 12) >> 2);
    if (i32[ptr >> 2] !== 0x52544D46 || !rb || !count) return;
    if (head - last > count - 4) last = head - (count - 4);
    for (; last < head; last++) {
      const o = ptr + 64 + (last % count) * rb;
      const dv = new DataView(heap.buffer, o, rb), valid = heap[o + REC.valid];
      const sides = [0, 1].map((s) => ({
        point: heap[o + REC.point + s],
        p: heap.slice(o + REC.player + s * PLAYER_BYTES, o + REC.player + (s + 1) * PLAYER_BYTES),
        ex: heap.slice(o + REC.extra + s * EXTRA_BYTES, o + REC.extra + (s + 1) * EXTRA_BYTES),
        combo: heap[o + REC.combo + s],
        pad: heap[o + REC.pad + s * 2] | (heap[o + REC.pad + s * 2 + 1] << 8),
      }));
      const rec = { frame: dv.getUint32(REC.frame, true), scene: dv.getUint16(REC.scene, true), mode: heap[o + REC.mode], valid, sides };
      meter.push(rec);
      if (learn) learnStep(rec);
      if (recording) recordStep(rec);
    }
  }

  function learnStep(rec) {
    if ((rec.scene & 0xFF) !== SCENE_COMBAT) return;
    learnFrames++;
    for (let s = 0; s < 2; s++) {
      const p = rec.sides[s].p, prev = prevSnap[s];
      if (prev) for (let i = 0; i < PLAYER_BYTES; i++) if (p[i] !== prev[i] && changes[s][i] < 65535) changes[s][i]++;
      prevSnap[s] = p;
    }
    if (learnFrames % 360 === 0) { changes[0].fill(0); changes[1].fill(0); }
  }

  function text(s, x, y, color) { g.fillStyle = color || '#fff'; g.fillText(s, x, y); }
  function hex(v, w) { return (v == null ? '--' : v.toString(16).toUpperCase().padStart(w || 2, '0')); }

  function drawHeader(s, y) {
    const i = meter.info[s];
    const f = (v) => (v == null ? '--' : v + 'F');
    let line = 'Startup ' + f(i.startup) + ' / Total ' + f(i.total) + ' / Advantage ';
    text(line, LEFT, y);
    const x = LEFT + g.measureText(line).width;
    if (i.adv == null) text('--', x, y);
    else text((i.adv > 0 ? '+' : '') + i.adv + 'F' + (i.kind ? ' ' + i.kind.toUpperCase() : ''), x, y, i.adv > 0 ? '#5aa9ff' : i.adv < 0 ? '#ff6b6b' : '#fff');
    const label = 'Player ' + (s + 1);
    text(label, W - LEFT - g.measureText(label).width, y);
  }

  function drawBar(s, y) {
    g.fillStyle = '#000'; g.fillRect(LEFT - 2, y - 2, WINDOW * CELL + 4, BAR_H + 4);
    for (let i = 0; i < WINDOW; i++) {
      const c = meter.cells[s][i];
      g.fillStyle = c ? COLORS[c.s] : '#1b1b1b';
      g.fillRect(LEFT + i * CELL, y, CELL - 1, BAR_H);
    }
    g.font = 'bold 9px monospace';
    for (const r of runs(meter.cells[s])) {
      if (r.n < 2) continue;
      g.fillStyle = r.s === 'Y' || r.s === 'K' || r.s === 'G' ? '#000' : '#fff';
      g.fillText(String(r.n), LEFT + r.to * CELL - (r.n > 9 ? 3 : 0), y + BAR_H - 3);
    }
    g.font = '12px monospace';
  }

  function draw() {
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#08080a'; g.fillRect(0, 0, W, H);
    g.font = '12px monospace'; g.textBaseline = 'alphabetic';
    drawHeader(0, 14); drawBar(0, 20);
    drawBar(1, 40); drawHeader(1, 72);
    const R = meter.raw, rec = meter.rec;
    g.font = '10px monospace';
    if (!rec) text('FRAME METER (experimental) - waiting for the game', LEFT, 90, '#aaa');
    else {
      const inCombat = (rec.scene & 0xFF) === SCENE_COMBAT;
      if (recording) text('REC ' + rows.length + 'f', W - 70, 88, '#ff5555');
      text('FRAME METER (experimental)  scene ' + hex(rec.scene, 4) + ' mode ' + hex(rec.mode) + (inCombat ? '' : '  (not in a fight)') + (meter.legacy ? '  legacy' : ''), LEFT, 88, '#aaa');
      const p = (s) => R[s].act == null ? 'P' + (s + 1) + ' -' : 'P' + (s + 1) + ' act=' + R[s].act + ' hb=' + hex(R[s].hb) + ' hp=' + R[s].hp + ' grd=' + R[s].guard + ' 490=' + hex(R[s].f490, 8) + ' 494=' + hex(R[s].f494, 8) + ' 530=' + hex(R[s].f530, 8) + ' 48c=' + hex(R[s].f48c, 8) + (R[s].busy ? ' BUSY' : ' free');
      text(p(0), LEFT, 101, '#aaa');
      text(p(1), LEFT, 112, '#aaa');
      text('F8 hide  F9 ' + (recording ? 'stop' : 'record') + '  F7 marker  F10 save' + (rows.length && !recording ? ' (' + rows.length + 'f)' : '') + '   busy = 490&3 | 494.27 | 494.0 | 530.400 | pose 2 | 48c', LEFT, 124, '#777');
    }
    if (learn) {
      g.font = '10px monospace';
      text('learn: rare byte changes (offset=value, changes/6s)', LEFT, 130, '#9f9');
      for (let s = 0; s < 2; s++) {
        const list = [];
        for (let i = 0; i < PLAYER_BYTES; i++) if (changes[s][i] > 0 && changes[s][i] <= 14) list.push(i);
        list.sort((a, b) => changes[s][a] - changes[s][b] || a - b);
        const p = prevSnap[s];
        text('P' + (s + 1) + ': ' + list.slice(0, 11).map((i) => '+' + hex(i, 3) + '=' + (p ? p[i] : '?') + '(' + changes[s][i] + ')').join(' '), LEFT, 145 + s * 14, '#cfc');
      }
    }
  }

  function frame() {
    try { readRecords(); draw(); } catch (e) { if (!frame.warned) { frame.warned = true; console.warn('[frame-meter]', e); } }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})(typeof window !== 'undefined' ? window : globalThis);
