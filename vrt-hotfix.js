/**
 * VRT hotfix: make folder scanning and duration reads resilient.
 *
 * Fixes the case where only a few videos are counted from a folder because
 * the browser queues/blocks too many HTMLVideoElement metadata reads at once.
 */
(() => {
  'use strict';

  const HOTFIX_VERSION = 'vrt-hotfix-2026-06-24';
  if (window.__VRT_HOTFIX_VERSION__ === HOTFIX_VERSION) return;
  window.__VRT_HOTFIX_VERSION__ = HOTFIX_VERSION;

  const ELEMENT_CONCURRENCY = 2;
  const ELEMENT_TIMEOUT_MS = 30000;
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

    // Local files often have blank or generic MIME values, especially from
    // folder pickers. Attempt metadata extraction instead of silently skipping.
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

  const elementQueue = [];
  let activeElements = 0;

  function pumpElementQueue() {
    while (activeElements < ELEMENT_CONCURRENCY && elementQueue.length) {
      const task = elementQueue.shift();
      activeElements++;
      task.run()
        .then(task.resolve, task.reject)
        .finally(() => {
          activeElements--;
          pumpElementQueue();
        });
    }
  }

  function withElementSlot(run) {
    return new Promise((resolve, reject) => {
      elementQueue.push({ run, resolve, reject });
      pumpElementQueue();
    });
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

  async function getVideoDurationHotfix(file) {
    const ext = extOf(file);
    const mime = (file?.type || '').toLowerCase();

    if ((['mp4','m4v','mov','m4b','m4p'].includes(ext) || mime === 'video/mp4' || mime === 'video/quicktime') &&
        typeof window.parseDurationMP4 === 'function') {
      const duration = await window.parseDurationMP4(file);
      if (duration !== null && Number.isFinite(duration) && duration > 0) {
        return { duration, success: true };
      }
    }

    if ((['webm','mkv'].includes(ext) || mime === 'video/webm' || mime === 'video/x-matroska') &&
        typeof window.parseDurationWebM === 'function') {
      const duration = await window.parseDurationWebM(file);
      if (duration !== null && Number.isFinite(duration) && duration > 0) {
        return { duration, success: true };
      }
    }

    return withElementSlot(() => parseDurationElementHotfix(file));
  }

  window.shouldAttemptDuration = shouldAttemptDurationHotfix;
  window.collectFromHandle = collectFromHandleHotfix;
  window.readEntryRecursive = readEntryRecursiveHotfix;
  window.parseDurationElement = parseDurationElementHotfix;
  window.getVideoDuration = getVideoDurationHotfix;

  // Also rebind the global script function names used by existing event handlers.
  // Top-level function declarations are mutable global bindings in classic scripts.
  try { shouldAttemptDuration = shouldAttemptDurationHotfix; } catch (_) {}
  try { collectFromHandle = collectFromHandleHotfix; } catch (_) {}
  try { readEntryRecursive = readEntryRecursiveHotfix; } catch (_) {}
  try { parseDurationElement = parseDurationElementHotfix; } catch (_) {}
  try { getVideoDuration = getVideoDurationHotfix; } catch (_) {}
})();
