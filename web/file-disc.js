/* Optional, file-aware HTTP disc reader. The ISO remains the authority for
 * metadata and gaps. Enable only with ?filedisc=1 and a verified manifest. */
(function (root) {
  'use strict';
  const MAX_FILE = 8 * 1024 * 1024;
  const CHUNK_BYTES = 256 * 1024;
  const MAX_CACHED_FILES = 16; // 16 x 8 MiB + 512 x 256 KiB <= 256 MiB.
  const MAX_CACHED_CHUNKS = 512;
  const MAX_HOT_BYTES = 16 * 1024 * 1024;
  const MAX_FILE_DOWNLOADS = 4;
  const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');

  class PersistentCache {
    constructor() { this.opening = null; }
    open() {
      if (!this.opening) this.opening = new Promise((resolve, reject) => {
        let abandoned = false;
        const request = indexedDB.open('ps2-file-disc-cache-v1', 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          // Version 1 mixed small and large files. Clear only this experimental
          // cache when upgrading; cards and save states live in other databases.
          if (db.objectStoreNames.contains('files')) db.deleteObjectStore('files');
          for (const name of ['files', 'chunks']) {
            const store = db.createObjectStore(name, {keyPath: 'sha256'});
            store.createIndex('used', 'used');
          }
        };
        request.onsuccess = () => {
          if (abandoned) return request.result.close();
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => { abandoned = true; resolve(null); };
      }).catch(() => null);
      return this.opening;
    }
    bucket(size) { return size <= CHUNK_BYTES ? 'chunks' : 'files'; }
    async get(key, size) {
      const db = await this.open();
      if (!db) return null;
      return new Promise(resolve => {
        try {
          const name = this.bucket(size);
          const tx = db.transaction(name, 'readwrite');
          const store = tx.objectStore(name);
          const req = store.get(key);
          let data = null;
          req.onsuccess = () => {
            if (req.result && req.result.data instanceof ArrayBuffer) {
              data = req.result.data;
              store.put({...req.result, used: Date.now()});
            }
          };
          tx.oncomplete = () => resolve(data);
          tx.onerror = tx.onabort = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    }
    async put(key, data) {
      if (data.byteLength > MAX_FILE) return;
      const db = await this.open();
      if (!db) return;
      return new Promise(resolve => {
        try {
          const name = this.bucket(data.byteLength);
          const tx = db.transaction(name, 'readwrite');
          const store = tx.objectStore(name);
          store.put({sha256: key, data, used: Date.now()});
          const count = store.count();
          count.onsuccess = () => {
            let remove = count.result - (name === 'chunks' ? MAX_CACHED_CHUNKS : MAX_CACHED_FILES);
            if (remove <= 0) return;
            const cursor = store.index('used').openCursor();
            cursor.onsuccess = () => {
              if (cursor.result && remove-- > 0) { cursor.result.delete(); cursor.result.continue(); }
            };
          };
          tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
        } catch (_) { resolve(); }
      });
    }
    async remove(key, size) {
      const db = await this.open();
      if (!db) return;
      return new Promise(resolve => {
        try {
          const name = this.bucket(size);
          const tx = db.transaction(name, 'readwrite');
          tx.objectStore(name).delete(key);
          tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
        } catch (_) { resolve(); }
      });
    }
  }

  class FileDisc {
    constructor(manifest, discUrl, fetcher, cache, digest, assetBaseUrl) {
      if (!manifest || manifest.version !== 1 || !/^[0-9a-f]{64}$/.test(manifest.image_sha256) ||
          !Number.isSafeInteger(manifest.image_size) || manifest.image_size <= 0 || !Array.isArray(manifest.extents))
        throw new Error('invalid disc manifest');
      let previousEnd = 0;
      const assetSizes = new Map();
      this.extents = manifest.extents.map(e => {
        const assetSize = e.asset_size === undefined ? e.size : e.asset_size;
        const assetOffset = e.asset_offset === undefined ? 0 : e.asset_offset;
        if (!Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.size) || e.size <= 0 ||
            e.offset < previousEnd || e.offset + e.size > manifest.image_size ||
            (e.zero !== true && (!Number.isSafeInteger(assetSize) || !Number.isSafeInteger(assetOffset) ||
              assetSize <= 0 || assetSize > MAX_FILE || assetOffset < 0 || assetOffset + e.size > assetSize ||
              !/^[0-9a-f]{64}$/.test(e.sha256) || e.url !== 'assets/' + e.sha256)))
          throw new Error('invalid file extent');
        if (e.zero !== true) {
          if (assetSizes.has(e.sha256) && assetSizes.get(e.sha256) !== assetSize)
            throw new Error('inconsistent asset size');
          assetSizes.set(e.sha256, assetSize);
        }
        previousEnd = e.offset + e.size;
        return {...e, asset_size: assetSize, asset_offset: assetOffset};
      });
      this.size = manifest.image_size;
      this.discUrl = discUrl;
      this.assetBaseUrl = assetBaseUrl || discUrl;
      this.fetcher = fetcher;
      this.cache = cache;
      this.digest = digest;
      this.inflight = new Map();
      this.activeDownloads = 0;
      this.downloadWaiters = [];
      this.hot = new Map();
      this.hotBytes = 0;
      this.stats = {assetRequests: 0, assetBytes: 0, cacheHits: 0, memoryHits: 0, isoRequests: 0, isoBytes: 0, zeroBytes: 0, fallbacks: 0};
    }
    async valid(data, e) {
      return data instanceof ArrayBuffer && data.byteLength === e.asset_size && hex(await this.digest(data)) === e.sha256;
    }
    async file(e) {
      const hot = this.hot.get(e.sha256);
      if (hot) {
        this.hot.delete(e.sha256);
        this.hot.set(e.sha256, hot);
        this.stats.memoryHits++;
        return hot;
      }
      if (this.inflight.has(e.sha256)) return this.inflight.get(e.sha256);
      const task = (async () => {
        let data = await this.cache.get(e.sha256, e.asset_size);
        if (data) {
          if (await this.valid(data, e)) { this.stats.cacheHits++; this.remember(e.sha256, data); return data; }
          await this.cache.remove(e.sha256, e.asset_size);
        }
        if (this.activeDownloads >= MAX_FILE_DOWNLOADS) {
          await new Promise(resolve => this.downloadWaiters.push(resolve));
        } else {
          this.activeDownloads++;
        }
        try {
          this.stats.assetRequests++;
          const response = await this.fetcher(new URL(e.url, this.assetBaseUrl).href);
          if (!response.ok) throw new Error('file HTTP ' + response.status);
          const declared = response.headers.get('Content-Length');
          if (declared !== null && Number(declared) !== e.asset_size) throw new Error('file length mismatch');
          if (!response.body || !response.body.getReader) throw new Error('stream unavailable');
          const reader = response.body.getReader();
          const output = new Uint8Array(e.asset_size);
          let received = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              this.stats.assetBytes += part.value.byteLength;
              if (received + part.value.byteLength > e.asset_size) throw new Error('file too large');
              output.set(part.value, received);
              received += part.value.byteLength;
            }
          } catch (error) {
            try { await reader.cancel(); } catch (_) {}
            throw error;
          }
          if (received !== e.asset_size) throw new Error('short file');
          data = output.buffer;
          if (!await this.valid(data, e)) throw new Error('file integrity mismatch');
          this.remember(e.sha256, data);
          await this.cache.put(e.sha256, data);
          return data;
        } finally {
          const next = this.downloadWaiters.shift();
          if (next) next();
          else this.activeDownloads--;
        }
      })();
      this.inflight.set(e.sha256, task);
      try { return await task; } finally { this.inflight.delete(e.sha256); }
    }
    remember(key, data) {
      if (this.hot.has(key)) {
        this.hotBytes -= this.hot.get(key).byteLength;
        this.hot.delete(key);
      }
      while (this.hotBytes + data.byteLength > MAX_HOT_BYTES && this.hot.size) {
        const oldest = this.hot.keys().next().value;
        this.hotBytes -= this.hot.get(oldest).byteLength;
        this.hot.delete(oldest);
      }
      if (data.byteLength <= MAX_HOT_BYTES) {
        this.hot.set(key, data);
        this.hotBytes += data.byteLength;
      }
    }
    async iso(start, end) {
      this.stats.isoRequests++;
      const response = await this.fetcher(this.discUrl, {headers: {Range: `bytes=${start}-${end - 1}`}});
      if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end - 1}/${this.size}`)
        throw new Error('invalid ISO range response');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== end - start) throw new Error('short ISO read');
      this.stats.isoBytes += bytes.byteLength;
      return new Uint8Array(bytes);
    }
    async read(start, end) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > this.size)
        throw new Error('invalid disc range');
      const out = new Uint8Array(end - start);
      let pos = start, low = 0, high = this.extents.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (this.extents[mid].offset + this.extents[mid].size <= pos) low = mid + 1;
        else high = mid;
      }
      let i = low;
      while (pos < end) {
        const e = this.extents[i];
        if (!e || pos < e.offset) {
          const stop = Math.min(end, e ? e.offset : end);
          out.set(await this.iso(pos, stop), pos - start); pos = stop;
        } else {
          const stop = Math.min(end, e.offset + e.size);
          if (e.zero === true) {
            this.stats.zeroBytes += stop - pos;
          } else {
            try {
              const data = await this.file(e);
              out.set(new Uint8Array(data, e.asset_offset + pos - e.offset, stop - pos), pos - start);
            } catch (_) {
              this.stats.fallbacks++;
              out.set(await this.iso(pos, stop), pos - start);
            }
          }
          pos = stop;
          if (pos === e.offset + e.size) i++;
        }
      }
      return out;
    }
  }

  async function install() {
    const params = new URL(root.location.href).searchParams;
    if (params.get('filedisc') !== '1') return;
    const fetcher = root.fetch.bind(root);
    const discUrl = new URL(params.get('disc') || 'disc.iso', root.location.href).href;
    const manifestUrl = new URL('file-disc-manifest.json', root.location.href).href;
    try {
      const [head, manifestResponse] = await Promise.all([
        fetcher(discUrl, {method: 'HEAD'}), fetcher(manifestUrl)
      ]);
      if (!head.ok || !manifestResponse.ok || !root.crypto || !root.crypto.subtle) throw new Error('identity or crypto unavailable');
      const manifest = await manifestResponse.json();
      if (head.headers.get('X-Disc-Sha256') !== manifest.image_sha256 || Number(head.headers.get('Content-Length')) !== manifest.image_size)
        throw new Error('disc identity mismatch');
      const reader = new FileDisc(manifest, discUrl, fetcher, new PersistentCache(), data => root.crypto.subtle.digest('SHA-256', data), manifestUrl);
      root.ps2FileDisc = reader;
      let previous = {...reader.stats};
      root.setInterval(() => {
        const current = {...reader.stats};
        const delta = Object.fromEntries(Object.keys(current).map(key => [key, current[key] - previous[key]]));
        previous = current;
        if (!Object.values(delta).some(value => value)) return;
        // The existing server accepts metrics only when explicitly configured.
        fetcher(new URL('/__file_disc_metrics', discUrl).href, {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify(delta)}).catch(() => {});
      }, 10000);
      root.fetch = function (input, init) {
        const url = typeof input === 'string' ? new URL(input, root.location.href).href : input instanceof URL ? input.href : input.url;
        const range = init && init.headers && new Headers(init.headers).get('Range');
        const match = range && /^bytes=(\d+)-(\d+)$/.exec(range);
        if (url !== discUrl || !match || (init && init.method && init.method.toUpperCase() !== 'GET')) return fetcher(input, init);
        const start = Number(match[1]), end = Number(match[2]) + 1;
        return reader.read(start, end).then(data => new Response(data, {status: 206, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength),
          'Content-Range': `bytes ${start}-${end - 1}/${reader.size}`
        }})).catch(() => fetcher(input, init));
      };
      if (params.get('filedisc_preload') === '1' && Array.isArray(manifest.preload)) {
        const wanted = new Set(manifest.preload);
        const preload = reader.extents.filter(e => !e.zero && wanted.has(e.sha256));
        const unique = [...new Map(preload.map(e => [e.sha256, e])).values()];
        const button = root.document.getElementById('start');
        if (button && unique.length) button.textContent = 'Preparing game…';
        await Promise.allSettled(unique.map(e => reader.file(e)));
      }
      console.info('[file-disc] enabled,', reader.extents.length, 'file extents');
    } catch (e) { console.warn('[file-disc] ISO fallback:', e.message); }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = {FileDisc, PersistentCache};
  if (root && root.document && root.location) {
    // Installation begins as soon as the script loads. The page waits for it
    // before starting emulation, so no first disc request can race the setup.
    root.ps2FileDiscReady = install();
  }
})(typeof window !== 'undefined' ? window : null);
