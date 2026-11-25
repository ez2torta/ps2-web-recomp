// Run: node tests/frame_meter_page_test.js  -- exercises the page glue with a fake Module and a shared-memory ring
const assert = require('assert');
const RB = 0xC60, COUNT = 256, BASE = 64;
const mem = new SharedArrayBuffer(BASE + RB * COUNT + 4096), u8 = new Uint8Array(mem), dv = new DataView(mem), i32 = new Int32Array(mem);
dv.setUint32(0, 0x52544D46, true); dv.setUint32(4, RB, true); dv.setUint32(8, COUNT, true);
let head = 0;
function writeFrame(f, act0, hb0, act1, pad) {
  const o = BASE + (head % COUNT) * RB;
  u8.fill(0, o, o + RB);
  dv.setUint32(o, f, true); dv.setUint16(o + 4, 0x303, true); u8[o + 6] = 8; u8[o + 7] = 3;
  for (let s = 0; s < 2; s++) {
    u8[o + 0x10 + s * 0x600 + 0xEC] = s ? act1 : act0; u8[o + 0x10 + s * 0x600 + 0x39E] = s ? 0 : hb0;
    dv.setUint32(o + 0x10 + s * 0x600 + 0x490, (s ? act1 : act0) ? 1 : 0, true);  // any action id = an attack action here
    const e = o + 0xC10 + s * 0x20; u8[e] = s ? 0x20 : 0; dv.setUint16(e + 4, 112, true); dv.setUint16(e + 0xA, 112, true);
    dv.setUint16(o + 0xC52 + s * 2, s ? 0 : pad, true);
  }
  head++; Atomics.store(i32, 3, head);
}
const listeners = {}, raf = [], saved = [], created = [];
const el = () => ({ style: {}, appendChild() {}, remove() {}, click() { saved.push(this); }, getContext: () => new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 50 }) : () => {}), set: () => true }) });
global.document = { createElement: (t) => { const e = el(); created.push(e); return e; }, getElementById: () => ({}), body: { insertBefore() {}, appendChild() {}, firstChild: null } };
global.location = { search: '?framemeter=1&fm_full=1' };
global.addEventListener = (n, f) => { (listeners[n] = listeners[n] || []).push(f); };
global.requestAnimationFrame = (f) => raf.push(f);
global.dispatchEvent = () => {}; global.Event = class { constructor(n) { this.type = n; } };
global.window = global; global.performance = { now: () => 1 };
const blobs = []; URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; };
global.Module = { running: true, HEAPU8: u8, _ps2web_fm_ring: () => 0, _ps2web_fm_enable() { this.enabled = 1; } };
require('../web/frame-meter.js');
const key = (k) => listeners.keydown.forEach((f) => f({ key: k, preventDefault() {} }));
const tick = () => { const f = raf.splice(0); f.forEach((g) => g()); };

tick();                                  // first frame: enables capture
assert.strictEqual(Module.enabled, 1);
key('F9');                               // start recording
for (let f = 0; f < 6; f++) writeFrame(f, 0, 0, 0, 0);
tick();
key('F7');                               // marker lands on the next recorded frame
for (let f = 6; f < 20; f++) writeFrame(f, f < 10 ? 89 : 0, f >= 8 && f < 10 ? 1 : 0, 0, f === 6 ? 0x8000 : 0);
tick();
key('F10');                              // download
assert.strictEqual(blobs.length, 2, 'csv + full json');
(async () => {
  const csv = await blobs[0].text(), json = JSON.parse(await blobs[1].text());
  const lines = csv.trim().split('\n');
  console.log(lines[0]); console.log(lines[1]); console.log(lines[8]); console.log(lines[10]);
  assert.strictEqual(lines.length, 1 + 1 + 20, 'note + header + 20 rows');
  assert.ok(lines[1].startsWith('frame,scene,mode,marker,p1_char'));
  assert.ok(lines.some((l) => l.split(',')[3] === 'M1'));
  assert.ok(lines.some((l) => l.includes('0x8000')));
  assert.strictEqual(json.rows.length, 20); assert.strictEqual(json.rows[0].p[0].length, 0x600 * 2);
  console.log('page glue test passed');
})();
