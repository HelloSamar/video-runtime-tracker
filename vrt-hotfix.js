/**
 * VRT hotfix v6: robust local-video discovery and duration extraction.
 *
 * The folder scanner may correctly find all video files, while Chrome still
 * fails metadata reads for many containers/codecs. This file adds lightweight
 * binary duration readers before falling back to HTMLVideoElement.
 */
(() => {
  'use strict';

  const HOTFIX_VERSION = 'vrt-hotfix-2026-06-24-v6';
  if (window.__VRT_HOTFIX_VERSION__ === HOTFIX_VERSION) return;
  window.__VRT_HOTFIX_VERSION__ = HOTFIX_VERSION;

  const TOTAL_CONCURRENCY = 4;
  const ELEMENT_CONCURRENCY = 1;
  const ELEMENT_TIMEOUT_MS = 45000;
  const MB = 1024 * 1024;
  const VIDEO_MIME = 'video/';
  const VIDEO_EXTS = new Set([
    '3g2','3gp','asf','avi','divx','dv','f4v','flv','m2ts','m4v','m4b','m4p',
    'mkv','mod','mov','mp4','mpe','mpeg','mpg','mts','mxf','ogm','ogv','rm',
    'rmvb','tod','ts','vob','webm','wm','wmv'
  ]);
  const DOCUMENT_EXTS = new Set([
    'pdf','txt','rtf','doc','docx','odt','pages','xls','xlsx','ods','csv',
    'ppt','pptx','odp','key','json','xml','html','htm','md','zip','rar','7z'
  ]);

  function extOf(file) {
    const name = (file?.name || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot === -1 || dot === name.length - 1 ? '' : name.slice(dot + 1);
  }

  function isKnownVideoFileHotfix(file) {
    const mime = (file?.type || '').toLowerCase();
    return mime.startsWith(VIDEO_MIME) || VIDEO_EXTS.has(extOf(file));
  }

  function shouldAttemptDurationHotfix(file) {
    const ext = extOf(file);
    const mime = (file?.type || '').toLowerCase();

    if (isKnownVideoFileHotfix(file)) return true;
    if (mime === 'application/pdf' || DOCUMENT_EXTS.has(ext)) return false;

    return !mime || mime === 'application/octet-stream' || mime.startsWith('application/');
  }

  async function collectFromHandleHotfix(dirHandle, discovery = null) {
    const files = [];
    for await (const [, entry] of dirHandle.entries()) {
      try {
        if (entry.kind === 'file') {
          const file = await entry.getFile();
          if (discovery) discovery.totalFiles++;
          if (shouldAttemptDurationHotfix(file)) files.push(file);
          else if (discovery) discovery.ignoredFiles++;
        } else if (entry.kind === 'directory') {
          files.push(...await collectFromHandleHotfix(entry, discovery));
        }
      } catch (_) {
        if (discovery) discovery.ignoredFiles++;
      }
    }
    return files;
  }

  function readEntryRecursiveHotfix(entry, discovery = null) {
    return new Promise(resolve => {
      if (!entry) { resolve([]); return; }

      if (entry.isFile) {
        entry.file(
          file => {
            if (discovery) discovery.totalFiles++;
            if (shouldAttemptDurationHotfix(file)) resolve([file]);
            else { if (discovery) discovery.ignoredFiles++; resolve([]); }
          },
          () => { if (discovery) discovery.ignoredFiles++; resolve([]); }
        );
        return;
      }

      if (!entry.isDirectory) { resolve([]); return; }

      const reader = entry.createReader();
      const entries = [];
      const readBatch = () => {
        reader.readEntries(async batch => {
          if (!batch.length) {
            const out = [];
            for (const child of entries) out.push(...await readEntryRecursiveHotfix(child, discovery));
            resolve(out);
          } else {
            entries.push(...batch);
            readBatch();
          }
        }, () => resolve([]));
      };
      readBatch();
    });
  }

  function createLimiter(max) {
    const queue = [];
    let active = 0;

    function pump() {
      while (active < max && queue.length) {
        const task = queue.shift();
        active++;
        task.run()
          .then(task.resolve, task.reject)
          .finally(() => { active--; pump(); });
      }
    }

    return run => new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      pump();
    });
  }

  const withDurationSlot = createLimiter(TOTAL_CONCURRENCY);
  const withElementSlot = createLimiter(ELEMENT_CONCURRENCY);

  function asciiAt(view, off, text) {
    if (off < 0 || off + text.length > view.byteLength) return false;
    for (let i = 0; i < text.length; i++) {
      if (view.getUint8(off + i) !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  function findAscii(view, text, start = 0) {
    const first = text.charCodeAt(0);
    for (let i = Math.max(0, start); i <= view.byteLength - text.length; i++) {
      if (view.getUint8(i) !== first) continue;
      if (asciiAt(view, i, text)) return i;
    }
    return -1;
  }

  function getUint64BE(view, off) {
    return view.getUint32(off) * 0x100000000 + view.getUint32(off + 4);
  }

  function getUint64LE(view, off) {
    return view.getUint32(off, true) + view.getUint32(off + 4, true) * 0x100000000;
  }

  async function readRange(file, start, length) {
    const safeStart = Math.max(0, Math.min(file.size, start));
    const safeEnd = Math.max(safeStart, Math.min(file.size, safeStart + length));
    return new DataView(await file.slice(safeStart, safeEnd).arrayBuffer());
  }

  function parseMvhdAt(view, typeOff) {
    const boxStart = typeOff - 4;
    if (boxStart < 0 || boxStart + 32 > view.byteLength) return null;

    const boxSize = view.getUint32(boxStart);
    if (boxSize < 32 && boxSize !== 1) return null;

    const version = view.getUint8(boxStart + 8);
    if (version === 0) {
      if (boxStart + 28 > view.byteLength) return null;
      const timescale = view.getUint32(boxStart + 20);
      const duration = view.getUint32(boxStart + 24);
      return timescale > 0 && duration > 0 ? duration / timescale : null;
    }

    if (version === 1) {
      if (boxStart + 40 > view.byteLength) return null;
      const timescale = view.getUint32(boxStart + 28);
      const duration = getUint64BE(view, boxStart + 32);
      return timescale > 0 && duration > 0 ? duration / timescale : null;
    }

    return null;
  }

  function scanMP4View(view) {
    let off = findAscii(view, 'mvhd');
    while (off !== -1) {
      const duration = parseMvhdAt(view, off);
      if (duration && Number.isFinite(duration) && duration > 0) return duration;
      off = findAscii(view, 'mvhd', off + 1);
    }
    return null;
  }

  async function parseDurationMP4Hotfix(file) {
    try {
      const ranges = [
        [0, Math.min(file.size, 8 * MB)],
        [Math.max(0, file.size - 64 * MB), Math.min(file.size, 64 * MB)],
      ];

      if (file.size <= 128 * MB) ranges.push([0, file.size]);

      for (const [start, length] of ranges) {
        const duration = scanMP4View(await readRange(file, start, length));
        if (duration) return duration;
      }
    } catch (_) {}
    return null;
  }

  function ebmlId(view, off) {
    if (off >= view.byteLength) return null;
    const b = view.getUint8(off);
    const w = b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 : 0;
    if (!w || off + w > view.byteLength) return null;
    let v = b;
    for (let i = 1; i < w; i++) v = (v << 8) | view.getUint8(off + i);
    return { v: v >>> 0, w };
  }

  function ebmlSize(view, off) {
    if (off >= view.byteLength) return null;
    const b = view.getUint8(off);
    const w = b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 :
              b & 0x08 ? 5 : b & 0x04 ? 6 : b & 0x02 ? 7 : b & 0x01 ? 8 : 0;
    if (!w || off + w > view.byteLength) return null;
    const mask = 0x80 >> (w - 1);
    let v = b ^ mask;
    for (let i = 1; i < w; i++) v = v * 256 + view.getUint8(off + i);
    if (w <= 4 && v === (1 << (7 * w)) - 1) return { v: -1, w };
    if (w > 4 && v > Number.MAX_SAFE_INTEGER / 2) return { v: -1, w };
    return { v, w };
  }

  function parseWebMInfo(view, off, end) {
    let timecodeScale = 1000000;
    let duration = null;

    while (off + 3 < end) {
      const id = ebmlId(view, off); if (!id) break;
      const size = ebmlSize(view, off + id.w); if (!size || size.v < 0) break;
      const data = off + id.w + size.w;
      if (data + size.v > view.byteLength) break;

      if (id.v === 0x2AD7B1 && size.v <= 8) {
        let v = 0;
        for (let i = 0; i < size.v; i++) v = v * 256 + view.getUint8(data + i);
        if (v > 0) timecodeScale = v;
      } else if (id.v === 0x4489) {
        if (size.v === 4) duration = view.getFloat32(data);
        else if (size.v === 8) duration = view.getFloat64(data);
      }
      off = data + size.v;
    }

    return duration !== null && duration > 0 ? (duration * timecodeScale) / 1e9 : null;
  }

  function scanWebMView(view) {
    let off = 0;
    while (off + 5 < view.byteLength) {
      const id = ebmlId(view, off); if (!id) break;
      const size = ebmlSize(view, off + id.w); if (!size) break;
      const data = off + id.w + size.w;
      const end = size.v >= 0 ? Math.min(data + size.v, view.byteLength) : view.byteLength;

      if (id.v === 0x1549A966) return parseWebMInfo(view, data, end);
      if (id.v === 0x1F43B675) break;

      off = size.v >= 0 ? data + size.v : data;
    }
    return null;
  }

  async function parseDurationWebMHotfix(file) {
    try {
      const view = await readRange(file, 0, Math.min(file.size, 8 * MB));
      if (view.byteLength < 4 || view.getUint32(0) !== 0x1A45DFA3) return null;

      let off = 0;
      while (off + 5 < view.byteLength) {
        const id = ebmlId(view, off); if (!id) break;
        const size = ebmlSize(view, off + id.w); if (!size) break;
        const data = off + id.w + size.w;

        if (id.v === 0x18538067) {
          const duration = scanWebMView(new DataView(view.buffer, data, view.byteLength - data));
          if (duration) return duration;
        }
        off = size.v >= 0 ? data + size.v : data;
      }
    } catch (_) {}
    return null;
  }

  function detectTSPacket(view) {
    const packetSizes = [188, 192, 204];
    for (const packetSize of packetSizes) {
      for (let start = 0; start < packetSize && start < view.byteLength; start++) {
        let hits = 0;
        for (let n = 0; n < 6; n++) {
          const pos = start + n * packetSize;
          if (pos < view.byteLength && view.getUint8(pos) === 0x47) hits++;
        }
        if (hits >= 5) return { packetSize, syncOffset: start };
      }
    }
    return null;
  }

  function pcrAt(view, packetStart) {
    if (packetStart + 12 > view.byteLength || view.getUint8(packetStart) !== 0x47) return null;
    const afc = (view.getUint8(packetStart + 3) >> 4) & 3;
    if (afc !== 2 && afc !== 3) return null;
    const afl = view.getUint8(packetStart + 4);
    if (afl < 7 || packetStart + 5 + afl > view.byteLength) return null;
    const flags = view.getUint8(packetStart + 5);
    if (!(flags & 0x10)) return null;

    const b0 = view.getUint8(packetStart + 6);
    const b1 = view.getUint8(packetStart + 7);
    const b2 = view.getUint8(packetStart + 8);
    const b3 = view.getUint8(packetStart + 9);
    const b4 = view.getUint8(packetStart + 10);
    return b0 * 0x2000000 + (b1 << 17) + (b2 << 9) + (b3 << 1) + (b4 >> 7);
  }

  function firstPCR(view, packetInfo) {
    for (let pos = packetInfo.syncOffset; pos + packetInfo.packetSize <= view.byteLength; pos += packetInfo.packetSize) {
      const pcr = pcrAt(view, pos);
      if (pcr !== null) return pcr;
    }
    return null;
  }

  function lastPCR(view, packetInfo) {
    const lastStart = packetInfo.syncOffset + Math.floor((view.byteLength - packetInfo.syncOffset - 1) / packetInfo.packetSize) * packetInfo.packetSize;
    for (let pos = lastStart; pos >= packetInfo.syncOffset; pos -= packetInfo.packetSize) {
      const pcr = pcrAt(view, pos);
      if (pcr !== null) return pcr;
    }
    return null;
  }

  async function parseDurationTSHotfix(file) {
    try {
      const head = await readRange(file, 0, Math.min(file.size, 8 * MB));
      const packetInfo = detectTSPacket(head);
      if (!packetInfo) return null;
      const first = firstPCR(head, packetInfo);
      if (first === null) return null;

      const tailStart = Math.max(0, file.size - 8 * MB);
      const tail = await readRange(file, tailStart, Math.min(file.size, 8 * MB));
      const tailInfo = detectTSPacket(tail) || packetInfo;
      let last = lastPCR(tail, tailInfo);
      if (last === null) return null;

      if (last < first) last += 0x200000000; // 33-bit PCR wraparound.
      const duration = (last - first) / 90000;
      return duration > 0 && Number.isFinite(duration) ? duration : null;
    } catch (_) {}
    return null;
  }

  async function parseDurationAVIHotfix(file) {
    try {
      const view = await readRange(file, 0, Math.min(file.size, 4 * MB));
      if (!asciiAt(view, 0, 'RIFF') || !asciiAt(view, 8, 'AVI ')) return null;
      const avih = findAscii(view, 'avih');
      if (avih < 8 || avih + 32 > view.byteLength) return null;
      const data = avih + 4;
      const microSecPerFrame = view.getUint32(data + 4, true);
      const totalFrames = view.getUint32(data + 20, true);
      const duration = microSecPerFrame > 0 && totalFrames > 0
        ? (microSecPerFrame * totalFrames) / 1000000
        : null;
      return duration && Number.isFinite(duration) ? duration : null;
    } catch (_) {}
    return null;
  }

  const ASF_FILE_PROPS_GUID = [0xA1,0xDC,0xAB,0x8C,0x47,0xA9,0xCF,0x11,0x8E,0xE4,0x00,0xC0,0x0C,0x20,0x53,0x65];

  function findBytes(view, bytes, start = 0) {
    for (let i = start; i <= view.byteLength - bytes.length; i++) {
      let ok = true;
      for (let j = 0; j < bytes.length; j++) {
        if (view.getUint8(i + j) !== bytes[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  async function parseDurationASFHotfix(file) {
    try {
      const view = await readRange(file, 0, Math.min(file.size, 2 * MB));
      const off = findBytes(view, ASF_FILE_PROPS_GUID);
      if (off < 0 || off + 88 > view.byteLength) return null;
      const playDuration100ns = getUint64LE(view, off + 64);
      const prerollMs = getUint64LE(view, off + 80);
      const duration = playDuration100ns / 10000000 - prerollMs / 1000;
      return duration > 0 && Number.isFinite(duration) ? duration : null;
    } catch (_) {}
    return null;
  }

  async function parseDurationFLVHotfix(file) {
    try {
      const view = await readRange(file, 0, Math.min(file.size, 2 * MB));
      if (!asciiAt(view, 0, 'FLV')) return null;
      let off = findAscii(view, 'duration');
      while (off !== -1) {
        for (let i = off + 8; i < Math.min(view.byteLength - 8, off + 24); i++) {
          if (view.getUint8(i) === 0x00) {
            const duration = view.getFloat64(i + 1, false);
            if (duration > 0 && Number.isFinite(duration)) return duration;
          }
        }
        off = findAscii(view, 'duration', off + 1);
      }
    } catch (_) {}
    return null;
  }

  function parseDurationElementHotfix(file) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      let settled = false;

      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      const done = (duration, success) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.onloadedmetadata = null;
        video.ondurationchange = null;
        video.onerror = null;
        video.removeAttribute('src');
        try { video.load(); } catch (_) {}
        URL.revokeObjectURL(url);
        resolve({ duration, success });
      };

      const readDuration = () => {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        if (duration > 0) done(duration, true);
      };

      const timer = setTimeout(() => done(0, false), ELEMENT_TIMEOUT_MS);
      video.onloadedmetadata = readDuration;
      video.ondurationchange = readDuration;
      video.onerror = () => done(0, false);
      video.src = url;
      video.load();
    });
  }

  async function getVideoDurationUnqueued(file) {
    const ext = extOf(file);
    const mime = (file?.type || '').toLowerCase();
    let duration = null;

    if (['mp4','m4v','mov','m4b','m4p','f4v','3gp','3g2'].includes(ext) || mime === 'video/mp4' || mime === 'video/quicktime') {
      duration = await parseDurationMP4Hotfix(file);
      if (duration) return { duration, success: true };
    }

    if (['webm','mkv'].includes(ext) || mime === 'video/webm' || mime === 'video/x-matroska') {
      duration = await parseDurationWebMHotfix(file);
      if (duration) return { duration, success: true };
    }

    if (['ts','mts','m2ts','tod','mod'].includes(ext)) {
      duration = await parseDurationTSHotfix(file);
      if (duration) return { duration, success: true };
    }

    if (['avi','divx'].includes(ext)) {
      duration = await parseDurationAVIHotfix(file);
      if (duration) return { duration, success: true };
    }

    if (['asf','wmv','wm'].includes(ext)) {
      duration = await parseDurationASFHotfix(file);
      if (duration) return { duration, success: true };
    }

    if (['flv'].includes(ext)) {
      duration = await parseDurationFLVHotfix(file);
      if (duration) return { duration, success: true };
    }

    return withElementSlot(() => parseDurationElementHotfix(file));
  }

  async function getVideoDurationHotfix(file) {
    return withDurationSlot(() => getVideoDurationUnqueued(file));
  }

  window.shouldAttemptDuration = shouldAttemptDurationHotfix;
  window.collectFromHandle = collectFromHandleHotfix;
  window.readEntryRecursive = readEntryRecursiveHotfix;
  window.parseDurationMP4 = parseDurationMP4Hotfix;
  window.parseDurationWebM = parseDurationWebMHotfix;
  window.parseDurationElement = parseDurationElementHotfix;
  window.getVideoDuration = getVideoDurationHotfix;

  try { shouldAttemptDuration = shouldAttemptDurationHotfix; } catch (_) {}
  try { collectFromHandle = collectFromHandleHotfix; } catch (_) {}
  try { readEntryRecursive = readEntryRecursiveHotfix; } catch (_) {}
  try { parseDurationMP4 = parseDurationMP4Hotfix; } catch (_) {}
  try { parseDurationWebM = parseDurationWebMHotfix; } catch (_) {}
  try { parseDurationElement = parseDurationElementHotfix; } catch (_) {}
  try { getVideoDuration = getVideoDurationHotfix; } catch (_) {}
})();
