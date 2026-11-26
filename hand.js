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

