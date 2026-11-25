// Run: node tests/frame_meter_test.js
//
// The classifier now uses the engine's own "busy" signals (found on the PS2 practice dummy by the frame-advantage
// work of ATG-02), not a threshold over the action id:
//   busy = attack (+0x490 & 3) | hit stop (+0x494 bit 27) | reaction (+0x494 bit 0) | guard stun (+0x530 0x400)
//        | airborne (pose +0x27E == 2) | uninterruptible movement (+0x48C mask)
// Advantage = FREE(P2) - FREE(P1), FREE being the first frame after a contact in which a side is not busy.
const assert = require('assert');
const { Meter, runs, readSide } = require('../web/frame-meter.js');

const ATK = 0x01, REACT = 0x01, HS = 0x08000000, GSTUN = 0x400;

function side(char, o) {
  o = o || {};
  const p = new Uint8Array(0x600), ex = new Uint8Array(0x20), dv = new DataView(p.buffer);
  p[0xEC] = (o.act || 0) & 0xFF; p[0xEC + 2] = (o.prev || 0) & 0xFF; p[0x39E] = o.hb || 0;
  dv.setUint32(0x490, o.attack || 0, true);
  dv.setUint32(0x494, o.state || 0, true);
  dv.setUint32(0x530, o.guard32 || 0, true);
  dv.setUint32(0x48C, o.move || 0, true);
  p[0x27E] = o.pose || 0;
  const hp = o.hp == null ? 112 : o.hp, gd = o.guardGauge == null ? 112 : o.guardGauge;
  ex[0] = char; ex[4] = hp & 255; ex[5] = hp >> 8; ex[0xA] = gd & 255; ex[0xB] = gd >> 8;
  return { point: 0, p, ex, combo: 0 };
}
const IDLE = (c) => side(c, {});
const START = (c) => side(c, { act: 88, attack: ATK });
const ACTIVE = (c) => side(c, { act: 88, attack: ATK, hb: 1 });
const RECOV = (c) => side(c, { act: 88, attack: ATK });
const HIT = (c, n) => side(c, { act: n == null ? 304 : n, state: REACT });
const BLOCK = (c) => side(c, { act: 44, guard32: GSTUN });

function play(m, spec) { spec.forEach((s, i) => m.push({ frame: i, scene: 0x303, mode: 8, valid: 3, sides: [s[0], s[1]] })); }
const rep = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const str = (cells) => cells.map((c) => (c ? c.s : '.')).join('');

// SF6 screenshot: attacker 3 green, 3 crimson, 7 blue (13 cells); defender 15 yellow -> Startup 4F, Total 13F, +5.
{
  const m = new Meter(), spec = [];
  spec.push(...rep(4, () => [IDLE(1), IDLE(2)]));                       // lead-in
  spec.push(...rep(3, () => [START(1), IDLE(2)]));                       // startup
  spec.push(...rep(3, (i) => [ACTIVE(1), HIT(2)]));                      // active; contact on the first active frame
  spec.push(...rep(7, () => [RECOV(1), HIT(2)]));                        // recovery; stun continues
  spec.push(...rep(5, () => [IDLE(1), HIT(2)]));                         // attacker free, stun continues
  spec.push(...rep(3, () => [IDLE(1), IDLE(2)]));                        // both free
  play(m, spec);
  console.log('SF6  P1', str(m.cells[0])); console.log('SF6  P2', str(m.cells[1]));
  console.log('     info', JSON.stringify(m.info));
  assert.strictEqual(str(m.cells[0]), 'GGGRRRBBBBBBB.....');   // attacker free at 13, defender stun still running
  assert.strictEqual(str(m.cells[1]), '...YYYYYYYYYYYYYYY');
  assert.strictEqual(m.cells[0].length, m.cells[1].length);
  assert.strictEqual(m.info[0].startup, 4);
  assert.strictEqual(m.info[0].total, 13);
  assert.strictEqual(m.info[0].adv, 5);
  assert.strictEqual(m.info[1].adv, -5);
  assert.strictEqual(m.info[0].kind, 'hit');
}
console.log('ok sf6 example (startup 4 / total 13 / +5)');

// Whiff: no contact -> total known, advantage stays '--'.
{
  const m = new Meter(), spec = [];
  spec.push(...rep(2, () => [IDLE(1), IDLE(2)]));
  spec.push(...rep(2, () => [START(1), IDLE(2)]));
  spec.push(...rep(2, () => [ACTIVE(1), IDLE(2)]));
  spec.push(...rep(1, () => [RECOV(1), IDLE(2)]));
  spec.push(...rep(2, () => [IDLE(1), IDLE(2)]));
  play(m, spec);
  console.log('whiff P1', str(m.cells[0]));
  assert.strictEqual(str(m.cells[0]), 'GGRRB');
  assert.strictEqual(m.info[0].total, 5);
  assert.strictEqual(m.info[0].adv, null);
}
console.log('ok whiff (total known, advantage --)');

// Hit stop alone starts a window (the victim's hit stop starts one frame after the attacker's): a contact on
// either side's hit stop rising edge, even before any reaction bit shows.
{
  const m = new Meter(), spec = [];
  spec.push(...rep(3, () => [IDLE(1), IDLE(2)]));
  spec.push([side(1, { act: 88, attack: ATK, state: HS }), side(2, { act: 39, state: HS })]);
  spec.push([side(1, { act: 88, attack: ATK, state: HS }), side(2, { act: 39, state: HS })]);
  spec.push(...rep(2, () => [IDLE(1), IDLE(2)]));
  play(m, spec);
  console.log('hitstop P1', str(m.cells[0]), 'P2', str(m.cells[1]), JSON.stringify(m.info));
  assert.strictEqual(m.info[0].adv, 0);
}
console.log('ok hit stop starts a window');

// Block: guard stun -> pale yellow, negative advantage for the attacker.
{
  const m = new Meter(), spec = [];
  spec.push(...rep(2, () => [IDLE(1), IDLE(2)]));
  spec.push(...rep(2, () => [START(1), IDLE(2)]));
  spec.push([ACTIVE(1), BLOCK(2)]);                                      // contact -> guard stun
  spec.push(...rep(7, () => [RECOV(1), BLOCK(2)]));                      // defender recovers from block first
  spec.push(...rep(3, () => [RECOV(1), IDLE(2)]));
  spec.push(...rep(3, () => [IDLE(1), IDLE(2)]));
  play(m, spec);
  console.log('block P1', str(m.cells[0]), 'P2', str(m.cells[1]), JSON.stringify(m.info));
  assert.strictEqual(m.info[0].kind, 'block');
  assert.ok(m.info[0].adv < 0);
  assert.strictEqual(m.info[1].adv, -m.info[0].adv);
  assert.ok(m.cells[1].some((c) => c && c.s === 'K'));
}
console.log('ok block (pale yellow, negative)');

// Multi hit: active / recovery / active, one continuous stun, advantage after the last hit.
{
  const m = new Meter(), spec = [];
  spec.push([IDLE(1), IDLE(2)]);
  spec.push(...rep(4, () => [START(1), IDLE(2)]));
  for (let hit = 0; hit < 3; hit++) {
    spec.push([ACTIVE(1), HIT(2)]);
    spec.push(...rep(3, () => [RECOV(1), HIT(2)]));
  }
  spec.push(...rep(12, () => [IDLE(1), HIT(2)]));
  spec.push(...rep(3, () => [IDLE(1), IDLE(2)]));
  play(m, spec);
  console.log('multi P1', str(m.cells[0]), 'P2', str(m.cells[1]), JSON.stringify(m.info[0]));
  assert.ok(m.info[0].adv > 0);
  assert.strictEqual(runs(m.cells[1]).filter((r) => r.s === 'Y').length, 1);
}
console.log('ok multi-hit (one stun run, advantage after the last hit)');

// Crouch guard release (the 2026-11-20 play-test mismatch): the end-of-block animation is cancellable by any
// action, so it must count as actionable. With the engine signals it does: the release sets no busy bit.
{
  const m = new Meter(), spec = [];
  spec.push(...rep(2, () => [IDLE(1), IDLE(2)]));
  spec.push(...rep(2, () => [START(1), IDLE(2)]));
  spec.push([ACTIVE(1), BLOCK(2)]);                                      // contact -> guard stun
  spec.push([RECOV(1), BLOCK(2)]); spec.push([RECOV(1), BLOCK(2)]);      // guard stun continues (3 frames)
  // end-of-block animation: action id changes, but no busy bit is set -> the defender is FREE
  spec.push([RECOV(1), side(2, { act: 46 })]); spec.push([RECOV(1), side(2, { act: 46 })]);
  spec.push(...rep(3, () => [IDLE(1), IDLE(2)]));
  play(m, spec);
  console.log('release P1', str(m.cells[0]), 'P2', str(m.cells[1]), JSON.stringify(m.info));
  const k = runs(m.cells[1]).filter((r) => r.s === 'K');
  assert.strictEqual(k.length, 1); assert.strictEqual(k[0].n, 3);        // only the guard stun is busy
  assert.strictEqual(m.info[0].kind, 'block');
}
console.log('ok crouch guard release counts as actionable');

// Wakeup: the back-turned rise is a reaction (busy) until the character can act; advantage waits for it.
{
  const m = new Meter(), spec = [];
  spec.push(...rep(2, () => [IDLE(1), IDLE(2)]));
  spec.push([ACTIVE(1), HIT(2)]);                                        // knock down
  spec.push(...rep(11, () => [IDLE(1), side(2, { act: 298, state: REACT })])); // down + getup animation
  spec.push(...rep(2, () => [IDLE(1), IDLE(2)]));
  play(m, spec);
  console.log('wakeup P1', str(m.cells[0]), 'P2', str(m.cells[1]));
  assert.strictEqual(runs(m.cells[1]).filter((r) => r.s === 'Y').length, 1);
  assert.strictEqual(m.info[0].adv, 11);                                 // P1 free at 3, P2 free at 14
}
console.log('ok wakeup reaction until actionable');

// A jumping side (pose 2) is busy even with no attack box; a plain idle side is not.
{
  const jump = readSide(side(1, { pose: 2 }).p), idle = readSide(side(1, {}).p);
  assert.strictEqual((jump.air), true); assert.strictEqual((idle.air), false);
}
console.log('all meter tests passed');
