# 🎬 Video Runtime Tracker

> **Calculate the total runtime of any local video folder — 100% in-browser, no uploads, no server.**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-5b8af7.svg)
![No Server](https://img.shields.io/badge/Server-None-2ecc8a.svg)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-f5c842.svg)

---

## What It Does

VRT scans a local folder of video files and tells you the **total runtime** — instantly, privately, entirely in your browser. No files leave your machine. Ever.

Useful for video editors checking delivery reel lengths, archivists cataloguing footage, course creators calculating total watch time, or anyone who's ever opened 40 video files one-by-one to add up their lengths.

---

## Features

| Feature | Details |
|---|---|
| **Parallel scanning** | Processes 5 videos simultaneously — up to 5× faster on large folders |
| **Drag & drop** | Drop a folder directly onto the app |
| **File System API** | Persistent re-scan without re-selecting the folder (Chrome/Edge) |
| **Live ETA** | Shows estimated time remaining during long scans |
| **Cancellable** | Abort a scan mid-flight with one click |
| **File breakdown** | Collapsible per-file table, sortable by name or duration |
| **Export CSV** | Download a full breakdown as a `.csv` file |
| **Copy summary** | One-click plain-text copy for sharing or notes |
| **Scan history** | Saved to IndexedDB — persists across browser sessions |
| **Re-scan** | Re-analyze a saved folder in one click (File System API required) |
| **Individual delete** | Remove any history entry without clearing everything |
| **Dark mode** | Follows system preference automatically |
| **Installable PWA** | Install as a desktop/home screen app, works fully offline |
| **Zero dependencies** | Pure HTML, CSS, and vanilla JS — nothing to install |

---

## Quick Start

### Option A — Open directly (easiest)

1. Download or clone this repo
2. Open `index.html` in Chrome or Edge
3. Drop a video folder or click **Choose Folder**

> **Note:** For the File System API re-scan feature, open via a local server (see Option B), not directly as a `file://` URL. All other features work with `file://`.

### Option B — Local server (recommended for full features)

```bash
# Python 3
python -m http.server 8080

# Node (npx)
npx serve .

# VS Code — use the Live Server extension
```

Then open `http://localhost:8080`.

### Option C — GitHub Pages

Push this repo to GitHub and enable **Settings → Pages → Deploy from branch**. Your app will be live at `https://your-username.github.io/video-runtime-tracker/`.

---

## Browser Support

| Feature | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|
| Core scanning | ✅ | ✅ | ✅ | ✅ |
| Drag & drop folder | ✅ | ✅ | ✅ | ✅ |
| File System API (re-scan) | ✅ 86+ | ✅ 86+ | ❌ | ❌ |
| PWA install | ✅ | ✅ | ⚠️ limited | ⚠️ limited |
| Offline (Service Worker) | ✅ | ✅ | ✅ | ✅ |

Chrome or Edge is recommended for the full experience.

---

## File Structure

```
video-runtime-tracker/
├── index.html      # Main app — all UI, logic, and styles
├── worker.js       # Web Worker — IndexedDB operations (off main thread)
├── sw.js           # Service Worker — offline/PWA caching
├── manifest.json   # PWA manifest
├── icon.svg        # App icon (film reel + clock)
└── README.md
```

---

## Architecture

### Why a Web Worker?
All IndexedDB read/write operations are handled in `worker.js`, off the main thread. This keeps the UI responsive during history loads and saves, even with large scan histories.

### Why chunked parallel scanning?
The original approach processed one video at a time (`await` in a `for...of`). VRT processes 5 files in parallel using `Promise.all` over chunked batches, reducing scan time significantly on large folders.

### Why IndexedDB over localStorage?
`localStorage` is limited to ~5 MB and only stores strings. IndexedDB stores structured objects (including `FileSystemDirectoryHandle` for re-scan) with no practical size limit.

### Privacy
No network requests are made during scanning. Video files are read entirely in-browser via the [File API](https://developer.mozilla.org/en-US/docs/Web/API/File_API) and [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API). Nothing is transmitted, logged, or stored outside your device.

---

## Tech Stack

- **Vanilla JS (ES2022)** — no frameworks, no build step
- **File System Access API** — `showDirectoryPicker()` + persistent handles
- **Web Workers** — off-thread IndexedDB
- **IndexedDB** — structured persistent storage
- **Service Worker** — PWA offline caching
- **CSS Custom Properties** — dark/light theming

---

## Contributing

Issues and PRs welcome.

Possible improvements that haven't been tackled yet:
- Recursive subfolder toggle (currently always recursive)
- Multiple folder comparison view
- Timeline visualization of file durations
- Export to JSON

---

## License

MIT — do whatever you like with it.
