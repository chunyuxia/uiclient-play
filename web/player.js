// Browser side of the UI client stream (served by `uiclient.py stream serve`).
//
// Layers: <video> = the game's world layer (WebRTC), <canvas> = the UI client (Unity WebGL build), on top and
// transparent. Every video frame carries a tag band below the world image with the game's frame number
// (see WorldStream.cs); the UI state for that frame is pushed to the client just before the frame is shown.
//
// ?remote=1: remote play for agents and tests (`uiclient.py stream play/do/view`): the page posts what it shows
// (world video + UI) every second and plays input steps queued on the server through the input channel.
// Modes: live (default) = video + UI from the game; ?mode=replay = UI only, from a recorded session
// (`stream serve --replay <session folder>`); ?ui=0 = video only; ?bench=<seconds> = measure, then POST the
// results to /api/report (`uiclient.py stream bench` runs this in a headless browser).
"use strict";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const stats = { tagOk: 0, tagBad: 0, lastFrame: -1, frameGaps: 0, videoFrames: 0, pushed: 0, applied: 0, events: 0 };
let info = null, unity = null, W = 1280, H = 720, BAND = 16;

// Called once per presented video frame: requestVideoFrameCallback where it works, otherwise once per animation
// frame with duplicates (same tag as last time) skipped. Some embedded browsers never fire the video callback.
const frameListeners = [];
function onVideoFrame(fn) { frameListeners.push(fn); }

function log(msg) {
  const el = $("log");
  el.textContent += new Date().toISOString().substr(11, 12) + "  " + msg + "\n";
  el.scrollTop = el.scrollHeight;
}

// errors of the client (Unity prints exceptions through console.error) also go to the page log and reports
const recentErrors = [];
{ // Unity also reports shader and rendering problems through console.log ("ERROR: Shader ...")
  const orig = console.log.bind(console);
  console.log = (...a) => {
    orig(...a);
    try {
      const msg = a.map(String).join(" ");
      if (/shader|ERROR|not supported/i.test(msg)) {
        log("console: " + msg.slice(0, 600));
        recentErrors.push(msg.slice(0, 400)); if (recentErrors.length > 8) recentErrors.shift();
      }
    } catch (_) { /* ignore */ }
  };
}
for (const level of ["error", "warn"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    orig(...a);
    try {
      const msg = a.map(String).join(" ");
      log(level + ": " + msg.slice(0, 600));
      if (level === "error") { recentErrors.push(msg.slice(0, 400)); if (recentErrors.length > 4) recentErrors.shift(); }
    } catch (_) { /* ignore */ }
  };
}
window.addEventListener("error", (e) => log("page error: " + e.message));

// ------------------------------------------------------------------------------------------ layout
function layout() {
  const fit = $("fit"), stage = $("stage");
  // the picture fits the window; desktop pages keep room for the panel below, touch devices and full screen use it all
  const full = document.fullscreenElement === fit;
  const room = full ? window.innerHeight : matchMedia("(pointer: coarse)").matches ? window.innerHeight - fit.getBoundingClientRect().top - 8
                                                                                 : window.innerHeight - 190;
  const scale = params.get("fit") === "0" ? 1 : Math.min(fit.clientWidth / W, Math.max(room, 120) / H);
  stage.style.width = W + "px"; stage.style.height = H + "px";
  stage.style.transform = "scale(" + scale + ")";
  stage.style.left = full ? Math.max(0, (fit.clientWidth - W * scale) / 2) + "px" : "0px";
  stage.style.top = full ? Math.max(0, (window.innerHeight - H * scale) / 2) + "px" : "0px";
  fit.style.height = full ? "100%" : H * scale + "px";
  const v = $("video");
  // the video may be smaller than the game (stream size cap): its image is stretched over W x H and the tag band,
  // scaled alike, falls outside the stage and is clipped
  const band = v.videoHeight > BAND ? H * BAND / (v.videoHeight - BAND) : BAND;
  v.width = W; v.height = Math.round(H + band);
  v.style.width = W + "px"; v.style.height = (H + band) + "px";
  v.style.objectFit = "fill";
  // Unity sizes its drawing buffer as (on-screen canvas size x devicePixelRatio); the stage is scaled to fit the
  // window, so the ratio compensates to keep the buffer at exactly the game's resolution (slightly above, so that
  // rounding or truncation both land on W x H)
  const c = $("unity");
  c.style.width = W + "px"; c.style.height = H + "px";
  const shown = c.getBoundingClientRect().width;
  unityPixelRatio = shown > 0 ? (W + 0.25) / shown : 1;
  if (unity && unity.Module) unity.Module.devicePixelRatio = unityPixelRatio;
}
let unityPixelRatio = 1;
window.addEventListener("resize", layout);
document.addEventListener("DOMContentLoaded", () => $("video").addEventListener("resize", layout));   // video size known or changed

// ------------------------------------------------------------------------------------------ UI client
// ------------------------------------------------------------------------------------------ page info
// Served by the stream server: /api/info. Hosted as static files (e.g. GitHub Pages, see `stream publish`):
// games/<game>/manifest.json, chosen with ?game=; signaling then always goes through the relay.
async function loadInfo() {
  if (!params.get("game") || params.get("api") === "1") {
    try {
      const r = await fetch("/api/info" + (params.get("build") ? "?build=" + encodeURIComponent(params.get("build")) : ""));
      if (r.ok) return await r.json();
    } catch (_) { /* no stream server: static hosting */ }
  }
  const game = params.get("game");
  if (!game) throw new Error("no stream server here: open the link with ?game=<game>&code=...&key=...");
  const base = "games/" + encodeURIComponent(game) + "/";
  const m = await (await fetch(base + "manifest.json", { cache: "no-cache" })).json();
  m.static = true;
  m.base = base;
  return m;
}

// A client file stored in parts (static hosts limit file sizes): the parts are streamed in order, through the
// gzip unpacker when packed, into one blob for the Unity loader. Only one part is held at a time (a failed part
// is fetched again before any of it is passed on), so the page never keeps several copies of the client in
// memory: phones (iPhone Safari above all) close tabs that use too much. Progress covers all parts of all files.
const partProgress = { total: 0, done: 0 };
// the published client's version (stream publish): cached files of an older version are never used
const versioned = (url) => info && info.version && !url.startsWith("blob:") ? url + (url.includes("?") ? "&" : "?") + "v=" + info.version : url;
async function fetchPart(url) {
  // a dropped connection (mobile data, flaky networks) retries the part, up to 5 times
  for (let attempt = 1; ; attempt++) {
    const got = [];
    let n = 0;
    try {
      const r = await fetch(versioned(url), { cache: attempt > 1 ? "reload" : "default" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got.push(value);
        n += value.length;
        setStatus("Downloading the game client: " + Math.round(100 * (partProgress.done + n) / Math.max(1, partProgress.total)) + "%");
      }
      partProgress.done += n;
      return got;
    } catch (e) {
      report("download-retry", { part: url.split("/").pop(), attempt, error: String(e && e.message || e).slice(0, 200) });
      if (attempt >= 5) throw new Error(url.split("/").pop() + ": " + (e && e.message || e));
      setStatus("Download interrupted; retrying (" + attempt + ")...");
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
async function joinedUrl(entry, type) {
  if (typeof entry === "string") return entry;
  const t0 = performance.now();
  let i = 0;
  const source = new ReadableStream({
    async pull(ctrl) {
      if (i >= entry.parts.length) { ctrl.close(); return; }
      for (const chunk of await fetchPart(info.base + entry.parts[i++])) ctrl.enqueue(chunk);
    },
  });
  const stream = entry.gzip ? source.pipeThrough(new DecompressionStream("gzip")) : source;
  const blob = await new Response(stream, { headers: { "Content-Type": type } }).blob();
  report("download-done", { file: entry.parts[0].split("/").pop().replace(/\.part\d+$/, ""), mb: Math.round(entry.size / 1048576),
                            unpackedMB: Math.round(blob.size / 1048576), ms: Math.round(performance.now() - t0) });
  return URL.createObjectURL(blob);
}

// ------------------------------------------------------------------------------------------ view toggle
// What the viewer sees; the game, the stream and lockstep are unchanged in every view.
//   full:  the world video from the game machine with the UI drawn by the local client on top
//   world: the world video alone (the client's canvas is hidden)
//   ui:    the local client alone; it draws the world video itself, so it is handed a black frame of the same size
let view = params.get("view") || "full";
const VIEW_NOTES = {
  full: "World rendered and encoded on the game machine, streamed as video; UI rebuilt and drawn by the client in this browser.",
  world: "Only the streamed video: the game's world without any UI (the UI is never in the video).",
  ui: "Only the client in this browser: the game's UI rebuilt from the state stream, over black.",
};
let blackFrame = null;
function videoForClient() {
  const v = $("video");
  if (view !== "ui" || !v.videoWidth) return v;
  if (!blackFrame || blackFrame.width !== v.videoWidth || blackFrame.height !== v.videoHeight) {
    blackFrame = document.createElement("canvas");
    blackFrame.width = v.videoWidth; blackFrame.height = v.videoHeight;
    const x = blackFrame.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, blackFrame.width, blackFrame.height);
    // the client's upload reads these like a <video> element's
    Object.defineProperties(blackFrame, { videoWidth: { get: () => blackFrame.width }, videoHeight: { get: () => blackFrame.height }, readyState: { value: 4 } });
  }
  return blackFrame;
}
function applyView() {
  const v = $("video"), c = $("unity");
  for (const b of document.querySelectorAll("#view button[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  $("view-note").textContent = VIEW_NOTES[view] || "";
  c.style.visibility = view === "world" ? "hidden" : "visible";
  // with the client compositing, the <video> is only visible in the world view; with page compositing it is the
  // world layer under the transparent client canvas, hidden in the UI view
  v.style.opacity = videoInClient ? (view === "world" ? "1" : "0") : (view === "ui" ? "0" : "1");
}
document.addEventListener("DOMContentLoaded", () => {
  for (const b of document.querySelectorAll("#view button[data-view]"))
    b.addEventListener("click", () => { view = b.dataset.view; applyView(); $("input").focus(); });
  applyView();
  // full screen (phones: also landscape where the browser allows locking it)
  $("fs").addEventListener("click", async () => {
    const fit = $("fit");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await (fit.requestFullscreen || fit.webkitRequestFullscreen).call(fit);
        try { await screen.orientation.lock("landscape"); } catch (_) { /* not supported (desktop, iOS) */ }
      }
    } catch (e) { log("full screen: " + e.message); }
  });
  document.addEventListener("fullscreenchange", () => setTimeout(layout, 50));
});

window.uiOnlyWeb = {
  video: videoForClient,
  onEmit(channel, json) {
    if (channel === "applied") {
      stats.applied++;
      if (bench.on) {
        const a = JSON.parse(json);
        bench.applied.push({ t: performance.now(), src: a.srcFrame, ms: a.applyMs });
      }
    }
    else if (channel === "event") { stats.events++; log("client " + json.substr(0, (json.startsWith('{"k":"web-render"') || json.startsWith('{"k":"web-frame"')) ? 8000 : 200)); }
    else if (channel === "probe") {   // diagnostics: the client's own rendered frame (remote play saves it)
      const bin = atob(json), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      fetch("/api/view?layer=probe", { method: "POST", body: bytes }).catch(() => {});
    }
    else if (channel === "capture") { const c = JSON.parse(json); readFrame(c); captures.push(c.seq); captureWaiters.get(c.seq)?.(c); }
    else log("client " + channel + " " + json.substr(0, 200));
  },
  onResize(w, h) {
    if (params.get("legacysize") === "1") { const c = $("unity"); c.width = w; c.height = h; }
    W = w; H = h; layout();
    log("client resolution " + w + "x" + h);
  },
};

let videoInClient = false;   // live mode with the UI client: the client composites video and UI
const early = [];   // messages that arrive while the client is still loading (the preamble usually does)
function push(json) {
  if (!unity) { early.push(json); return; }   // everything, in order: states are deltas of each other
  unity.SendMessage("__UiOnlyWebFeed", "Push", json);
  stats.pushed++;
}

function loadScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = fail; document.body.appendChild(s); });
}

async function startClient() {
  phase = "loading client";
  if (!info.client) { log("no browser client build (run: uiclient.py stream build " + info.game + " --client)"); return; }
  const c = $("unity");
  c.width = W; c.height = H; c.style.width = W + "px"; c.style.height = H + "px";
  let files = info.client;
  if (info.static) {
    // static hosting: file paths are relative to the game's folder; large files come in parts
    const rel = (x) => typeof x === "string" ? info.base + x : x;
    partProgress.total = ["data", "code", "framework"].reduce((n, k) => n + (typeof files[k] === "object" ? files[k].size : 0), 0);
    files = { loader: versioned(rel(files.loader)), framework: versioned(rel(files.framework)),
              code: await joinedUrl(rel(files.code), "application/wasm"), data: await joinedUrl(rel(files.data), "application/octet-stream") };
  }
  await loadScript(files.loader);
  unity = await createUnityInstance(c, {
    dataUrl: files.data, frameworkUrl: files.framework, codeUrl: files.code,
    companyName: "uiclient", productName: info.product + " UI client", productVersion: "1",
    devicePixelRatio: params.get("legacysize") === "1" ? 1 : unityPixelRatio, matchWebGLToCanvasSize: params.get("legacysize") !== "1",
    webglContextAttributes: { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: params.get("capture") === "1" || params.get("remote") === "1" },
    keyboardListeningElement: c,   // not window: keys are for the game, never for the mirror client
  }, (p) => {
    $("panel").dataset.loading = Math.round(p * 100);
    if (p >= 0.9 && !startClient.reported90) { startClient.reported90 = true; report("client-90", { ms: Math.round(performance.now() - pageT0) }); }
    if (params.get("mode") !== "replay") setStatus(p < 1 ? "Loading the game client: " + Math.round(p * 100) + "%" : "");
  });
  if (pcRef && pcRef.iceConnectionState !== "connected" && pcRef.iceConnectionState !== "completed") setStatus("Connecting to the game...");
  report("client-loaded", { ms: Math.round(performance.now() - pageT0) });
  phase = "client loaded";
  log("UI client loaded" + (early.length ? "; " + early.length + " early messages delivered" : ""));
  // without the video layer the client still gets its camera safety settings
  const diag = params.get("diag") === "1" ? ',"diag":true' : "";   // ?diag=1: render reports + frame probes every 5 s
  if (!videoInClient) push('{"k":"web-video","on":false' + diag + "}");
  if (videoInClient) {
    // live: the client draws the world video itself, under the UI; the <video> element keeps decoding, unseen
    push('{"k":"web-video","on":true,"band":' + BAND + diag + "}");
    applyView();
  }
  for (const m of early.splice(0)) push(m);
}

// ------------------------------------------------------------------------------------------ replay (offline)
async function fetchLines(url, gz) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " " + r.status);
  let body = r.body;
  if (gz) body = body.pipeThrough(new DecompressionStream("gzip"));
  const text = body.pipeThrough(new TextDecoderStream());
  const reader = text.getReader();
  let buf = "";
  return {
    async next() {
      for (;;) {
        const i = buf.indexOf("\n");
        if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.length) return l; continue; }
        const { value, done } = await reader.read();
        if (done) { const l = buf; buf = ""; return l.length ? l : null; }
        buf += value;
      }
    },
  };
}

function head(line) {
  const seq = /"seq":(\d+)/.exec(line), t = /"t":([0-9.eE+-]+)/.exec(line);
  return { seq: seq ? +seq[1] : 0, t: t ? +t[1] : 0 };
}

async function inlineBlob(asset) {
  const d = JSON.parse(asset);
  if (!d.blob || d.blobB64) return asset;
  const r = await fetch("/session/" + d.blob);
  if (!r.ok) { log("missing blob " + d.blob); return asset; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  d.blobB64 = btoa(s);
  return JSON.stringify(d);
}

// ?capture=1 (validation, `uiclient.py stream check`): every snapshot is applied in its own frame (as the desktop
// replay-capture run does); at each snapshot the game captured, the client sends its frame and measurements,
// which the server saves in the desktop client's layout for compare.py.
const captures = [], captureWaiters = new Map();
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function webglRenderer() {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { return null; }
}

// The drawing buffer exactly as Unity rendered it, read in the same task as the client's capture event (end of
// the captured frame; the buffer is kept with preserveDrawingBuffer in capture mode): RGBA, bottom row first,
// without browser compositing or unpremultiplying. Games whose player renders into an offscreen buffer that is
// presented later read black here (see docs/STREAMING.md).
function readFrame(c) {
  const canvas = $("unity"), gl = canvas.getContext("webgl2");
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
  let s = ""; for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
  c.rgba = btoa(s); c.w = w; c.h = h;
}

async function captureAt(seq, line) {
  const got = new Promise((ok) => { captureWaiters.set(seq, ok); setTimeout(() => ok(null), 30000); });
  push(line);
  const c = await got;
  captureWaiters.delete(seq);
  if (!c) { log("capture " + seq + ": no frame from the client"); return false; }
  await fetch("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
  return true;
}

async function runReplay() {
  phase = "replay";
  const capture = params.get("capture") === "1";
  const hello = await (await fetch("/session/session.json")).text();
  if (capture) push('{"k":"web-capture","on":true}');
  push(hello);
  const assets = [];
  const al = await fetchLines("/session/assets.jsonl", false);
  for (let l; (l = await al.next()) !== null;) assets.push({ seq: head(l).seq, line: l });
  assets.sort((a, b) => a.seq - b.seq);
  log("replay: " + assets.length + " runtime assets");
  const snaps = await fetchLines("/session/snapshots.jsonl.gz", true);
  let t0src = -1, t0 = 0, ai = 0, n = 0;
  let captured = 0, missed = 0;
  for (let l; (l = await snaps.next()) !== null;) {
    const h = head(l);
    while (ai < assets.length && assets[ai].seq <= h.seq) push(await inlineBlob(assets[ai++].line));
    if (capture) {
      if (l.includes('"cap":true')) { if (await captureAt(h.seq, l)) captured++; else missed++; }
      else { push(l); await nextFrame(); }
    } else {
      if (t0src < 0) { t0src = h.t; t0 = performance.now(); }
      const wait = (h.t - t0src) * 1000 - (performance.now() - t0);
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      push(l);
    }
    n++;
  }
  log("replay finished: " + n + " snapshots" + (capture ? ", " + captured + " captured, " + missed + " missed" : ""));
  if (capture)
    await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "replay-capture", summary: { snapshots: n, captured, missed, webgl: webglRenderer(), userAgent: navigator.userAgent },
                             pageLog: $("log").textContent.slice(-20000) }) });
}

// ------------------------------------------------------------------------------------------ live UI state
// UI states arrive in order: keyframes ("snap") and deltas ("delta") against the previous state. None may be
// skipped, so they are queued in arrival order; on every shown video frame, every queued state up to that frame is
// pushed (lockstep: the client then holds the state of exactly the frame on screen). A keyframe makes the states
// before it unnecessary. ?sync=latest pushes each state as soon as it arrives (lower UI latency; UI may lead).
const syncMode = params.get("sync") || "lockstep";
const stateQueue = [];   // {f, text, key}
let pushedFrame = -1, newestFrame = -1;
const parts = new Map();

function onUiMessage(text) {
  if (text.charCodeAt(0) === 35) {                     // "#id/i/n\n" chunk of a long message
    const nl = text.indexOf("\n"), [id, i, n] = text.slice(1, nl).split("/").map(Number);
    let p = parts.get(id); if (!p) parts.set(id, (p = []));
    p[i] = text.slice(nl + 1);
    if (p.filter((x) => x !== undefined).length < n) return;
    parts.delete(id);
    text = p.join("");
  }
  stats.uiMessages = (stats.uiMessages || 0) + 1;
  const key = text.startsWith('{"k":"snap"');
  if (!key && !text.startsWith('{"k":"delta"')) { push(text); return; }   // hello, assets, material states: in order, now
  const m = /"frame":(\d+)/.exec(text);
  const f = m ? +m[1] : 0;
  newestFrame = Math.max(newestFrame, f);
  stats.uiStateChars = (stats.uiStateChars || 0) + text.length;
  if (key) stats.uiKeyframes = (stats.uiKeyframes || 0) + 1;
  if (syncMode === "latest") { push(text); pushedFrame = f; return; }
  stateQueue.push({ f, text, key });
}

onVideoFrame((f) => {
  if (syncMode !== "lockstep" || !stateQueue.length) return;
  let n = 0;
  while (n < stateQueue.length && stateQueue[n].f <= f) n++;
  if (!n) { if (pushedFrame < 0) stats.uiAhead = (stats.uiAhead || 0) + 1; return; }   // no state for this frame yet
  let from = 0;
  for (let i = n - 1; i >= 0; i--) if (stateQueue[i].key) { from = i; break; }     // newest keyframe up to f
  for (let i = from; i < n; i++) push(stateQueue[i].text);
  pushedFrame = stateQueue[n - 1].f;
  stateQueue.splice(0, n);
  stats.uiLagFrames = f - pushedFrame;
});

// One connection attempt: a new peer connection, offer, answer (through the relay when the page is remote, else
// through the page's own server). The data channels are new each time; input and frame watching are bound once.
async function connectOnce() {
  const pc = new RTCPeerConnection({ iceServers: (info && info.ice) || [] });
  try { return await connectWith(pc); }
  catch (e) { try { pc.close(); } catch (_) { /* already closed */ } throw e; }   // browsers limit open connections
}

async function connectWith(pc) {
  pc.addTransceiver("video", { direction: "recvonly" });
  if (params.get("input") !== "0") setupInput(pc.createDataChannel("input", { ordered: true }));
  if (params.get("ui") !== "0") {
    const ui = pc.createDataChannel("ui", { ordered: true });
    ui.onopen = () => log("UI channel open");
    ui.onmessage = (e) => onUiMessage(e.data);
  }
  pc.ontrack = (e) => {
    $("video").srcObject = e.streams[0] || new MediaStream([e.track]);
    // play frames as soon as they can be decoded: on mobile networks the browser otherwise grows its playout
    // buffer with the network's jitter (hundreds of ms). ?jitterms=N sets another target (ms).
    const target = params.get("jitterms") !== null ? +params.get("jitterms") : 0;
    try { if ("jitterBufferTarget" in e.receiver) e.receiver.jitterBufferTarget = target; else e.receiver.playoutDelayHint = target / 1000; } catch (_) { /* not supported */ }
    log("video track");
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((ok) => {
    if (pc.iceGatheringState === "complete") return ok();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && ok();
    setTimeout(ok, 4000);
  });
  // ?nohost=1 (test): no local-network candidates on either side, so the connection must use public addresses
  // (STUN) or a TURN relay, as between a phone on mobile data and the game machine
  const noHost = params.get("nohost") === "1";
  const dropHost = (x) => noHost ? x.split("\r\n").filter((l) => !/^a=candidate:.* typ host/.test(l)).join("\r\n") : x;
  const sdp = dropHost(pc.localDescription.sdp);
  const answer = dropHost(signalUrl() ? await relayOffer(sdp) : await localOffer(sdp));
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  const kinds = (sdp.match(/typ (host|srflx|relay)/g) || []).map((x) => x.slice(4));
  log("signaling done (" + (signalUrl() ? "relay" : "local") + "; candidates offered: " + [...new Set(kinds)].join(", ") + ")");
  return pc;
}

async function localOffer(sdp) {
  // the game may still be starting (its signaling not up yet: 502): retry for up to a minute
  for (let tries = 0; ; tries++) {
    const r = await fetch("/offer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp }) });
    const ans = await r.json();
    if (r.ok) return ans.sdp;
    if (r.status !== 502 || tries >= 150) throw new Error("offer failed: " + (ans.error || r.status));
    setStatus(tries < 3 ? "Waiting for the game to start..." : "The game is not running on the game machine. Waiting for it to start again...");
    await new Promise((ok) => setTimeout(ok, 2000));
  }
}

// ---- relay signaling (message format: python/remote.py)
const APP = "uiclient-stream";
const pageId = "page-" + Math.random().toString(36).slice(2, 10);
let relay = null;
const relayWaiters = [];
function signalUrl() { return params.get("signal") || (info && info.signal) || ""; }
function hostId() { return "host-" + (params.get("code") || (info && info.code) || ""); }
function relaySocket() {
  if (relay && relay.readyState <= 1) return relay;
  relay = new WebSocket(signalUrl());
  relay.onmessage = async (e) => {
    let m;
    try { m = JSON.parse(typeof e.data === "string" ? e.data : await e.data.text()); } catch (_) { return; }
    if (!m || m.app !== APP || m.to !== pageId) return;
    for (const w of relayWaiters.slice())
      if (w.type === m.type || m.type === "error") { relayWaiters.splice(relayWaiters.indexOf(w), 1); w.done(m); }
  };
  relay.onclose = () => log("relay connection closed");
  return relay;
}
function relaySend(msg) {
  const ws = relaySocket();
  const text = JSON.stringify(Object.assign({ app: APP, v: 1, from: pageId, to: hostId() }, msg));
  if (ws.readyState === 1) ws.send(text); else ws.addEventListener("open", () => ws.send(text), { once: true });
}
function relayWait(type, ms) {
  return new Promise((done, fail) => {
    const w = { type, done };
    relayWaiters.push(w);
    setTimeout(() => {
      const i = relayWaiters.indexOf(w);
      if (i >= 0) { relayWaiters.splice(i, 1); fail(new Error("no " + type + " from the game")); }
    }, ms);
  });
}
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function findGame() {
  // the relay (a sleeping free server) or the game machine may still be waking up
  for (let i = 0; ; i++) {
    setStatus(i ? "Looking for the game (code " + hostId().slice(5) + ")..." : "Connecting...");
    relaySend({ type: "hello" });
    try {
      const m = await relayWait("here", 3000);
      if (m.running === false) {
        setStatus("The game is not running on the game machine. Waiting for it to start again...");
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return m;
    } catch (e) { if (i >= 40) throw new Error("the game did not answer on the relay (is it running? is the code right?)"); }
  }
}

async function relayOffer(sdp) {
  const here = await findGame();
  log("game found: " + (here.game || "?"));
  setStatus("Connecting to the game...");
  relaySend({ type: "offer", sdp, mac: await hmacHex(params.get("key") || "", sdp) });
  const m = await relayWait("answer", 30000);
  if (m.type === "error") throw new Error(m.error);
  return m.sdp;
}

// ---- supervision: reconnect after failures and network changes (e.g. cell handovers, Wi-Fi <-> mobile data)
let videoStarted = false;
async function startVideo() {
  let delay = 1000;
  for (;;) {
    let pc = null;
    try {
      const tc = performance.now();
      pc = await connectOnce();
      pcRef = pc;
      report("connected", { ms: Math.round(performance.now() - tc), attempt: delay }); 
      stateQueue.length = 0; pushedFrame = -1; parts.clear();   // the new UI channel starts with a keyframe
      if (!videoStarted) { videoStarted = true; watchFrames(); }
      setStatus("");
      const connectedAt = performance.now();
      await new Promise((lost) => {
        let timer = null;
        const check = () => {
          const st = pc.iceConnectionState;
          if (st === "failed" || st === "closed") { report("lost", { why: "ice-" + st }); return lost(); }
          if (st === "disconnected") {
            if (!timer) { report("unstable"); timer = setTimeout(() => { report("lost", { why: "disconnected-4s" }); lost(); }, 4000); }
            setStatus("Connection unstable...");
          }
          else { clearTimeout(timer); timer = null; if (st === "connected" || st === "completed") setStatus(""); }
        };
        pc.oniceconnectionstatechange = () => { log("ICE " + pc.iceConnectionState); check(); };
        check();
        // also polled: some ends fire no event (a closed connection, a phone waking from sleep)
        const poll = setInterval(() => { if (pcRef !== pc) clearInterval(poll); else check(); }, 1000);
        window.addEventListener("online", () => { report("lost", { why: "network-changed" }); setTimeout(lost, 500); }, { once: true });
      });
      if (performance.now() - connectedAt > 30000) delay = 1000;
      log("connection lost; reconnecting");
    } catch (e) {
      log("connect: " + (e && e.message || e));
      report("connect-failed", { error: String(e && e.message || e).slice(0, 300) });
    }
    try { if (pc) pc.close(); } catch (_) { /* already closed */ }
    setStatus("Reconnecting...");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 10000);
  }
}

// Page events for the server's session folder (page-events.jsonl): loads, connections, drops and why, the
// network path, memory and errors, so a session on a phone can be diagnosed afterwards. Live mode only.
const pageT0 = performance.now();
const pageEvents = [];
function report(kind, data) {
  try { reportNow(kind, data); } catch (_) { /* never let diagnostics break the page */ }
}
function reportNow(kind, data) {
  if ((params.get("mode") || (info && info.replay ? "replay" : "live")) !== "live") return;
  const c = navigator.connection || {};
  pageEvents.push(Object.assign({ k: kind, page: pageId, t: Math.round(performance.now() - pageT0), wall: new Date().toISOString(),
                                  net: c.type || c.effectiveType || undefined, path: rtp.path, rttMs: rtp.rttMs,
                                  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined }, data || {}));
  if (pageEvents.length === 1) setTimeout(flushEvents, 1000);
}
function flushEvents() {
  if (!pageEvents.length) return;
  if (info && info.static) {
    // no server behind the page: through the relay to the game machine, once it accepted this page's offer
    if (!pcRef) return;
    relaySend({ type: "events", events: pageEvents.splice(0, 200) });
    return;
  }
  const batch = pageEvents.splice(0);
  fetch("/api/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch), keepalive: true })
    .catch(() => pageEvents.unshift(...batch));   // offline: kept for the next attempt
}
setInterval(flushEvents, 5000);
addEventListener("pagehide", () => { report("page-hide"); flushEvents(); });
addEventListener("error", (e) => report("error", { message: String(e.message).slice(0, 300) }));
document.addEventListener("visibilitychange", () => report(document.hidden ? "hidden" : "visible"));

function setStatus(text) {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "flex" : "none";
}

// ------------------------------------------------------------------------------------------ input
// Pointer and keyboard on the input layer go to the game (InputInjector.cs); coordinates are 0..1 of the game view,
// top-left origin. Each event carries the game frame on screen, so the server log pairs input with what was seen.
let sendInput = () => {};
let inputChannel = null, inputBound = false;
const pendingTaps = [];
onVideoFrame((f) => {
  for (let i = pendingTaps.length - 1; i >= 0; i--) {
    const p = pendingTaps[i];
    if (f < p.gf) continue;
    pendingTaps.splice(i, 1);
    // totalMs: press -> its result on screen; ackMs: press -> the game's answer (input trip + waiting for the frame + answer
    // trip); shownMs: the result frame's arrival -> on screen (jitter buffer, decoding)
    report("tap", { totalMs: Math.round(performance.now() - p.ct), ackMs: p.ackMs, shownMs: stats.shownMs, rttMs: rtp.rttMs, framesLate: f - p.gf });
  }
});
function setupInput(ch) {
  inputChannel = ch;
  ch.onopen = () => log("input channel open (click the picture to give it keyboard focus)");
  ch.onclose = () => log("input channel closed");
  // timing: the game answers each press with the frame it took effect in ("ack"); the first frame at least that new
  // on screen closes the loop: tap -> game -> video -> screen, in ms on this page's own clock
  ch.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.t === "ack" && pendingTaps.length < 50) pendingTaps.push({ ct: m.ct, gf: m.gf, ackMs: Math.round(performance.now() - m.ct) });
  };
  if (inputBound) return;
  inputBound = true;
  const el = $("input");
  const send = sendInput = (o) => {
    const c = inputChannel;
    if (!c || c.readyState !== "open") return;
    o.f = stats.lastFrame; o.ct = Math.round(performance.now());
    // delay breakdown for stream-input.jsonl: the shown frame's arrival -> on screen (ms), the network round trip (ms)
    if (stats.shownMs !== undefined) o.vd = stats.shownMs;
    if (rtp.rttMs !== undefined) o.rtt = rtp.rttMs;
    c.send(JSON.stringify(o));
    stats.inputs = (stats.inputs || 0) + 1;
  };
  const pos = (e) => {
    const r = el.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  let lastMove = 0;
  el.addEventListener("pointerdown", (e) => {
    el.focus();
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers (automation) cannot be captured */ }
    send({ t: "down", b: e.button, ...pos(e) });
    e.preventDefault();
  });
  el.addEventListener("pointerup", (e) => { send({ t: "up", b: e.button, ...pos(e) }); e.preventDefault(); });
  el.addEventListener("pointermove", (e) => {
    const now = performance.now();
    if (now - lastMove < 8 && !e.buttons) return;      // hover moves at most ~120 Hz; drags are never thinned
    lastMove = now;
    send({ t: "move", ...pos(e) });
  });
  el.addEventListener("wheel", (e) => { send({ t: "wheel", dy: Math.sign(e.deltaY), ...pos(e) }); e.preventDefault(); }, { passive: false });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("keydown", (e) => { if (!e.repeat) send({ t: "kdown", code: e.code, key: e.key }); e.preventDefault(); });
  el.addEventListener("keyup", (e) => { send({ t: "kup", code: e.code, key: e.key }); e.preventDefault(); });
  setupTouchKeys(send);
}

// On-screen keys for keyboard games on touch devices: the game's "touch" setting (a pad of four key codes for
// up/left/down/right and labelled keys). Shown on coarse-pointer devices, or with ?touch=1 (?touch=0 hides them).
function setupTouchKeys(send) {
  const t = info && info.touch;
  const want = params.get("touch") === "1" || (params.get("touch") !== "0" && matchMedia("(pointer: coarse)").matches);
  if (!t || !want) return;
  const box = $("touchkeys");
  const keyName = (code) => code.startsWith("Key") ? code.slice(3).toLowerCase() : code === "Space" ? " " : code;
  const key = (label, code, cls) => {
    const b = document.createElement("button");
    b.textContent = label; b.className = cls || "";
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers */ }
      b.classList.add("on");
      send({ t: "kdown", code, key: keyName(code) });
    });
    const up = (e) => {
      e.preventDefault();
      if (!b.classList.contains("on")) return;
      b.classList.remove("on");
      send({ t: "kup", code, key: keyName(code) });
    };
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, up);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    return b;
  };
  if (t.pad && t.pad.length === 4) {
    const pad = document.createElement("div"); pad.className = "pad";
    const [u, l, d, r] = t.pad;
    pad.append(key("\u25B2", u, "u"), key("\u25C0", l, "l"), key("\u25BC", d, "d"), key("\u25B6", r, "r"));
    box.append(pad);
  }
  const keys = document.createElement("div"); keys.className = "keys";
  for (const k of t.keys || []) keys.append(key(k.label, k.code));
  box.append(keys);
  box.style.display = "flex";
}

// The tag band: 48 blocks; [0]=white, [1]=black, [2..33]=frame number (MSB first), [34..41]=CRC-8 (poly 0x07).
const tagCanvas = document.createElement("canvas");
const tagCtx = tagCanvas.getContext("2d", { willReadFrequently: true });
function crc8(bytes) {
  let c = 0;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; }
  return c;
}
function readTag(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || vh <= BAND) return null;
  tagCanvas.width = vw; tagCanvas.height = BAND;
  tagCtx.drawImage(video, 0, vh - BAND, vw, BAND, 0, 0, vw, BAND);
  const px = tagCtx.getImageData(0, 0, vw, BAND).data;
  const bit = (i) => {
    const x = Math.floor((i + 0.5) * vw / 48), y = BAND >> 1, o = (y * vw + x) * 4;
    return (px[o] + px[o + 1] + px[o + 2]) / 3 > 128 ? 1 : 0;
  };
  if (bit(0) !== 1 || bit(1) !== 0) return null;
  let f = 0; for (let i = 0; i < 32; i++) f = (f * 2) + bit(2 + i);
  let crc = 0; for (let i = 0; i < 8; i++) crc = (crc << 1) | bit(34 + i);
  const bytes = [(f >>> 24) & 255, (f >>> 16) & 255, (f >>> 8) & 255, f & 255];
  return crc8(bytes) === crc ? f : null;
}


function watchFrames() {
  const v = $("video");
  let viaVideo = false, lastSeen = -1;
  const handle = (meta) => {
    const f = readTag(v);
    if (f !== null && f === lastSeen) return;          // rAF fallback: the same video frame is still shown
    stats.videoFrames++;
    if (f === null) { stats.tagBad++; return; }
    stats.tagOk++;
    if (stats.lastFrame >= 0 && f !== stats.lastFrame + 1) stats.frameGaps++;   // the game renders faster than the stream
    stats.lastFrame = lastSeen = f;
    if (meta && meta.receiveTime && meta.presentationTime) stats.shownMs = Math.round(meta.presentationTime - meta.receiveTime);
    for (const fn of frameListeners) fn(f, meta);
  };
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    const onFrame = (now, meta) => { viaVideo = true; handle(meta); v.requestVideoFrameCallback(onFrame); };
    v.requestVideoFrameCallback(onFrame);
  }
  setTimeout(() => {
    if (viaVideo) { log("frame clock: requestVideoFrameCallback"); return; }
    log("frame clock: requestAnimationFrame (video frame callbacks unavailable)");
    const tick = () => { handle(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, 1000);
}

// ------------------------------------------------------------------------------------------ panel
let pcRef = null, lastBytes = 0, lastT = 0, rtp = {};
// every 5 s while connected: what the network did (for page-events.jsonl; deltas over the interval)
let netPrev = null;
setInterval(async () => {
  if (!pcRef || !["connected", "completed"].includes(pcRef.iceConnectionState)) return;
  try {
    const rep = await pcRef.getStats();
    let v = null, pair = null, dc = 0;
    rep.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") v = s;
      if (s.type === "transport" && s.selectedCandidatePairId) pair = rep.get(s.selectedCandidatePairId);
      if (s.type === "data-channel" && s.label === "ui") dc = s.bytesReceived || 0;
    });
    if (!v) return;
    const now = { t: performance.now(), bytes: v.bytesReceived, frames: v.framesDecoded, dropped: v.framesDropped || 0, lost: v.packetsLost || 0,
                  recv: v.packetsReceived || 0, freezes: v.freezeCount || 0, jbDelay: v.jitterBufferDelay || 0, jbCount: v.jitterBufferEmittedCount || 0, dc };
    if (netPrev) {
      const dt = (now.t - netPrev.t) / 1000, d = (k) => now[k] - netPrev[k];
      report("net", { kbps: Math.round(d("bytes") * 8 / dt / 1000), fps: Math.round(d("frames") / dt), dropped: d("dropped"),
                      lossPct: d("recv") + d("lost") > 0 ? +(100 * d("lost") / (d("recv") + d("lost"))).toFixed(1) : 0,
                      jitterMs: Math.round((v.jitter || 0) * 1000), bufferMs: d("jbCount") > 0 ? Math.round(1000 * d("jbDelay") / d("jbCount")) : null,
                      freezes: d("freezes"), rttMs: pair && pair.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : null,
                      uiKbps: Math.round(d("dc") * 8 / dt / 1000), uiLagFrames: stats.uiLagFrames, uiQueued: stateQueue.length });
    }
    netPrev = now;
  } catch (_) { /* stats unavailable */ }
}, 5000);

async function refreshPanel() {
  if (pcRef) {
    const rep = await pcRef.getStats();
    // the network path in use: host = same network, srflx = public addresses (STUN), relay = through TURN
    rep.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) {
        const pair = rep.get(s.selectedCandidatePairId), lc = pair && rep.get(pair.localCandidateId), rc = pair && rep.get(pair.remoteCandidateId);
        if (pair) rtp.path = (lc ? lc.candidateType + "/" + (lc.protocol || "") : "?") + " -> " + (rc ? rc.candidateType : "?");
        if (pair && pair.currentRoundTripTime !== undefined) rtp.rttMs = Math.round(pair.currentRoundTripTime * 1000);
      }
    });
    rep.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") {
        const t = s.timestamp, kbps = lastT ? ((s.bytesReceived - lastBytes) * 8) / (t - lastT) : 0;
        lastBytes = s.bytesReceived; lastT = t;
        rtp = { path: rtp.path, rttMs: rtp.rttMs, kbps: Math.round(kbps), fps: s.framesPerSecond || 0, decoder: s.decoderImplementation || "",
                jitterMs: s.jitterBufferEmittedCount ? Math.round(1000 * s.jitterBufferDelay / s.jitterBufferEmittedCount) : 0,
                dropped: s.framesDropped || 0, codec: s.codecId || "" };
      }
    });
  }
  const tagTotal = stats.tagOk + stats.tagBad;
  const rows = [
    ["mode", params.get("mode") || "live"], ["network path", rtp.path || "-"], ["round trip ms", rtp.rttMs ?? "-"],
    ["video frames", stats.videoFrames],
    ["tag read", tagTotal ? (100 * stats.tagOk / tagTotal).toFixed(2) + "% (" + stats.tagBad + " bad)" : "-"],
    ["game frame", stats.lastFrame], ["frame gaps", stats.frameGaps],
    ["video kbps", rtp.kbps ?? "-"], ["video fps", rtp.fps ?? "-"], ["jitter buffer ms", rtp.jitterMs ?? "-"],
    ["dropped", rtp.dropped ?? "-"], ["decoder", rtp.decoder || "-"],
    ["inputs sent", stats.inputs || 0], ["sync", syncMode], ["UI messages", stats.uiMessages || 0], ["UI keyframes", stats.uiKeyframes || 0], ["UI pushed", stats.pushed], ["UI applied", stats.applied],
    ["UI state lag (frames)", stats.uiLagFrames ?? "-"], ["video older than UI", stats.uiAhead || 0],
  ];
  $("panel").innerHTML = rows.map(([k, v]) => "<div>" + k + ": <b>" + v + "</b></div>").join("");
}

// ------------------------------------------------------------------------------------------ start
// ------------------------------------------------------------------------------------------ benchmark
// Per shown video frame: its game frame, the UI state frame pushed for it and (with requestVideoFrameCallback) the
// time it is expected on screen; per applied UI state: when the client applied it. Plus WebRTC receiver stats.
const bench = { on: false, frames: [], applied: [], rtp: [], t0: 0 };

onVideoFrame((f, meta) => {
  if (!bench.on) return;
  bench.frames.push({ t: performance.now(), f, ui: pushedFrame, show: meta ? meta.expectedDisplayTime : null });
});

async function sampleRtp() {
  if (!pcRef) return;
  const rep = await pcRef.getStats();
  const o = { t: performance.now() };
  const codecs = new Map();
  rep.forEach((s) => { if (s.type === "codec") codecs.set(s.id, s.mimeType); });
  rep.forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "video")
      Object.assign(o, { bytes: s.bytesReceived, decoded: s.framesDecoded, dropped: s.framesDropped, decodeTime: s.totalDecodeTime,
                         jbDelay: s.jitterBufferDelay, jbEmitted: s.jitterBufferEmittedCount, freezes: s.freezeCount,
                         decoder: s.decoderImplementation, codec: codecs.get(s.codecId), w: s.frameWidth, h: s.frameHeight });
    if (s.type === "candidate-pair" && s.nominated && s.currentRoundTripTime !== undefined) o.rtt = s.currentRoundTripTime;
  });
  bench.rtp.push(o);
}

// the codec the answer chose (first payload type of the video section); receiver stats do not always report it
function negotiatedCodec() {
  const sdp = pcRef && pcRef.remoteDescription ? pcRef.remoteDescription.sdp : "";
  const m = /^m=video \S+ \S+ (\d+)/m.exec(sdp);
  const r = m && new RegExp("^a=rtpmap:" + m[1] + " ([^/\\s]+)", "m").exec(sdp);
  return r ? "video/" + r[1] : null;
}

function quantile(a, q) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

function summarize(seconds) {
  const fr = bench.frames, ap = bench.applied, r0 = bench.rtp[0] || {}, r1 = bench.rtp[bench.rtp.length - 1] || {};
  const steps = fr.slice(1).map((x, i) => x.f - fr[i].f);
  const lags = fr.filter((x) => x.ui >= 0).map((x) => x.f - x.ui);
  // UI state f applied before video frame f was due on screen (same paint): needs expectedDisplayTime
  const appliedAt = new Map(); for (const a of ap) if (!appliedAt.has(a.src)) appliedAt.set(a.src, a.t);
  const timed = fr.filter((x) => x.show !== null && x.ui === x.f);
  const samePaint = timed.filter((x) => appliedAt.has(x.f) && appliedAt.get(x.f) <= x.show).length;
  const dt = (r1.t - r0.t) / 1000 || seconds;
  const decoded = (r1.decoded || 0) - (r0.decoded || 0);
  return {
    seconds, videoFramesShown: fr.length, shownFps: fr.length / seconds,
    tagDecodeRate: stats.tagOk + stats.tagBad ? stats.tagOk / (stats.tagOk + stats.tagBad) : null,
    gameFrameSteps: { one: steps.filter((x) => x === 1).length, two: steps.filter((x) => x === 2).length, more: steps.filter((x) => x > 2).length },
    lockstep: { framesWithUi: lags.length, exactUiFrame: lags.filter((x) => x === 0).length, lagMax: lags.length ? Math.max(...lags) : null,
                lagP95: quantile(lags, 0.95) },
    samePaint: { checked: timed.length, appliedBeforeDisplay: samePaint },
    uiState: { kBps: ((stats.uiStateChars || 0) - bench.chars0) / seconds / 1000, keyframes: (stats.uiKeyframes || 0) - bench.keys0 },
    uiApplyMs: { mean: mean(ap.map((a) => a.ms)), p95: quantile(ap.map((a) => a.ms), 0.95), applied: ap.length },
    video: { kbps: (((r1.bytes || 0) - (r0.bytes || 0)) * 8) / dt / 1000, decodedFps: decoded / dt,
             decodeMsPerFrame: decoded ? (1000 * ((r1.decodeTime || 0) - (r0.decodeTime || 0))) / decoded : null,
             jitterBufferMs: (r1.jbEmitted - (r0.jbEmitted || 0)) ? (1000 * (r1.jbDelay - (r0.jbDelay || 0))) / (r1.jbEmitted - (r0.jbEmitted || 0)) : null,
             dropped: (r1.dropped || 0) - (r0.dropped || 0), freezes: (r1.freezes || 0) - (r0.freezes || 0),
             codec: negotiatedCodec(), decoder: r1.decoder || null, size: r1.w ? r1.w + "x" + r1.h : null, rttMs: r1.rtt !== undefined ? r1.rtt * 1000 : null },
    frameClock: fr.some((x) => x.show !== null) ? "requestVideoFrameCallback" : "requestAnimationFrame",
    webgl: webglRenderer(),
    userAgent: navigator.userAgent,
  };
}

// The toolkit's step format ({"click":[x,y]}, {"tap":[x,y]}, {"drag":[x1,y1,x2,y2]}, {"key":"ESCAPE","hold":0.1},
// {"keys":["W","D"],"hold":1}, {"wait":s}; 0..1 coordinates, top-left origin) played through the input channel.
const KEY_CODES = { SPACE: "Space", ENTER: "Enter", RETURN: "Enter", ESCAPE: "Escape", ESC: "Escape", TAB: "Tab", BACKSPACE: "Backspace",
  UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight", SHIFT: "ShiftLeft", CTRL: "ControlLeft", ALT: "AltLeft" };
function keyCode(k) {
  k = String(k).toUpperCase();
  if (KEY_CODES[k]) return KEY_CODES[k];
  if (/^[A-Z]$/.test(k)) return "Key" + k;
  if (/^[0-9]$/.test(k)) return "Digit" + k;
  if (/^F([1-9]|1[0-2])$/.test(k)) return k;
  return k;
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
async function playSteps(steps) {
  for (const st of steps) {
    if (st.wait !== undefined) await sleep(st.wait);
    else if (st.click) {
      const [x, y] = st.click;
      sendInput({ t: "move", x, y }); await sleep(0.05);
      sendInput({ t: "down", b: 0, x, y }); await sleep(0.08);
      sendInput({ t: "up", b: 0, x, y });
    } else if (st.tap) {
      // as a touch screen sends it: press and release, no pointer move before
      const [x, y] = st.tap;
      sendInput({ t: "down", b: 0, x, y }); await sleep(0.08);
      sendInput({ t: "up", b: 0, x, y });
    } else if (st.drag) {
      const [x1, y1, x2, y2] = st.drag, n = 12;
      sendInput({ t: "down", b: 0, x: x1, y: y1 });
      for (let i = 1; i <= n; i++) { await sleep(0.03); sendInput({ t: "move", x: x1 + (x2 - x1) * i / n, y: y1 + (y2 - y1) * i / n }); }
      sendInput({ t: "up", b: 0, x: x2, y: y2 });
    } else if (st.key || st.keys) {
      const codes = (st.keys || [st.key]).map(keyCode);
      for (const c of codes) sendInput({ t: "kdown", code: c, key: c.length === 4 && c.startsWith("Key") ? c[3].toLowerCase() : "" });
      await sleep(st.hold ?? 0.1);
      for (const c of codes) sendInput({ t: "kup", code: c, key: "" });
    }
    await sleep(0.05);
  }
}

async function runBench(seconds) {
  phase = "bench";
  log("benchmark: warming up 5 s, then measuring " + seconds + " s");
  await new Promise((r) => setTimeout(r, 5000));
  const script = await (await fetch("/api/script")).json();
  if (script.steps && script.steps.length) { log("benchmark: playing " + script.steps.length + " input steps"); playSteps(script.steps); }
  stats.tagOk = 0; stats.tagBad = 0;
  bench.chars0 = stats.uiStateChars || 0; bench.keys0 = stats.uiKeyframes || 0;
  bench.on = true; bench.t0 = performance.now();
  await sampleRtp();
  const timer = setInterval(sampleRtp, 1000);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  bench.on = false; clearInterval(timer);
  await sampleRtp();
  const summary = summarize(seconds);
  log("benchmark: " + JSON.stringify(summary));
  await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, frames: bench.frames, applied: bench.applied, rtp: bench.rtp, params: location.search,
                           sdp: pcRef ? { offer: pcRef.localDescription.sdp, answer: pcRef.remoteDescription.sdp } : null }) });
}

// ------------------------------------------------------------------------------------------ remote play
// What a viewer sees, as one image: the world video under the UI canvas (the UI composited with its alpha).
function composite(layers = "all") {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = "#000"; x.fillRect(0, 0, W, H);
  const v = $("video");
  if (v.videoWidth && (layers === "world" || !videoInClient)) x.drawImage(v, 0, 0, v.videoWidth, v.videoHeight - BAND, 0, 0, W, H);   // tag band left out
  if (layers === "all") x.drawImage($("unity"), 0, 0, W, H);
  return c;
}

function remotePlay() {
  setInterval(() => {
    composite().toBlob((b) => b && fetch("/api/view", { method: "POST", body: b }).catch(() => {}), "image/jpeg", 0.85);
    composite("world").toBlob((b) => b && fetch("/api/view?layer=world", { method: "POST", body: b }).catch(() => {}), "image/jpeg", 0.85);
  }, 1000);
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await (await fetch("/api/steps")).json();
      if (r.steps && r.steps.length) { log("remote: " + JSON.stringify(r.steps).slice(0, 200)); await playSteps(r.steps); }
    } catch (_) { /* server restarting */ }
    busy = false;
  }, 250);
}

// heartbeat for the server console in headless runs (replay checks, benchmarks): phase, counters, last log lines
let phase = "start";
function heartbeat() {
  if (!params.get("capture") && !params.get("bench") && !params.get("remote")) return;
  setInterval(() => fetch("/api/progress", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phase, pushed: stats.pushed, applied: stats.applied, captured: captures.length, errors: recentErrors,
                           canvas: (() => { const c = $("unity"); return c.width + "x" + c.height + " css " + c.style.width + "x" + c.style.height; })(),
                           tail: $("log").textContent.trim().split("\n").slice(-3) }) }).catch(() => {}), 10000);
}

(async function main() {
  heartbeat();
  info = await loadInfo();
  report("page-load", { ua: navigator.userAgent.slice(0, 200), deviceMemoryGB: navigator.deviceMemory,
                        screen: screen.width + "x" + screen.height + "@" + devicePixelRatio });
  W = info.width; H = info.height; BAND = info.band || 16;
  // live: start the client at the game's actual resolution (games may change it from their saved settings);
  // resizing the client's drawing buffer later does not work in every project (linear color space)
  if ((params.get("mode") || (info.replay ? "replay" : "live")) === "live") {
    if (info.static) {
      // no server behind the page: the game machine tells its screen size through the relay
      try { const here = await findGame(); if (here.screen && here.screen[0] > 0) { W = here.screen[0]; H = here.screen[1]; } }
      catch (e) { log("game: " + e.message); }
    } else {
      try {
        const st = await (await fetch("/api/status")).json();
        if (st.screen && st.screen[0] > 0) { W = st.screen[0]; H = st.screen[1]; }
      } catch (_) { /* the game is not up yet: the configured size */ }
    }
  }
  layout();
  setInterval(refreshPanel, 1000);
  const mode = params.get("mode") || (info.replay ? "replay" : "live");
  const ui = params.get("ui") !== "0";
  if (mode === "replay") {
    setStatus("");
    $("video").style.display = "none";
    await startClient();
    await new Promise((r) => setTimeout(r, 500));
    await runReplay();
    return;
  }
  videoInClient = ui && params.get("compose") !== "page";   // ?compose=page: browser layers a transparent canvas instead
  setStatus("Loading the game client...");
  startVideo();
  if (ui) await startClient();
  while (!pcRef) await new Promise((r) => setTimeout(r, 200));   // benchmarks and remote play need the stream
  if (params.get("bench")) await runBench(+params.get("bench"));
  if (params.get("remote") === "1") { phase = "remote"; remotePlay(); }
})().catch((e) => log("error: " + (e && e.stack || e)));
