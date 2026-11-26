// Air Duel Versus — 온라인 1:1 (For Honor식 3방향 가드)
// 싱글플레이 모듈 재사용: 제스처(gestures.js), 칼(sword.js), 이펙트·캐릭터(game.js), 추론(tracker.js + worker.js)
import { GestureTracker } from '../gestures.js';
import { Sword, lerpPt } from '../sword.js';
import { FX, drawFigure } from '../game.js';
import { HandTracker } from '../tracker.js';
import { Combat, VS_CONFIG, flipSide } from './combat.js';
import { Net } from './net.js';
import { PAL, glow } from '../palette.js';

const UI = {
  poseHz: 15,            // 상대에게 내 칼 자세를 보내는 빈도
  countdownMs: 3000,
  roundEndMs: 2200,
  pingMs: 2000,
  mainSkeletonScale: 0.6,
};

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvases = { world: $('world'), sword: $('sword'), skeleton: $('skeleton') };
const ctx = {
  world: canvases.world.getContext('2d'),
  sword: canvases.sword.getContext('2d'),
  skeleton: canvases.skeleton.getContext('2d'),
  cam: $('cam-skeleton').getContext('2d'),
};
const view = { W: 0, H: 0, dpr: 1, offX: 0, offY: 0, dispW: 0, dispH: 0, diag: 1 };
const mini = { W: 0, H: 0, offX: 0, offY: 0, dispW: 0, dispH: 0 };

const gestures = new GestureTracker();
const sword = new Sword();
const fx = new FX();
let hand = null;
let gesture = gestures.snapshot(0);
let debug = false;
let showSkeleton = true;

// ---------- 레이아웃 (싱글과 동일: 미러링 + cover 크롭) ----------
function coverInto(box, W, H, vw, vh) {
  const k = Math.max(W / vw, H / vh);
  box.dispW = vw * k; box.dispH = vh * k;
  box.offX = (W - box.dispW) / 2; box.offY = (H - box.dispH) / 2;
}
function layout() {
  view.W = innerWidth; view.H = innerHeight;
  view.dpr = Math.min(devicePixelRatio || 1, 1); // 레티나 2배 그리기는 비용이 약 3배 → 1배로 제한
  view.diag = Math.hypot(view.W, view.H);
  for (const c of Object.values(canvases)) { c.width = Math.round(view.W * view.dpr); c.height = Math.round(view.H * view.dpr); }
  const r = $('cam').getBoundingClientRect();
  mini.W = r.width; mini.H = r.height;
  $('cam-skeleton').width = Math.round(mini.W * view.dpr);
  $('cam-skeleton').height = Math.round(mini.H * view.dpr);
  for (const k of Object.keys(ctx)) ctx[k].setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  coverInto(view, view.W, view.H, vw, vh);
  coverInto(mini, mini.W, mini.H, vw, vh);
  drawSkeleton();
}
const toScreen = (p, v = view) => ({ x: v.offX + (1 - p.x) * v.dispW, y: v.offY + p.y * v.dispH });
addEventListener('resize', layout);

// ---------- 상태 UI ----------
let statusFade = 0;
function setStatus(text, kind = 'busy', retry = null, fadeMs = 0) {
  clearTimeout(statusFade);
  const el = $('status');
  el.classList.remove('fade');
  el.dataset.kind = kind;
  $('status-text').textContent = text;
  $('status-retry').hidden = !retry;
  $('status-retry').onclick = retry;
  if (fadeMs) statusFade = setTimeout(() => el.classList.add('fade'), fadeMs);
}

// ---------- 손 추적 ----------
const tracker = new HandTracker(video, { onResult, onStatus: setStatus, onReady: layout });

function onResult(m) {
  hand = m.landmarks
    ? { pts: m.landmarks.map((p) => toScreen(p)), mini: m.landmarks.map((p) => toScreen(p, mini)), world: m.world }
    : null;
  gesture = gestures.update(hand ? hand.world : null, m.ts);
  sword.update(hand && gesture.state === 'GRIP' ? hand.pts : null, m.ts, view, hand?.world);
  sword.sweeps.length = 0; // 멀티에서는 스윕 충돌 대신 방향 판정만 사용
  combat.onSword(sword, m.ts);
  drawSkeleton();
}

function drawBones(c, p, lineW, jointR, alpha) {
  c.save();
  c.strokeStyle = c.fillStyle = `rgba(255,255,255,${alpha})`;
  c.lineWidth = lineW;
  c.lineCap = 'round';
  c.beginPath();
  for (const [a, b] of tracker.connections) { c.moveTo(p[a].x, p[a].y); c.lineTo(p[b].x, p[b].y); }
  c.stroke();
  for (const q of p) { c.beginPath(); c.arc(q.x, q.y, jointR, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
function drawSkeleton() {
  ctx.skeleton.clearRect(0, 0, view.W, view.H);
  ctx.cam.clearRect(0, 0, mini.W, mini.H);
  if (!hand) return;
  drawBones(ctx.cam, hand.mini, 1.2, 1.8, 0.95);
  if (showSkeleton) {
    const c = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + hand.pts[i].x / 5, y: a.y + hand.pts[i].y / 5 }), { x: 0, y: 0 });
    const k = UI.mainSkeletonScale;
    drawBones(ctx.skeleton, hand.pts.map((p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k })), 1.2, 2, 0.45);
  }
}

// ---------- 네트워크 & 매치 ----------
const net = new Net({
  onOpen,
  onMessage,
  onClose,
  onStatus: (text, kind) => {
    setStatus(text, kind, kind === 'error' ? showLobbyStart : null);
    if (net.code) $('room-code').textContent = net.code;
  },
});
const combat = new Combat((m) => net.send(m));

// phase: lobby → waiting → countdown → fight → roundEnd → (countdown …) → over
const match = { phase: 'lobby', round: 0, me: 0, opp: 0, phaseAt: 0 };
let rtt = null;
let pingTimer = 0;
let rematchWanted = false;

const isHost = () => net.role === 'host';

function onOpen() {
  match.phase = 'waiting';
  $('wait-text').textContent = 'Connected — starting…';
  net.send({ t: 'hello' });
  clearInterval(pingTimer);
  pingTimer = setInterval(() => net.send({ t: 'ping', ts: performance.now() }), UI.pingMs);
}

function onClose() {
  clearInterval(pingTimer);
  combat.setFighting(false);
  match.phase = 'lobby';
  rtt = null;
  showBanner('OPPONENT LEFT', 1600);
  showLobbyStart();
  setStatus('Disconnected', 'error');
}

function onMessage(m) {
  const now = performance.now();
  switch (m.t) {
    case 'hello':
      if (isHost()) setTimeout(hostStartMatch, 600);
      break;
    case 'round':
      if (!isHost()) applyRound(m);
      break;
    case 'dead':
      if (isHost()) hostOnDeath('guest');
      break;
    case 'rematch':
      if (isHost()) hostStartMatch();
      break;
    case 'ping':
      net.send({ t: 'pong', ts: m.ts });
      break;
    case 'pong':
      rtt = now - m.ts;
      break;
    default:
      combat.onMessage(m, now);
  }
}

// 라운드 진행은 호스트가 결정해서 방송 (wins = [호스트, 게스트])
function hostStartMatch() {
  match.me = 0; match.opp = 0;
  hostStartRound(1);
}
function hostBroadcast(r) {
  const msg = { t: 'round', ...r, wins: [match.me, match.opp] };
  net.send(msg);
  applyRound(msg);
}
function hostStartRound(n) {
  hostBroadcast({ n, phase: 'countdown' });
  setTimeout(() => { if (match.phase === 'countdown') hostBroadcast({ n, phase: 'fight' }); }, UI.countdownMs);
}
function hostOnDeath(loser) {
  if (match.phase !== 'fight') return;
  const winner = loser === 'host' ? 'guest' : 'host';
  if (winner === 'host') match.me++; else match.opp++;
  const n = match.round;
  hostBroadcast({ n, phase: 'roundEnd', winner });
  setTimeout(() => {
    const top = Math.max(match.me, match.opp);
    if (top >= VS_CONFIG.winsNeeded) hostBroadcast({ n, phase: 'over', winner });
    else hostStartRound(n + 1);
  }, UI.roundEndMs);
}

function applyRound(m) {
  const host = isHost();
  match.me = host ? m.wins[0] : m.wins[1];
  match.opp = host ? m.wins[1] : m.wins[0];
  match.round = m.n;
  match.phase = m.phase;
  match.phaseAt = performance.now();
  const iWon = m.winner && (m.winner === 'host') === host;
  if (m.phase === 'countdown') {
    combat.reset();
    combat.setFighting(false);
    fx.clear();
    rematchWanted = false;
    hideLobby();
  } else if (m.phase === 'fight') {
    combat.setFighting(true);
    showBanner('FIGHT', 700);
  } else if (m.phase === 'roundEnd') {
    combat.setFighting(false);
    showBanner(iWon ? 'ROUND WON' : 'ROUND LOST', 1800);
  } else if (m.phase === 'over') {
    combat.setFighting(false);
    showOver(iWon);
  }
}

// ---------- 로비 UI ----------
function showLobbyStart() {
  $('lobby').classList.remove('hidden');
  $('lobby-start').hidden = false;
  $('lobby-wait').hidden = true;
  $('lobby-over').hidden = true;
}
function showLobbyWait() {
  $('lobby').classList.remove('hidden');
  $('lobby-start').hidden = true;
  $('lobby-wait').hidden = false;
  $('lobby-over').hidden = true;
  $('wait-text').textContent = 'Waiting for opponent…';
}
function showOver(won) {
  $('lobby').classList.remove('hidden');
  $('lobby-start').hidden = true;
  $('lobby-wait').hidden = true;
  $('lobby-over').hidden = false;
  $('over-title').textContent = won ? 'VICTORY' : 'DEFEAT';
  $('over-sub').textContent = `${match.me} – ${match.opp}`;
  $('btn-rematch').querySelector('span').textContent = 'REMATCH';
}
function hideLobby() { $('lobby').classList.add('hidden'); }

$('btn-create').onclick = () => { net.host(); $('room-code').textContent = '····'; showLobbyWait(); };
$('join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length < 4) { setStatus('Enter the 4-letter room code', 'error'); return; }
  net.join(code);
  showLobbyWait();
  $('room-code').textContent = code;
  $('wait-text').textContent = 'Connecting…';
};
$('btn-copy').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${net.code}`;
  try { await navigator.clipboard.writeText(url); setStatus('Invite link copied', 'ok', null, 2000); }
  catch { setStatus(url, 'ok'); }
};
$('btn-rematch').onclick = () => {
  if (!net.connected) { showLobbyStart(); return; }
  rematchWanted = true;
  $('btn-rematch').querySelector('span').textContent = 'WAITING…';
  if (isHost()) hostStartMatch(); else net.send({ t: 'rematch' });
};

// ---------- 이벤트 → 이펙트 ----------
let banner = null;
function showBanner(text, ms = 1000, small = false) { banner = { text, until: performance.now() + ms, small }; }

const SIDE_ANG = { LEFT: Math.PI, TOP: -Math.PI / 2, RIGHT: 0 };
let oppFlash = 0;
let lastLaunch = 0;

function geo() {
  const s = Math.min(view.W, view.H) * 0.62;
  return { s, ex: view.W / 2, ey: view.H * 0.53 };
}
function reticle(g) { return { x: g.ex, y: g.ey - 0.14 * g.s, r: 0.42 * g.s }; }
function sidePoint(side, scale = 1) {
  const rc = reticle(geo());
  if (side === 'CENTER' || !(side in SIDE_ANG)) return { x: rc.x, y: rc.y };
  const a = SIDE_ANG[side];
  return { x: rc.x + Math.cos(a) * rc.r * scale, y: rc.y + Math.sin(a) * rc.r * scale };
}

// 색 체계는 싱글과 동일: 나 = 청백(PAL.player), 상대 = 붉은(PAL.enemy), 기회·패링 = 금(PAL.vital), 피격 = PAL.hurt
function handleEvents(t) {
  const g = geo();
  for (const e of combat.events.splice(0)) {
    if (e.type === 'launch') {
      lastLaunch = t;
    } else if (e.type === 'defense') {
      const p = sidePoint(e.side);
      if (e.outcome === 'hit') {
        fx.crack(p.x, p.y, g.s * 0.25, PAL.hurt); fx.flash = 0.65; fx.flashColor = PAL.hurt; fx.kick(14); fx.stop(110);
        showBanner(`−${e.dmg}`, 600, true);
      } else if (e.outcome === 'block') {
        fx.shield(p.x, p.y, g.s * 0.09, PAL.player, 0.32);
        fx.sparks(p.x, p.y, 18, g.s * 1.4, null, Math.PI * 2, PAL.spark); fx.kick(4); fx.stop(50);
        showBanner('BLOCK', 450, true);
      } else if (e.outcome === 'parry') {
        fx.shield(p.x, p.y, g.s * 0.14, PAL.player);
        fx.sparks(p.x, p.y, 34, g.s * 2.2, null, Math.PI * 2, PAL.spark);
        fx.ring(p.x, p.y, 10, g.s * 0.35, 0.4, 5, PAL.vital);
        fx.flash = 0.3; fx.flashColor = PAL.vital; fx.stop(100); fx.kick(8);
        showBanner('PARRY!', 800, true);
      } else if (e.outcome === 'break') {
        fx.ring(p.x, p.y, 10, g.s * 0.5, 0.45, 6, PAL.enemy); fx.flash = 0.5; fx.flashColor = PAL.hurt; fx.kick(12); fx.stop(110);
        showBanner('GUARD BROKEN', 900, true);
      } else if (e.outcome === 'counter') {
        fx.sparks(p.x, p.y, 26, g.s * 1.8, null, Math.PI * 2, PAL.spark); fx.ring(p.x, p.y, 10, g.s * 0.3, 0.35, 4, PAL.player);
        showBanner('COUNTER!', 700, true);
      }
    } else if (e.type === 'attackResult') {
      const p = lerpPt(sidePoint(e.side ?? 'CENTER', 0.5), sidePoint('CENTER'), 0.4);
      if (e.outcome === 'hit') {
        oppFlash = 1;
        const ang = e.side === 'LEFT' ? 0 : e.side === 'RIGHT' ? Math.PI : Math.PI / 2;
        fx.slash(p.x, p.y, ang, g.s * 0.5, PAL.player);
        fx.sparks(p.x, p.y, 24, g.s * 1.8, null, Math.PI * 2, PAL.vital); fx.stop(70); fx.kick(6);
        showBanner('HIT', 450, true);
      } else if (e.outcome === 'block') {
        fx.shield(p.x, p.y, g.s * 0.08, PAL.enemy, 0.3);
        fx.sparks(p.x, p.y, 12, g.s, null, Math.PI * 2, PAL.spark); showBanner('BLOCKED', 500, true);
      } else if (e.outcome === 'parry') {
        fx.flash = 0.4; fx.flashColor = PAL.hurt; fx.kick(10); showBanner('PARRIED — STUNNED', 900, true);
      } else if (e.outcome === 'break') {
        fx.ring(p.x, p.y, 10, g.s * 0.45, 0.4, 5, PAL.player); showBanner('GUARD BREAK!', 800, true);
      } else if (e.outcome === 'counter') {
        fx.sparks(p.x, p.y, 20, g.s * 1.4, null, Math.PI * 2, PAL.spark);
        showBanner('COUNTERED', 700, true);
      }
    } else if (e.type === 'dead') {
      if (isHost()) hostOnDeath('host');
    }
  }
}

// ---------- 상대 캐릭터 ----------
// 포즈: [칼자루, 칼끝] (적 중심 기준, 키 대비). 측면은 '내 화면' 기준.
const POSE = {
  IDLE: [[0.08, 0], [0.3, 0.15]],
  GUARD: { LEFT: [[-0.06, -0.1], [-0.22, -0.46]], RIGHT: [[0.06, -0.1], [0.22, -0.46]], TOP: [[-0.12, -0.34], [0.24, -0.4]] },
  WIND: { LEFT: [[-0.14, -0.22], [-0.36, -0.55]], RIGHT: [[0.14, -0.22], [0.36, -0.55]], TOP: [[-0.02, -0.45], [0.12, -0.75]], CENTER: [[0, -0.16], [0.01, -0.25]] },
  STRIKE: { LEFT: [[0, -0.12], [0.34, 0.02]], RIGHT: [[0, -0.12], [-0.34, 0.02]], TOP: [[0, -0.2], [0.04, 0.25]], CENTER: [[0, -0.14], [0, -0.17]] },
};
let oppBlade = null;

function poseToBlade(pose, g) {
  return { a: { x: g.ex + pose[0][0] * g.s, y: g.ey + pose[0][1] * g.s }, b: { x: g.ex + pose[1][0] * g.s, y: g.ey + pose[1][1] * g.s } };
}
function lerpBlade(p, q, k) { return { a: lerpPt(p.a, q.a, k), b: lerpPt(p.b, q.b, k) }; }

function updateOppBlade(g, t, dt) {
  const opp = combat.opp;
  const inc = combat.incoming[0];
  let target;
  let k = 1 - Math.exp(-dt * 14);
  if (inc) {
    const p = Math.min(1, (t - inc.start) / inc.windup);
    const wind = poseToBlade(POSE.WIND[inc.side], g);
    if (p < 0.7) {
      target = wind;
    } else {
      target = lerpBlade(wind, poseToBlade(POSE.STRIKE[inc.side], g), Math.pow((p - 0.7) / 0.3, 2));
      k = 0.7;
    }
  } else if (opp.active && opp.guard) {
    target = poseToBlade(POSE.GUARD[flipSide(opp.guard)], g);
  } else {
    target = poseToBlade(POSE.IDLE, g);
  }
  oppBlade = oppBlade ? lerpBlade(oppBlade, target, k) : target;
}

function renderWorld(t, dt) {
  const c = ctx.world;
  const g = geo();
  c.clearRect(0, 0, view.W, view.H);
  if (match.phase === 'lobby') return;
  c.save();
  if (fx.shake > 0) c.translate((Math.random() - 0.5) * 2 * fx.shake, (Math.random() - 0.5) * 2 * fx.shake);

  updateOppBlade(g, t, dt);
  const oppStunned = !!combat.opp.stunned;
  drawFigure(c, g, oppBlade, {
    tilt: oppStunned ? -0.05 + Math.sin(t / 90) * 0.015 : 0,
    flash: oppFlash,
    alpha: match.phase === 'roundEnd' || match.phase === 'over' ? 0.5 : 1,
  });
  oppFlash = Math.max(0, oppFlash - dt * 4);
  if (oppStunned) {
    c.save();
    c.fillStyle = `rgb(${PAL.vital})`;
    c.font = `800 ${Math.round(g.s * 0.05)}px ${getComputedStyle(document.body).fontFamily}`;
    c.textAlign = 'center';
    c.shadowColor = `rgba(${PAL.vital},0.9)`;
    c.shadowBlur = glow(12);
    c.fillText('OPENING', g.ex, g.ey + 0.56 * g.s); // 발 아래: 위쪽 공격 표시와 겹치지 않게
    c.restore();
  }
  if (match.phase === 'fight') drawReticle(c, g, t);
  fx.render(c, view);
  c.restore();
}

// For Honor식 가드 표시: 좌/위/우 세 호. 내 가드는 진하게, 들어오는 공격은 바깥 호가 차오르며 깜빡임
function drawReticle(c, g, t) {
  const rc = reticle(g);
  const span = (70 * Math.PI) / 180;
  c.save();
  c.lineCap = 'round';
  for (const side of ['LEFT', 'TOP', 'RIGHT']) {
    const a = SIDE_ANG[side];
    const mine = combat.guard === side;
    // 내 가드 = 청백
    c.shadowColor = `rgba(${PAL.player},0.9)`;
    c.shadowBlur = mine ? glow(16) : 0;
    c.strokeStyle = mine ? `rgb(${PAL.playerCore})` : 'rgba(255,255,255,0.22)';
    c.lineWidth = mine ? 8 : 3;
    c.beginPath(); c.arc(rc.x, rc.y, rc.r, a - span / 2, a + span / 2); c.stroke();
  }
  for (const inc of combat.incoming) {
    const p = Math.min(1, (t - inc.start) / inc.windup);
    const inWindow = inc.impactAt - t <= VS_CONFIG.parryWindow;
    const blink = inWindow ? 0.5 + 0.5 * Math.sin(t / 30) : 1;
    // 들어오는 공격 = 붉은색, 패링 타이밍(착지 직전) = 금색으로 깜빡임
    const col = inWindow && inc.kind === 'slash' ? PAL.vital : PAL.enemy;
    c.shadowColor = `rgba(${col},0.95)`;
    c.shadowBlur = glow(20);
    c.strokeStyle = `rgba(${col},${0.35 + 0.65 * blink})`;
    if (inc.kind === 'thrust') {
      // 가운데로 조여드는 마름모 = 가드 브레이크 (찌르기로 받아쳐야 함)
      const r = rc.r * (0.55 - 0.4 * p);
      c.lineWidth = 5;
      c.beginPath();
      c.moveTo(rc.x, rc.y - r); c.lineTo(rc.x + r, rc.y); c.lineTo(rc.x, rc.y + r); c.lineTo(rc.x - r, rc.y);
      c.closePath(); c.stroke();
      c.fillStyle = `rgba(${PAL.enemy},${0.15 + 0.35 * p})`;
      c.fill();
      continue;
    }
    const a = SIDE_ANG[inc.side];
    c.lineWidth = inWindow ? 12 : 7;
    c.beginPath(); c.arc(rc.x, rc.y, rc.r * 1.14, a - (span / 2) * p, a + (span / 2) * p); c.stroke();
    // 안쪽을 가리키는 화살촉
    const tip = { x: rc.x + Math.cos(a) * rc.r * 1.3, y: rc.y + Math.sin(a) * rc.r * 1.3 };
    const d = { x: -Math.cos(a), y: -Math.sin(a) }, n = { x: -d.y, y: d.x }, h = g.s * 0.04;
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(tip.x - d.x * h + n.x * h, tip.y - d.y * h + n.y * h);
    c.lineTo(tip.x + d.x * h * 0.3, tip.y + d.y * h * 0.3);
    c.lineTo(tip.x - d.x * h - n.x * h, tip.y - d.y * h - n.y * h);
    c.stroke();
  }
  c.restore();
}

// ---------- HUD ----------
const dock = Object.fromEntries([...document.querySelectorAll('#dock .item')].map((el) => [el.dataset.g, el]));

function updateHud(t) {
  const stunned = combat.stunned(t);
  dock.GRIP.classList.toggle('active', sword.active);
  dock.GUARD.classList.toggle('active', !!combat.guard);
  $('guard-label').textContent = combat.guard ?? 'GUARD';
  dock.SLASH.classList.toggle('active', t - lastLaunch < 220);
  dock.THRUST.classList.toggle('active', !!sword.thrusting);
  $('stun-vignette').classList.toggle('show', stunned && match.phase === 'fight');

  $('hp-you-fill').style.width = `${combat.hp}%`;
  $('hp-rival-fill').style.width = `${combat.oppHp}%`;
  const ping = rtt == null ? '—' : `${Math.round(rtt)}ms`;
  if (match.phase === 'countdown') {
    const left = Math.ceil((match.phaseAt + UI.countdownMs - t) / 1000);
    $('stat-main').textContent = `ROUND ${match.round}`;
    $('stat-sub').textContent = left > 0 ? left : 'GO';
    if (left > 0 && (!banner || banner.text !== String(left))) showBanner(String(left), 900);
  } else if (match.round) {
    $('stat-main').textContent = `ROUND ${match.round} · ${match.me}–${match.opp}`;
    $('stat-sub').textContent = ping;
  } else {
    $('stat-main').textContent = 'VERSUS';
    $('stat-sub').textContent = ping;
  }

  const b = $('banner');
  if (banner && t < banner.until) {
    if (b.textContent !== banner.text) b.textContent = banner.text;
    b.classList.toggle('small', !!banner.small);
    b.classList.add('show');
  } else b.classList.remove('show');

  let hint = '';
  if (tracker.workerReady && tracker.cameraReady && match.phase !== 'lobby') {
    if (!hand) hint = 'Show one hand to the camera';
    else if (!sword.active) hint = 'Make a fist to draw your sword';
    else if (stunned) hint = 'Stunned!';
    else if (combat.incoming.some((a) => a.kind === 'thrust')) hint = 'Guard break incoming — push to counter';
    else if (combat.incoming.length) hint = 'Tilt your blade to the glowing side — or slash back to parry';
    else if (match.phase === 'fight') hint = 'Tilt to guard  ·  swing → ← ↓ to attack  ·  push to break';
  }
  $('hint').textContent = hint;
  $('hint').classList.toggle('show', !!hint);

  if (debug) {
    $('debug').textContent = [
      `role ${net.role ?? '-'}  room ${net.code ?? '-'}  phase ${match.phase}  ping ${ping}`,
      `infer ${tracker.delegate}  grip ${gesture.state}  sword ${sword.active ? 'ON' : 'off'}  angle ${sword.angle.toFixed(0)}°`,
      `guard ${combat.guard ?? '-'}  stunned ${stunned}  cooldown ${Math.max(0, combat.cooldownUntil - t) | 0}ms`,
      `speed ${sword.speed.toFixed(2)}  thrust approach ${sword.approach.toFixed(2)}`,
      `incoming ${combat.incoming.map((a) => `${a.kind}:${a.side}${a.parried ? '(P)' : ''}`).join(' ') || '-'}`,
      `opp guard ${combat.opp.guard ?? '-'}  hp ${combat.hp} / ${combat.oppHp}`,
    ].join('\n');
  }
}

// ---------- 메인 루프 ----------
let lastT = performance.now();
let lastPose = 0;
function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  combat.update(t);
  handleEvents(t);
  let simDt = dt;
  if (fx.hitstop > 0) { fx.hitstop -= dt * 1000; simDt = 0; }
  fx.update(simDt, dt);
  renderWorld(t, dt);
  sword.render(ctx.sword, view, t, debug);
  updateHud(t);
  if (net.connected && t - lastPose > 1000 / UI.poseHz) {
    lastPose = t;
    net.send({ t: 'pose', guard: combat.guard, angle: sword.angle, active: sword.active, hp: combat.hp, stunned: combat.stunned(t) });
  }
  requestAnimationFrame(loop);
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'd' || e.key === 'D') { debug = !debug; $('debug').classList.toggle('hidden', !debug); }
  else if (e.key === 's' || e.key === 'S') { showSkeleton = !showSkeleton; drawSkeleton(); }
});
$('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

// ---------- 시작 ----------
layout();
tracker.start();
requestAnimationFrame(loop);
showLobbyStart();
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $('join-code').value = roomParam.toUpperCase();
  $('join-form').requestSubmit();
}

// 콘솔 디버깅용 (예: airDuel.match.phase)
window.airDuel = { combat, match, net, sword };
