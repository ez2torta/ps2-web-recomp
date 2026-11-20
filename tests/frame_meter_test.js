// Run: node tests/frame_meter_test.js
const assert = require('assert');
const { Meter, runs } = require('../web/frame-meter.js');

function side(char, hp, guard, act, hb) {
  const p = new Uint8Array(0x600), ex = new Uint8Array(0x20);
  p[0xEC] = act; p[0x39E] = hb;
  ex[0] = char; ex[4] = hp & 255; ex[5] = hp >> 8; ex[0xA] = guard & 255; ex[0xB] = guard >> 8;
  return { point: 0, p, ex, combo: 0 };
}
function rec(f, a, d) { return { frame: f, scene: 0x303, mode: 8, valid: 3, sides: [a, d] }; }
const seq = (m, spec) => spec.forEach((s, i) => m.push(rec(i, s[0], s[1])));
const rep = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const str = (cells) => cells.map((c) => (c ? c.s : '.')).join('');

// SF6 screenshot: attacker 3 green, 3 red, 7 blue (13 cells); defender: 3 empty, 15 yellow -> Startup 4F, Total 13F, +5
{
  const m = new Meter();
  let hp = 112;
  const spec = [];
  for (let t = 0; t < 4; t++) spec.push([side(1, 112, 112, 0, 0), side(2, 112, 112, 0, 0)]);       // idle lead-in
  for (let t = 0; t < 3; t++) spec.push([side(1, 112, 112, 88, 0), side(2, 112, 112, 0, 0)]);       // startup
  for (let t = 0; t < 3; t++) spec.push([side(1, 112, 112, 88, 1), side(2, t === 0 ? 107 : 107, 112, 40 + 264, 0)]); // active; hit on first active frame
  for (let t = 0; t < 12; t++) spec.push([side(1, 112, 112, t < 7 ? 88 : 0, 0), side(2, 107, 112, t < 12 ? 304 : 0, 0)]);
  for (let t = 0; t < 6; t++) spec.push([side(1, 112, 112, 0, 0), side(2, 107, 112, 0, 0)]);        // both idle
  seq(m, spec);
  console.log('P1', str(m.cells[0])); console.log('P2', str(m.cells[1]));
  console.log(JSON.stringify(m.info));
  assert.strictEqual(m.cells[0].length, m.cells[1].length);
  assert.strictEqual(m.info[0].startup, 4);
  assert.strictEqual(m.info[0].kind, 'hit');
}
console.log('ok sf6 example shape');

// whiff: no contact -> total known, advantage stays '--'
{
  const m = new Meter(); const spec = [];
  for (let t = 0; t < 2; t++) spec.push([side(1, 112, 112, 0, 0), side(2, 112, 112, 0, 0)]);
  for (let t = 0; t < 5; t++) spec.push([side(1, 112, 112, 90, t >= 2 && t < 4 ? 1 : 0), side(2, 112, 112, 0, 0)]);
  for (let t = 0; t < 3; t++) spec.push([side(1, 112, 112, 0, 0), side(2, 112, 112, 0, 0)]);
  seq(m, spec);
  assert.strictEqual(str(m.cells[0]), 'GGRRB'); assert.strictEqual(m.info[0].total, 5); assert.strictEqual(m.info[0].adv, null);
}
// block: guard drops -> pale yellow, negative advantage for the attacker
{
  const m = new Meter(); const spec = [];
  for (let t = 0; t < 2; t++) spec.push([side(1, 112, 112, 0, 0), side(2, 112, 112, 0, 0)]);
  for (let t = 0; t < 2; t++) spec.push([side(1, 112, 112, 91, 0), side(2, 112, 112, 0, 0)]);
  spec.push([side(1, 112, 112, 91, 1), side(2, 112, 109, 40, 0)]);
  for (let t = 0; t < 7; t++) spec.push([side(1, 112, 112, 91, 0), side(2, 112, 109, 40, 0)]);
  for (let t = 0; t < 3; t++) spec.push([side(1, 112, 112, 91, 0), side(2, 112, 109, 0, 0)]); // defender free first
  for (let t = 0; t < 3; t++) spec.push([side(1, 112, 112, 0, 0), side(2, 112, 109, 0, 0)]);
  seq(m, spec);
  console.log('block P1', str(m.cells[0]), 'P2', str(m.cells[1]), JSON.stringify(m.info));
  assert.strictEqual(m.info[0].kind, 'block'); assert.ok(m.info[0].adv < 0); assert.strictEqual(m.info[1].adv, -m.info[0].adv);
  assert.ok(m.cells[1].some((c) => c && c.s === 'K'));
}
// multi hit: active / recovery / active; total and advantage only at the end; one continuous stun
{
  const m = new Meter(); const spec = []; let hp = 112;
  spec.push([side(1, 112, 112, 0, 0), side(2, hp, 112, 0, 0)]);
  for (let t = 0; t < 4; t++) spec.push([side(1, 112, 112, 120, 0), side(2, hp, 112, 0, 0)]);
  for (let hit = 0; hit < 3; hit++) {
    hp -= 4;
    spec.push([side(1, 112, 112, 120, 1), side(2, hp, 112, 304, 0)]);
    for (let t = 0; t < 3; t++) spec.push([side(1, 112, 112, 120, 0), side(2, hp, 112, 304, 0)]);
  }
  for (let t = 0; t < 9; t++) spec.push([side(1, 112, 112, 0, 0), side(2, hp, 112, 304, 0)]);
  for (let t = 0; t < 3; t++) spec.push([side(1, 112, 112, 0, 0), side(2, hp, 112, 0, 0)]);
  seq(m, spec);
  console.log('multi P1', str(m.cells[0]), 'P2', str(m.cells[1]), JSON.stringify(m.info[0]));
  assert.ok(m.info[0].adv > 0); assert.strictEqual(runs(m.cells[1]).filter((r) => r.s === 'Y').length, 1);
}
console.log('all meter tests passed');
