// Experimental KOF XI frame meter (Street Fighter 6 style) for the PS2 web recomp.
//
// Off unless the page URL has ?framemeter (any value but 0). It reads the per-frame capture ring the
// runtime fills (runtime/include/ps2/framemeter.hpp), turns it into per-player timelines and draws them
// in a strip above the game (the game shrinks to make room). Addresses and struct offsets are those of the Japanese release (SLPS-25660).
//
// Colours follow SF6: green = startup, crimson = active (an attack or throw box is live), blue = recovery,
// yellow = the defender's hit/block stun (pale yellow = block). Header per player: Startup / Total / Advantage,
// using the rule read off SF6's own screenshots: startup = cells up to and including the first active frame,
// total = all cells of the attacker's bar, advantage = last stun cell of the defender - last cell of the attacker.
//
// "Actionable" is the weak point: the player's action id (struct byte, default +0xEC) is compared with a
// neutral limit (ids <= limit count as neutral: stand, walk, crouch, jump...). Both are guesses taken from the
// arcade struct map and must be confirmed; override them with ?fm_act=0xEC&fm_neutral=26. ?fm_learn=1 lists the
// struct bytes that change rarely (candidates for the action id) while you play.
(function (root) {
  'use strict';

  const REC = { frame: 0x00, scene: 0x04, mode: 0x06, valid: 0x07, point: 0x08, player: 0x10, extra: 0xC10, combo: 0xC50 };
  const PLAYER_BYTES = 0x600, EXTRA_BYTES = 0x20;
  const HB_OFFSET = 0x39E, HB_ATTACK_MASK = 0x11; // bit 0 attack box, bit 4 throw box (viewer's hitbox slots)
  const SCENE_COMBAT = 0x03;                       // low byte of the scene word 0x303
  const WINDOW = 80;                               // cells per bar (SF6 shows about 80)
  const STUN_GRACE = 12;                           // frames to wait for the defender's action to leave neutral

  class Meter {
    constructor(opts) {
      opts = opts || {};
      this.actOffset = opts.actOffset == null ? 0xEC : opts.actOffset;
      this.neutralMax = opts.neutralMax == null ? 26 : opts.neutralMax;
      this.reset();
    }

    reset() {
      this.side = [this.newSide(), this.newSide()];
      this.cells = [[], []];        // per cell: null | { s: 'G'|'R'|'B'|'Y'|'K', n?: run length marker }
      this.live = false;            // an interaction is being recorded
      this.frozen = true;           // finished interaction stays on screen until the next one starts
      this.frames = 0;
      this.info = [this.newInfo(), this.newInfo()];
      this.contact = [null, null];  // contact received by side s: 'hit' | 'block'
      this.raw = [{}, {}];
    }

    newSide() {
      return { char: -1, hp: -1, guard: -1, stunned: false, sawBusy: false, stunAge: 0, kind: null, hadActive: false, busyOnce: false };
    }

    newInfo() { return { startup: null, total: null, adv: null, kind: null }; }

    // rec: { frame, scene, mode, valid, sides: [ { point, p: Uint8Array, ex: Uint8Array, combo } , ... ] }
    push(rec) {
      this.frames++;
      this.rec = rec;
      const inCombat = (rec.scene & 0xFF) === SCENE_COMBAT;
      const state = [null, null], activeNow = [false, false], contactNow = [null, null];
      for (let s = 0; s < 2; s++) {
        const S = this.side[s], sd = rec.sides[s];
        if (!inCombat || !(rec.valid & (1 << s)) || !sd) { this.side[s] = this.newSide(); continue; }
        const ex = sd.ex, p = sd.p;
        const hp = ex[4] | (ex[5] << 8), guard = ex[0xA] | (ex[0xB] << 8), char = ex[0];
        if (S.char !== char) { Object.assign(S, this.newSide(), { char }); }
        if (S.hp >= 0 && hp < S.hp) contactNow[s] = 'hit';
        else if (S.guard >= 0 && guard < S.guard) contactNow[s] = 'block';
        S.hp = hp; S.guard = guard;
        const act = p[this.actOffset], hb = p[HB_OFFSET];
        this.raw[s] = { act, prev: p[this.actOffset + 2], hb, hp, guard, char, point: sd.point };
        const neutral = act <= this.neutralMax;
        const active = (hb & HB_ATTACK_MASK) !== 0;
        activeNow[s] = active;
        if (contactNow[s]) { S.stunned = true; S.kind = contactNow[s]; S.sawBusy = false; S.stunAge = 0; this.contact[s] = contactNow[s]; }
        if (S.stunned) {
          S.stunAge++;
          if (!neutral) S.sawBusy = true;
          else if (S.sawBusy || S.stunAge > STUN_GRACE) { S.stunned = false; }
        }
        if (S.stunned) state[s] = S.kind === 'block' ? 'K' : 'Y';
        else if (active) { state[s] = 'R'; S.hadActive = true; }
        else if (!neutral) state[s] = S.hadActive ? 'B' : 'G';
        else { S.hadActive = false; state[s] = null; }
      }
      const busy = state[0] !== null || state[1] !== null;
      if (busy) {
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
      this.contact = [null, null];
      this.info = [this.newInfo(), this.newInfo()];
      this.shifted = 0;
      this.live = true; this.frozen = false;
    }

    // Startup / total / advantage from the cells recorded so far; `done` when both sides are idle again.
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
      const hit = [this.contact[0], this.contact[1]];
      if (done && (hit[0] === null) !== (hit[1] === null)) {
        const d = hit[0] ? 0 : 1, a = 1 - d;
        const adv = last(this.cells[d]) - last(this.cells[a]);
        infos[a].adv = adv; infos[d].adv = -adv; infos[a].kind = infos[d].kind = hit[d];
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

  const api = { Meter, runs, WINDOW, REC, PLAYER_BYTES, EXTRA_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KofFrameMeterCore = api;

  // ---------------------------------------------------------------- page glue (browser only)
  if (typeof document === 'undefined') return;
  const params = new URLSearchParams(location.search);
  if (!params.has('framemeter') || params.get('framemeter') === '0') return;

  const num = (v, d) => { if (v == null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
  const meter = new Meter({ actOffset: num(params.get('fm_act'), 0xEC), neutralMax: num(params.get('fm_neutral'), 26) });
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
      }));
      const rec = { frame: dv.getUint32(REC.frame, true), scene: dv.getUint16(REC.scene, true), mode: heap[o + REC.mode], valid, sides };
      meter.push(rec);
      if (learn) learnStep(rec);
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
      text('FRAME METER (experimental)  F8 hides   scene ' + hex(rec.scene, 4) + ' mode ' + hex(rec.mode) + (inCombat ? '' : '  (not in a fight)'), LEFT, 88, '#aaa');
      const p = (s) => R[s].act == null ? 'P' + (s + 1) + ' -' : 'P' + (s + 1) + ' act[+' + hex(meter.actOffset, 3) + ']=' + R[s].act + ' hb=' + hex(R[s].hb) + ' hp=' + R[s].hp + ' grd=' + R[s].guard;
      text(p(0) + '   ' + p(1), LEFT, 101, '#aaa');
      text('neutral <= ' + meter.neutralMax + '   legend: green startup, red active, blue recovery, yellow stun (pale = block)', LEFT, 113, '#777');
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
