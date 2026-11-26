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

// 칼을 쥔 주먹 (1인칭): 화면은 이미 좌우 거울이라 점의 2D 위치는 그대로 두고 '앞뒤만' 뒤집는다.
// 카메라는 손가락 안쪽을 보지만 나는 손등을 본다 → 그리는 순서를
//   엄지·손가락(그늘, 칼자루 뒤) → 칼자루 → 손등(맨 앞, 관절 볼록) 으로.
export function drawGripHand(ctx, pts, sword, scale = 1) {
  const c = sword.hilt;
  const p = pts.map((q) => ({ x: c.x + (q.x - c.x) * scale, y: c.y + (q.y - c.y) * scale }));
  const d0 = { x: sword.tip.x - sword.base.x, y: sword.tip.y - sword.base.y };
  const dl = Math.hypot(d0.x, d0.y) || 1;
  const d = { x: d0.x / dl, y: d0.y / dl };
  const n = { x: -d.y, y: d.x };
  const palmW = Math.max(18, Math.hypot(p[5].x - p[17].x, p[5].y - p[17].y));
  // 손등(관절 줄)이 칼자루의 어느 쪽에 있는지: n 방향 부호
  const kn = [5, 9, 13, 17].reduce((a, i) => ({ x: a.x + p[i].x / 4, y: a.y + p[i].y / 4 }), { x: 0, y: 0 });
  const side = Math.sign((kn.x - c.x) * n.x + (kn.y - c.y) * n.y) || 1;
  const at = (along, across) => ({ x: c.x + d.x * along * palmW + n.x * across * palmW * side, y: c.y + d.y * along * palmW + n.y * across * palmW * side });
  const outline = `rgb(${PAL.ink})`, skin = 'rgb(236,226,209)', shade = 'rgb(176,163,143)';
  const capsule = (a, b, w, fill) => {
    for (const [col, lw] of [[outline, w + 3], [fill, w]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  };
  const polygon = (pts2, fill, lw = 3) => {
    ctx.beginPath();
    pts2.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = outline; ctx.lineWidth = lw; ctx.stroke();
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const fw = palmW * 0.24;

  // 1) 뒤쪽: 칼자루 너머로 감긴 손가락 끝(그늘) — 칼자루 반대편으로 살짝만 삐져나옴
  for (let i = 3; i >= 0; i--) {
    const along = 0.33 - i * 0.22;
    capsule(at(along, 0.05), at(along - 0.03, -0.24), fw, shade);
  }
  // 엄지: 손등 반대쪽(칼자루 앞)을 감싸므로 그늘 쪽, 검지 옆 끝만 보임
  capsule(at(0.32, 0.1), at(0.52, -0.12), fw * 0.95, shade);

  // 2) 칼자루를 손가락 위에 다시 그림 → 손가락이 칼자루 뒤로 감긴 것처럼
  const hw = Math.max(4, palmW * 0.13);
  const h0 = at(-0.62, 0), h1 = at(0.5, 0);
  polygon([
    { x: h0.x + n.x * hw, y: h0.y + n.y * hw }, { x: h1.x + n.x * hw, y: h1.y + n.y * hw },
    { x: h1.x - n.x * hw, y: h1.y - n.y * hw }, { x: h0.x - n.x * hw, y: h0.y - n.y * hw },
  ], 'rgb(20,30,62)', 1.5);

  // 3) 맨 앞: 손등 — 손목에서 칼자루 위 관절 줄까지 덮음
  const wrist = p[0];
  const knuckles = [0.36, 0.13, -0.1, -0.32].map((al) => at(al, 0.02));
  polygon([
    at(0.47, 0.06), ...knuckles.map((q) => ({ x: q.x + n.x * palmW * 0.04 * side, y: q.y + n.y * palmW * 0.04 * side })), at(-0.5, 0.1),
    { x: wrist.x - d.x * palmW * 0.32, y: wrist.y - d.y * palmW * 0.32 },
    { x: wrist.x + d.x * palmW * 0.28, y: wrist.y + d.y * palmW * 0.28 },
  ], skin);
  // 관절 볼록: 손등 가장자리의 둥근 혹 네 개 + 손등 힘줄 선
  ctx.fillStyle = skin;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2.5;
  for (const q of knuckles) {
    ctx.beginPath(); ctx.arc(q.x, q.y, palmW * 0.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = `rgba(${PAL.ink},0.35)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const q of knuckles) {
    const w0 = { x: wrist.x + (q.x - wrist.x) * 0.25, y: wrist.y + (q.y - wrist.y) * 0.25 };
    const k0 = { x: q.x + (wrist.x - q.x) * 0.22, y: q.y + (wrist.y - q.y) * 0.22 };
    ctx.moveTo(w0.x, w0.y); ctx.lineTo(k0.x, k0.y);
  }
  ctx.stroke();
  ctx.restore();
}
