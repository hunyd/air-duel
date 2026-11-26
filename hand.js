// 메인 화면의 내 손: 점·선 뼈대 대신 외곽선이 있는 손 형태로 그린다 (좌표는 손 인식 그대로).
// 획 몇 개만 쓰므로 가볍고, 새 추론 결과가 올 때만 다시 그린다.
import { PAL } from './palette.js';

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const PALM = [0, 1, 2, 5, 9, 13, 17];

// pts: 화면 좌표 21개, center: 축소 기준점, scale: 크기 배율
export function drawHand(ctx, pts, center, scale = 1) {
  const p = pts.map((q) => ({ x: center.x + (q.x - center.x) * scale, y: center.y + (q.y - center.y) * scale }));
  const palmW = Math.hypot(p[5].x - p[17].x, p[5].y - p[17].y);
  const fw = Math.max(5, palmW * 0.26); // 손가락 굵기
  const outline = `rgb(${PAL.ink})`, fill = 'rgb(232,224,210)';

  const strokeFingers = (color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const f of FINGERS) {
      const base = f[0] === 1 ? p[1] : p[f[0]];
      ctx.moveTo(base.x, base.y);
      for (const i of f.slice(1)) ctx.lineTo(p[i].x, p[i].y);
    }
    ctx.stroke();
  };
  const palmPath = () => {
    ctx.beginPath();
    PALM.forEach((i, k) => (k ? ctx.lineTo(p[i].x, p[i].y) : ctx.moveTo(p[i].x, p[i].y)));
    ctx.closePath();
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 1) 먹 외곽: 손가락은 굵게, 손바닥은 테두리째
  strokeFingers(outline, fw + 4);
  palmPath();
  ctx.lineWidth = 4;
  ctx.strokeStyle = outline;
  ctx.fillStyle = outline;
  ctx.fill();
  ctx.stroke();
  // 2) 안쪽 살색(한지 톤)으로 덮어 외곽선만 남김
  palmPath();
  ctx.fillStyle = fill;
  ctx.fill();
  strokeFingers(fill, fw);
  // 3) 손바닥과 손가락 경계에 옅은 먹선 (형태가 읽히게)
  ctx.strokeStyle = `rgba(${PAL.ink},0.35)`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const i of [5, 9, 13, 17]) { ctx.moveTo(p[i].x, p[i].y); ctx.lineTo(p[i + 1].x, p[i + 1].y); }
  ctx.stroke();
  ctx.restore();
}

// 칼을 쥔 주먹 (1인칭): 손 인식 점이 아니라 '칼자루'(위치·방향·palmPx)를 기준으로 그린 정형화된 주먹.
// 카메라는 손가락 안쪽을 보지만 플레이어는 손등을 본다 → 화면에는 '내 눈에 보이는 손'을 그린다:
//   칼자루 너머로 살짝 나온 손가락 끝(그늘) → 칼자루 → 팔뚝(흐려지며 사라짐) → 둥근 손등(관절 줄) → 엄지(맨 위).
// 손 점은 손등이 칼자루의 어느 쪽에 있는지(한 비트)만 쓰므로 인식이 떨려도 모양은 흔들리지 않는다.
export function drawGripHand(ctx, pts, sword) {
  const c = sword.hilt;
  const d0 = { x: sword.tip.x - sword.base.x, y: sword.tip.y - sword.base.y };
  const dl = Math.hypot(d0.x, d0.y) || 1;
  const d = { x: d0.x / dl, y: d0.y / dl };
  const n = { x: -d.y, y: d.x };
  const palmW = Math.max(18, (sword.palmPx || 60) * 0.72);
  // 손등 방향: 관절(5,9,13,17) 평균이 칼자루의 어느 쪽인지. 경계에서 깜빡이지 않게 히스테리시스
  const kn = [5, 9, 13, 17].reduce((a, i) => ({ x: a.x + pts[i].x / 4, y: a.y + pts[i].y / 4 }), { x: 0, y: 0 });
  const proj = ((kn.x - c.x) * n.x + (kn.y - c.y) * n.y) / palmW;
  if (!sword.gripSide || proj * sword.gripSide < -0.12) sword.gripSide = proj < 0 ? -1 : 1;
  const side = sword.gripSide;
  // at(along, across): along = 칼끝 방향, across = 손등(손목) 방향, 단위는 손바닥 폭
  const at = (along, across) => ({ x: c.x + d.x * along * palmW + n.x * across * palmW * side, y: c.y + d.y * along * palmW + n.y * across * palmW * side });
  const N = { x: n.x * side, y: n.y * side }; // 손목 쪽 단위 벡터
  const outline = `rgb(${PAL.ink})`;
  const hwPx = Math.max(4, (sword.fullLen || palmW * 4) * 0.032) * 0.8; // 칼자루 반폭 (sword.js와 같은 식)
  const hwA = hwPx / palmW;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 1) 칼자루 너머(먼 쪽)로 살짝 나온 손가락 끝 — 그늘색, 칼자루 뒤
  const fw = palmW * 0.22;
  for (let i = 0; i < 4; i++) {
    const al = 0.34 - i * 0.23;
    const a = at(al, 0), b = at(al - 0.02, -hwA - 0.09);
    for (const [col, lw] of [[outline, fw + 3], ['rgb(150,132,112)', fw]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  // 칼자루를 손가락 위에 다시 그림 → 손가락이 칼자루 뒤로 감겨 들어간 것처럼
  const h0 = at(-0.6, 0), h1 = at(0.55, 0);
  ctx.fillStyle = 'rgb(20,30,62)';
  ctx.beginPath();
  ctx.moveTo(h0.x + n.x * hwPx, h0.y + n.y * hwPx); ctx.lineTo(h1.x + n.x * hwPx, h1.y + n.y * hwPx);
  ctx.lineTo(h1.x - n.x * hwPx, h1.y - n.y * hwPx); ctx.lineTo(h0.x - n.x * hwPx, h0.y - n.y * hwPx);
  ctx.closePath(); ctx.fill();

  // 2) 바닥 그림자 (손등 + 엄지 덩어리를 오른쪽 아래로)
  const knuck = [0.36, 0.12, -0.12, -0.36];
  const dorsum = (close) => {
    // 관절 쪽 가장자리: 볼록한 관절 네 개가 물결처럼, 양옆은 손목 쪽으로 좁아지는 둥근 곡선
    const p = at(0.5, 0.16);
    ctx.moveTo(p.x, p.y);
    knuck.forEach((al, i) => {
      const peak = at(al, -0.1 + (i === 0 ? 0.02 : 0)), valley = at(al - 0.12, 0.04);
      const end = i === 3 ? at(-0.52, 0.16) : valley;
      ctx.quadraticCurveTo(peak.x, peak.y, end.x, end.y);
    });
    const s0 = at(-0.66, 0.55), w0 = at(-0.38, 1.0);
    ctx.quadraticCurveTo(s0.x, s0.y, w0.x, w0.y);
    if (close) {
      const w1 = at(0.3, 1.0), s1 = at(0.64, 0.5);
      ctx.lineTo(w1.x, w1.y);
      ctx.quadraticCurveTo(s1.x, s1.y, p.x, p.y);
      ctx.closePath();
    }
  };
  const thumbRoot = at(0.38, 0.62), thumbTip = at(0.6, -0.12);
  const sh = palmW * 0.08;
  ctx.save();
  ctx.translate(sh, sh * 1.4);
  ctx.fillStyle = `rgba(${PAL.ink},0.14)`;
  ctx.beginPath(); dorsum(true); ctx.fill();
  ctx.restore();

  // 3) 팔뚝: 손목에서 손등 반대쪽으로 이어지다 흐려지며 사라짐 (잘린 면이 안 보이게)
  const fa0 = at(-0.04, 0.85), fa1 = at(-0.04, 2.1);
  const fg = ctx.createLinearGradient(fa0.x, fa0.y, fa1.x, fa1.y);
  fg.addColorStop(0, 'rgba(196,178,154,1)'); fg.addColorStop(1, 'rgba(196,178,154,0)');
  const fe = ctx.createLinearGradient(fa0.x, fa0.y, fa1.x, fa1.y);
  fe.addColorStop(0, `rgba(${PAL.ink},0.9)`); fe.addColorStop(1, `rgba(${PAL.ink},0)`);
  const fl0 = at(-0.4, 0.9), fl1 = at(-0.46, 2.1), fr0 = at(0.32, 0.9), fr1 = at(0.4, 2.1);
  ctx.beginPath(); ctx.moveTo(fl0.x, fl0.y); ctx.lineTo(fl1.x, fl1.y); ctx.lineTo(fr1.x, fr1.y); ctx.lineTo(fr0.x, fr0.y); ctx.closePath();
  ctx.fillStyle = fg; ctx.fill();
  ctx.strokeStyle = fe; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(fl0.x, fl0.y); ctx.lineTo(fl1.x, fl1.y); ctx.moveTo(fr0.x, fr0.y); ctx.lineTo(fr1.x, fr1.y); ctx.stroke();

  // 4) 손등: 둥근 덩어리 — 왼쪽 위에서 빛을 받는 방사형 음영
  const lc = at(-0.02, 0.4);
  const rg = ctx.createRadialGradient(lc.x - palmW * 0.18, lc.y - palmW * 0.22, palmW * 0.05, lc.x, lc.y, palmW * 0.85);
  rg.addColorStop(0, 'rgb(250,242,228)'); rg.addColorStop(0.55, 'rgb(222,206,182)'); rg.addColorStop(1, 'rgb(170,150,126)');
  ctx.beginPath(); dorsum(true);
  ctx.fillStyle = rg; ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 2.5;
  ctx.beginPath(); dorsum(false);
  const w1 = at(0.3, 1.0), s1 = at(0.64, 0.5), p0 = at(0.5, 0.16);
  ctx.moveTo(w1.x, w1.y); ctx.quadraticCurveTo(s1.x, s1.y, p0.x, p0.y);
  ctx.stroke();
  // 관절 하이라이트 + 손목 쪽으로 모이는 옅은 힘줄
  ctx.fillStyle = 'rgba(255,252,244,0.4)';
  for (const al of knuck) {
    const q = at(al, 0.07);
    ctx.beginPath(); ctx.ellipse(q.x, q.y, palmW * 0.08, palmW * 0.045, Math.atan2(d.y, d.x), 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(150,128,104,0.45)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  knuck.forEach((al, i) => { const a = at(al, 0.12), b = at(0.08 - i * 0.1, 0.8); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(at(al * 0.6, 0.45).x, at(al * 0.6, 0.45).y, b.x, b.y); });
  ctx.stroke();

  // 5) 엄지: 손등 앞쪽 가장자리에서 칼자루를 넘어 검지 옆까지 — 뿌리는 굵고 끝은 둥글게, 맨 위
  const tx = thumbTip.x - thumbRoot.x, ty = thumbTip.y - thumbRoot.y, tl = Math.hypot(tx, ty) || 1;
  const tp = { x: -ty / tl, y: tx / tl };
  const r0 = palmW * 0.17, r1 = palmW * 0.12;
  const thumbPath = () => {
    ctx.beginPath();
    ctx.moveTo(thumbRoot.x + tp.x * r0, thumbRoot.y + tp.y * r0);
    ctx.lineTo(thumbTip.x + tp.x * r1, thumbTip.y + tp.y * r1);
    const ang = Math.atan2(tp.y, tp.x);
    ctx.arc(thumbTip.x, thumbTip.y, r1, ang, ang + Math.PI, true);
    ctx.lineTo(thumbRoot.x - tp.x * r0, thumbRoot.y - tp.y * r0);
  };
  ctx.save();
  ctx.translate(sh * 0.6, sh * 0.8);
  ctx.fillStyle = `rgba(${PAL.ink},0.18)`;
  thumbPath(); ctx.fill();
  ctx.restore();
  let px = tp.x, py = tp.y;
  if (px + py > 0) { px = -px; py = -py; } // 밝은 쪽을 왼쪽 위로
  const tm = { x: (thumbRoot.x + thumbTip.x) / 2, y: (thumbRoot.y + thumbTip.y) / 2 };
  const tg = ctx.createLinearGradient(tm.x + px * r0, tm.y + py * r0, tm.x - px * r0, tm.y - py * r0);
  tg.addColorStop(0, 'rgb(214,196,172)'); tg.addColorStop(0.3, 'rgb(248,239,224)'); tg.addColorStop(1, 'rgb(172,152,128)');
  thumbPath();
  ctx.fillStyle = tg; ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 2.5; ctx.stroke();
  // 손톱 + 마디 주름
  const nl = { x: thumbTip.x - tx / tl * r1 * 0.5, y: thumbTip.y - ty / tl * r1 * 0.5 };
  ctx.fillStyle = 'rgba(255,244,236,0.95)';
  ctx.strokeStyle = `rgba(${PAL.ink},0.5)`; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(nl.x, nl.y, r1 * 0.55, r1 * 0.75, Math.atan2(ty, tx), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  const jm = { x: thumbRoot.x + tx * 0.5, y: thumbRoot.y + ty * 0.5 }, jr = (r0 + r1) / 2 * 0.7;
  ctx.beginPath(); ctx.moveTo(jm.x - tp.x * jr, jm.y - tp.y * jr); ctx.lineTo(jm.x + tp.x * jr, jm.y + tp.y * jr); ctx.stroke();
  ctx.restore();
}
