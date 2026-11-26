// MediaPipe Hand Landmarker 추론 전용 Worker (module worker)
// main → { type:'init', bundle, wasmBase, modelUrl } / { type:'frame', bitmap, ts }
// worker → { type:'ready', delegate, connections } / { type:'result', ... } / { type:'delegate' } / { type:'error' }

let mp = null;
let fileset = null;
let landmarker = null;
let delegate = 'GPU';
let modelUrl = '';
let lastTs = -1;

async function create(dlg) {
  return mp.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate: dlg },
    runningMode: 'VIDEO',
    numHands: 1, // 한 손만 처리해서 제스처 충돌 방지
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

async function fallbackToCpu() {
  try { landmarker?.close(); } catch {}
  delegate = 'CPU';
  landmarker = await create('CPU');
  self.postMessage({ type: 'delegate', delegate });
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      modelUrl = msg.modelUrl;
      mp = await import(msg.bundle);
      // module worker에서는 importScripts를 못 쓰므로 module용 WASM 로더 사용
      fileset = await mp.FilesetResolver.forVisionTasks(msg.wasmBase, true);
      try {
        delegate = 'GPU';
        landmarker = await create('GPU');
      } catch (gpuErr) {
        delegate = 'CPU';
        landmarker = await create('CPU');
      }
      self.postMessage({
        type: 'ready',
        delegate,
        connections: mp.HandLandmarker.HAND_CONNECTIONS.map((c) => [c.start, c.end]),
      });
    } catch (err) {
      self.postMessage({ type: 'error', stage: 'model', message: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    const { bitmap } = msg;
    let ts = msg.ts;
    if (ts <= lastTs) ts = lastTs + 0.01; // detectForVideo는 단조 증가 타임스탬프 필요
    lastTs = ts;

    let out = { type: 'result', ts: msg.ts, landmarks: null, world: null, inferMs: 0 };
    if (landmarker) {
      const t0 = performance.now();
      try {
        const res = landmarker.detectForVideo(bitmap, ts);
        if (res.landmarks && res.landmarks.length) {
          out.landmarks = res.landmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z }));
          out.world = res.worldLandmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z }));
        }
      } catch (err) {
        if (delegate === 'GPU') {
          try { await fallbackToCpu(); } catch (e2) {
            self.postMessage({ type: 'error', stage: 'infer', message: String(e2?.message || e2) });
          }
        } else {
          self.postMessage({ type: 'error', stage: 'infer', message: String(err?.message || err) });
        }
      }
      out.inferMs = performance.now() - t0;
    }
    bitmap.close();
    self.postMessage(out);
  }
};
