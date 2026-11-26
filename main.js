import { GestureTracker, GESTURE_CONFIG } from './gestures.js';
import { Sword, SWORD_CONFIG } from './sword.js';
import { Game, LEVELS } from './game.js';
import { drawHand, drawGripHand } from './hand.js';

const MP_VERSION = '1.2.3'; // SDK와 WASM을 같은 버전으로 고정
const CONFIG = {
  bundle: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`,
  wasmBase: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`,
  modelUrl: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  inferWidth: 640,       // 추론 입력 가로 크기 (비율 유지)
  dwellMs: 650,          // 메뉴 버튼 위에 머무는 시간
  modelTimeoutMs: 45000,
  workerStallMs: 2000,
  mainSkeletonScale: 0.8, // 메인 화면 손 뼈대 크기 (1 = 실제 크기)
  renderDpr: 1,          // 게임 캔버스 해상도 배율 상한 (레티나 2배로 그리면 그리기 비용이 약 3배)
};

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvases = { world: $('world'), sword: $('sword'), skeleton: $('skeleton') };
const ctx = {
  world: canvases.world.getContext('2d'),
  sword: canvases.sword.getContext('2d'),
  skeleton: canvases.skeleton.getContext('2d'),
};

const camBox = $('cam');
const camSkel = $('cam-skeleton');
ctx.cam = camSkel.getContext('2d');

const view = { W: 0, H: 0, dpr: 1, offX: 0, offY: 0, dispW: 0, dispH: 0, diag: 1 };
const mini = { W: 0, H: 0, offX: 0, offY: 0, dispW: 0, dispH: 0 };
const gestures = new GestureTracker();
const sword = new Sword();
const game = new Game();

let connections = [];
let worker = null;
let workerReady = false;
let busy = false;
let busySince = 0;
let lastSentTs = 0;
let delegate = '-';
let inferMs = 0;
let resultTimes = [];
let hand = null;          // { pts, world }
let gesture = gestures.snapshot(0);
let showSkeleton = true;
let debug = false;
let cameraReady = false;
let modelTimer = 0;

// ---------- 레이아웃 & 좌표 변환 ----------
function layout() {
  view.W = window.innerWidth;
  view.H = window.innerHeight;
  view.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.renderDpr);
  view.diag = Math.hypot(view.W, view.H);
  for (const c of Object.values(canvases)) {
    c.width = Math.round(view.W * view.dpr);
    c.height = Math.round(view.H * view.dpr);
  }
  for (const k of Object.keys(ctx)) ctx[k].setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  // object-fit: cover와 동일한 계산
  const scale = Math.max(view.W / vw, view.H / vh);
  view.dispW = vw * scale;
  view.dispH = vh * scale;
  view.offX = (view.W - view.dispW) / 2;
  view.offY = (view.H - view.dispH) / 2;

  // 미니 웹캠 창도 같은 cover 계산
  const r = camBox.getBoundingClientRect();
  mini.W = r.width;
  mini.H = r.height;
  camSkel.width = Math.round(mini.W * view.dpr);
  camSkel.height = Math.round(mini.H * view.dpr);
  ctx.cam.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const ms = Math.max(mini.W / vw, mini.H / vh);
  mini.dispW = vw * ms;
  mini.dispH = vh * ms;
  mini.offX = (mini.W - mini.dispW) / 2;
  mini.offY = (mini.H - mini.dispH) / 2;
  drawSkeleton();
}

// normalized landmark → 화면 px (미러링 + cover 크롭 반영)
function toScreen(p, v = view) {
  return { x: v.offX + (1 - p.x) * v.dispW, y: v.offY + p.y * v.dispH };
}

window.addEventListener('resize', layout);

// ---------- 상태 UI ----------
const statusEl = $('status');
let statusFadeTimer = 0;
function setStatus(text, kind = 'busy', { retry = null, fadeMs = 0 } = {}) {
  clearTimeout(statusFadeTimer);
  statusEl.classList.remove('fade');
  statusEl.dataset.kind = kind;
  $('status-text').textContent = text;
  const btn = $('status-retry');
  btn.hidden = !retry;
  btn.onclick = retry;
  if (fadeMs) statusFadeTimer = setTimeout(() => statusEl.classList.add('fade'), fadeMs);
}

// ---------- 카메라 ----------
async function startCamera() {
  setStatus('Requesting camera…');
  try {
    video.srcObject?.getTracks().forEach((t) => t.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
    cameraReady = true;
    layout();
    scheduleFrame();
    if (!workerReady) setStatus('Loading hand model…');
    else setStatus(`Ready · ${delegate}`, 'ok', { fadeMs: 2500 });
  } catch (err) {
    cameraReady = false;
    const msg =
      err.name === 'NotAllowedError' ? 'Camera blocked — allow access in the address bar' :
      err.name === 'NotFoundError' ? 'No camera found' :
      err.name === 'NotReadableError' ? 'Camera is in use by another app' :
      !window.isSecureContext ? 'Camera needs HTTPS or localhost' :
      'Camera error';
    setStatus(msg, 'error', { retry: startCamera });
  }
}

// ---------- 추론 Worker ----------
function startWorker() {
  worker?.terminate();
  workerReady = false;
  busy = false;
  if (cameraReady) setStatus('Loading hand model…');
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    clearTimeout(modelTimer);
    setStatus('Model failed to load', 'error', { retry: startWorker });
    console.error(e);
  };
  worker.postMessage({ type: 'init', bundle: CONFIG.bundle, wasmBase: CONFIG.wasmBase, modelUrl: CONFIG.modelUrl });
  clearTimeout(modelTimer);
  modelTimer = setTimeout(() => {
    if (!workerReady) setStatus('Model is taking too long', 'error', { retry: startWorker });
  }, CONFIG.modelTimeoutMs);
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'ready') {
    clearTimeout(modelTimer);
    workerReady = true;
    delegate = m.delegate;
    connections = m.connections;
    if (cameraReady) setStatus(`Ready · ${delegate}`, 'ok', { fadeMs: 2500 });
  } else if (m.type === 'delegate') {
    delegate = m.delegate;
    setStatus(`Switched to ${delegate}`, 'ok', { fadeMs: 2500 });
  } else if (m.type === 'error') {
    if (m.stage === 'model') setStatus('Model failed to load', 'error', { retry: startWorker });
    console.error('[worker]', m.message);
  } else if (m.type === 'result') {
    busy = false;
    onResult(m);
  }
}

// 최신 프레임 하나만: 워커가 처리 중이면 이번 프레임은 버림 (대기열 없음)
async function pumpFrame() {
  if (!workerReady || !cameraReady || video.readyState < 2) return;
  if (busy) {
    if (performance.now() - busySince > CONFIG.workerStallMs) busy = false; // 워커 응답 유실 대비
    else return;
  }
  busy = true;
  busySince = performance.now();
  let ts = performance.now();
  if (ts <= lastSentTs) ts = lastSentTs + 0.01;
  lastSentTs = ts;
  const iw = CONFIG.inferWidth;
  const ih = Math.round((iw * video.videoHeight) / video.videoWidth);
  try {
    const bitmap = await createImageBitmap(video, { resizeWidth: iw, resizeHeight: ih, resizeQuality: 'low' });
    worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]);
  } catch {
    busy = false;
  }
}

function scheduleFrame() {
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    video.requestVideoFrameCallback(() => { pumpFrame(); scheduleFrame(); });
  } else {
    requestAnimationFrame(() => { pumpFrame(); scheduleFrame(); });
  }
}

// ---------- 추론 결과 처리 ----------
function onResult(m) {
  inferMs = m.inferMs;
  const t = performance.now();
  resultTimes.push(t);
  while (resultTimes.length && t - resultTimes[0] > 1000) resultTimes.shift();

  hand = m.landmarks
    ? { pts: m.landmarks.map((p) => toScreen(p)), mini: m.landmarks.map((p) => toScreen(p, mini)), world: m.world }
    : null;
  gesture = gestures.update(hand ? hand.world : null, m.ts);

  const canHoldSword = hand && gesture.state === 'GRIP' && !panelOpen();
  sword.update(canHoldSword ? hand.pts : null, m.ts, view, hand?.world);

  // 손바닥 유지 → 메뉴
  if (gesture.state !== 'OPEN' && gesture.cand !== 'OPEN') menuLock = false;
  if (!panelOpen() && !menuLock && gesture.openHeldMs >= GESTURE_CONFIG.menuHoldMs) {
    menuLock = true;
    openPanel('menu');
  }

  drawSkeleton();
}

// 뼈대: 새 추론 결과가 올 때만 다시 그림, 손이 없으면 즉시 지움
function drawSkeleton() {
  ctx.skeleton.clearRect(0, 0, view.W, view.H);
  ctx.cam.clearRect(0, 0, mini.W, mini.H);
  if (!hand) return;
  // 미니 웹캠 위: 항상 표시 (영상과 정합 확인용)
  drawBones(ctx.cam, hand.mini, 1.2, 1.8, 0.95);
  // 메인 화면: 게임 속 손 위치 — 손바닥 중심 기준으로 작게 축소해서 칼을 가리지 않게
  if (showSkeleton) {
    // 메인 화면: 손 형태로. 칼을 쥐고 있으면 칼자루를 중심으로 축소해서 손이 칼을 감싸 쥐게
    const c = sword.active ? sword.hilt : [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + hand.pts[i].x / 5, y: a.y + hand.pts[i].y / 5 }), { x: 0, y: 0 });
    if (sword.active) drawGripHand(ctx.skeleton, hand.pts, sword); // 주먹은 칼자루 기준으로 그림
    else drawHand(ctx.skeleton, hand.pts, c, CONFIG.mainSkeletonScale);
  }

}

function drawBones(c, p, lineW, jointR, alpha) {
  c.save();
  c.strokeStyle = `rgba(255,255,255,${alpha})`;
  c.fillStyle = `rgba(255,255,255,${alpha})`;
  c.lineWidth = lineW;
  c.lineCap = 'round';
  c.beginPath();
  for (const [a, b] of connections) { c.moveTo(p[a].x, p[a].y); c.lineTo(p[b].x, p[b].y); }
  c.stroke();
  for (const q of p) { c.beginPath(); c.arc(q.x, q.y, jointR, 0, Math.PI * 2); c.fill(); }
  c.restore();
}

// ---------- 패널 (메뉴 / 결과) ----------
const panelEl = $('panel');
let panelKind = null;
let menuLock = false;
let dwell = { btn: null, since: 0, lockedBtn: null };

const panelOpen = () => panelKind !== null;

function panelButtons(kind) {
  const toggles = [
    { id: 'mode', label: () => `MODE · ${game.mode}` },
    { id: 'level', label: () => `LEVEL · ${game.level}` },
  ];
  if (kind === 'menu') {
    return [
      { id: 'resume', label: () => 'RESUME' },
      { id: 'restart', label: () => 'RESTART' },
      ...toggles,
      { id: 'skeleton', label: () => `SKELETON · ${showSkeleton ? 'ON' : 'OFF'}` },
      { id: 'versus', label: () => 'VERSUS · ONLINE' },
    ];
  }
  return [{ id: 'again', label: () => 'PLAY AGAIN' }, ...toggles];
}

function openPanel(kind) {
  panelKind = kind;
  game.paused = true;
  sword.hide(performance.now());
  renderPanel();
  panelEl.classList.remove('hidden');
  dwell = { btn: null, since: 0, lockedBtn: null };
}

function closePanel() {
  panelKind = null;
  game.paused = false;
  panelEl.classList.add('hidden');
  $('cursor').classList.remove('show');
}

function renderPanel() {
  if (panelKind === 'menu') {
    $('panel-title').textContent = 'PAUSED';
    $('panel-sub').textContent = `Best ${game.mode} · ${game.best[game.mode] || 0}`;
  } else {
    const o = game.over;
    $('panel-title').textContent = o.title;
    $('panel-sub').textContent = `Score ${o.score} · Best ${o.best}${o.isBest ? ' · NEW BEST' : ''}`;
  }
  const wrap = $('panel-buttons');
  wrap.innerHTML = '';
  for (const b of panelButtons(panelKind)) {
    const el = document.createElement('button');
    el.className = 'pbtn';
    el.type = 'button';
    el.dataset.id = b.id;
    el.innerHTML = `<span>${b.label()}</span>`;
    el.addEventListener('click', () => activate(b.id));
    wrap.appendChild(el);
  }
}

function activate(id) {
  if (id === 'resume') { closePanel(); return; }
  if (id === 'versus') { location.href = 'versus/'; return; }
  if (id === 'restart' || id === 'again') { game.reset(); closePanel(); return; }
  if (id === 'mode') { game.setMode(game.mode === 'DUEL' ? 'SLICE' : 'DUEL'); if (panelKind === 'over') panelKind = 'menu'; }
  if (id === 'level') { game.setLevel(LEVELS[(LEVELS.indexOf(game.level) + 1) % LEVELS.length]); if (panelKind === 'over') panelKind = 'menu'; }
  if (id === 'skeleton') { showSkeleton = !showSkeleton; drawSkeleton(); }
  renderPanel();
}

// 검지 끝으로 버튼 위에 머물면 선택
function updateDwell(now) {
  const cur = $('cursor');
  if (!panelOpen() || !hand) {
    cur.classList.remove('show');
    dwell.btn = null;
    panelEl.querySelectorAll('.pbtn').forEach((b) => b.style.setProperty('--dwell', 0));
    return;
  }
  const tip = hand.pts[8];
  cur.classList.add('show');
  cur.style.transform = `translate(${tip.x}px, ${tip.y}px)`;

  let hit = null;
  for (const b of panelEl.querySelectorAll('.pbtn')) {
    const r = b.getBoundingClientRect();
    const over = tip.x >= r.left && tip.x <= r.right && tip.y >= r.top && tip.y <= r.bottom;
    b.classList.toggle('hover', over);
    if (over) hit = b;
  }
  const id = hit?.dataset.id ?? null;
  if (id !== dwell.lockedBtn) dwell.lockedBtn = null; // 버튼을 벗어나야 다시 선택 가능
  if (id !== dwell.btn) { dwell.btn = id; dwell.since = now; }

  let prog = 0;
  if (id && id !== dwell.lockedBtn) {
    prog = Math.min(1, (now - dwell.since) / CONFIG.dwellMs);
    if (prog >= 1) {
      dwell.lockedBtn = id;
      dwell.since = now;
      activate(id);
      prog = 0;
    }
  }
  panelEl.querySelectorAll('.pbtn').forEach((b) => b.style.setProperty('--dwell', b.dataset.id === id ? prog : 0));
  const C = 2 * Math.PI * 18;
  $('cursor-prog').style.strokeDasharray = `${C * prog} ${C}`;
}

// ---------- HUD ----------
const dockItems = Object.fromEntries([...document.querySelectorAll('#dock .item')].map((el) => [el.dataset.g, el]));
let slashFlashUntil = 0;

function updateHud(now) {
  // 도크
  if (sword.slashing) slashFlashUntil = now + 160;
  const charging = !panelOpen() && (gesture.state === 'OPEN' || gesture.cand === 'OPEN') && !menuLock;
  dockItems.GRIP.classList.toggle('active', sword.active);
  dockItems.SLASH.classList.toggle('active', sword.active && now < slashFlashUntil);
  dockItems.GUARD.classList.toggle('active', sword.active && sword.guarding);
  dockItems.THRUST.classList.toggle('active', sword.active && sword.thrusting);
  dockItems.MENU.classList.toggle('active', panelOpen() || charging);

  // 손바닥 충전 링
  const pc = $('palm-charge');
  if (charging && hand) {
    const p = hand.pts;
    const cx = (p[0].x + p[5].x + p[17].x) / 3, cy = (p[0].y + p[5].y + p[17].y) / 3;
    pc.classList.add('show');
    pc.style.transform = `translate(${cx}px, ${cy}px)`;
    const k = Math.min(1, gesture.openHeldMs / GESTURE_CONFIG.menuHoldMs);
    const C = 2 * Math.PI * 34;
    $('palm-prog').style.strokeDasharray = `${C * k} ${C}`;
  } else {
    pc.classList.remove('show');
  }

  // 상단
  const top = $('topbar');
  top.dataset.mode = game.mode;
  if (game.mode === 'DUEL') {
    $('hp-you-fill').style.width = `${game.playerHp}%`;
    $('hp-rival-fill').style.width = `${game.enemyHp}%`;
    $('mo-fill').style.width = `${Math.round(game.enemy.momentum * 100)}%`;
    $('stat-main').textContent = `ROUND ${game.round} · ${game.wins[0]}–${game.wins[1]}`;
    $('stat-sub').textContent = game.score;
  } else {
    $('stat-main').textContent = `${Math.ceil(game.timeLeft)}s`;
    $('stat-sub').textContent = game.score;
  }

  // 배너
  const banner = $('banner');
  if (game.banner && now < game.banner.until) {
    if (banner.textContent !== game.banner.text) banner.textContent = game.banner.text;
    banner.classList.toggle('small', !!game.banner.small);
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }

  // 힌트
  const hint = $('hint');
  let hintText = '';
  if (workerReady && cameraReady && !panelOpen()) {
    if (!hand) hintText = 'Show one hand to the camera';
    else if (!game.started) hintText = 'Make a fist to draw your sword';
    else if (game.mode === 'DUEL' && game.enemy.state === 'telegraph') hintText = 'Hold your blade on the line';
  }
  if (hintText) { hint.textContent = hintText; hint.classList.add('show'); } else hint.classList.remove('show');

  // 디버그
  if (debug) {
    const m = gesture.metrics;
    const g = game.enemy?.ghost;
    const lines = [
      `FPS render ${renderFps}  infer ${resultTimes.length}   infer ${inferMs.toFixed(1)}ms   ${delegate}`,
      `state ${gesture.state}   raw ${gesture.raw}   cand ${gesture.cand ?? '-'} ${(gesture.candProgress * 100) | 0}%`,
      m ? `ext  I ${m.ext[0].toFixed(2)}  M ${m.ext[1].toFixed(2)}  R ${m.ext[2].toFixed(2)}  P ${m.ext[3].toFixed(2)}` : 'ext  -',
      m ? `thumb ${m.thumb.toFixed(2)}   fistIn<${GESTURE_CONFIG.fistIn} hold<${GESTURE_CONFIG.fistHold}` : '',
      `sword ${sword.active ? 'ON' : 'off'}  speed ${sword.speed.toFixed(2)}  (slash>${SWORD_CONFIG.slashIn})`,
      `angle ${sword.angle.toFixed(0)}°  slash ${sword.slashing}  guard ${sword.guarding}`,
      `thrust approach ${sword.approach.toFixed(2)} (>${SWORD_CONFIG.thrustRate})  ${sword.thrusting ? 'THRUST!' : ''}`,
      `depth ${(sword.depth ?? 0).toFixed(2)} (${(sword.depth ?? 0) < -0.15 ? "into screen" : (sword.depth ?? 0) > 0.15 ? "toward you" : "flat"})  face ${(sword.face ?? 0).toFixed(2)}  len ${(sword.len / (sword.fullLen || 1) * 100) | 0}%`,
      g ? `ghost ${g.angle}°  match ${game.enemy.matching}` : '',
      game.mode === 'DUEL' ? `rival ${game.enemy.state}  momentum ${game.enemy.momentum.toFixed(2)}  weak ${game.enemy.weak ?? '-'}  combo ${game.combo}` : '',
      `open ${gesture.openHeldMs | 0}ms / ${GESTURE_CONFIG.menuHoldMs}`,
    ];
    $('debug').textContent = lines.filter(Boolean).join('\n');
  }
}

// ---------- 메인 루프 ----------
let lastT = performance.now();
const frameTimes = [];
let renderFps = 0;
function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  frameTimes.push(t);
  while (frameTimes.length && t - frameTimes[0] > 1000) frameTimes.shift();
  renderFps = frameTimes.length;
  lastT = t;
  game.update(dt, t, sword, view);
  if (game.over && panelKind !== 'over') openPanel('over');
  game.render(ctx.world, view);
  sword.render(ctx.sword, view, t, debug);
  updateDwell(t);
  updateHud(t);
  requestAnimationFrame(loop);
}

// ---------- 키보드 ----------
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelKind === 'menu') closePanel();
  else if (e.code === 'Space') { e.preventDefault(); panelKind === 'menu' ? closePanel() : !panelOpen() && openPanel('menu'); }
  else if (e.key === 'r' || e.key === 'R') { game.reset(); if (panelOpen()) closePanel(); }
  else if (e.key === 'd' || e.key === 'D') { debug = !debug; $('debug').classList.toggle('hidden', !debug); }
  else if (e.key === 's' || e.key === 'S') { showSkeleton = !showSkeleton; drawSkeleton(); }
});

// ---------- 시작 ----------
layout();
startWorker();   // 모델 로딩과 카메라 권한 요청을 동시에
startCamera();
requestAnimationFrame(loop);
