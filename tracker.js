// 카메라 + MediaPipe 추론 Worker (멀티플레이에서 사용, 싱글 main.js와 같은 방식)
// - 최신 프레임 하나만 처리 (워커가 바쁘면 프레임 버림)
// - requestVideoFrameCallback, 추론 입력 축소, GPU 실패 시 워커가 CPU로 전환

const MP_VERSION = '1.2.3';
export const TRACKER_CONFIG = {
  bundle: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`,
  wasmBase: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`,
  modelUrl: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  inferWidth: 640,
  modelTimeoutMs: 45000,
  workerStallMs: 2000,
};
const C = TRACKER_CONFIG;

export class HandTracker {
  // onResult({ ts, landmarks, world, inferMs }), onStatus(text, kind, retryFn, fadeMs)
  constructor(video, { onResult, onStatus, onReady }) {
    this.video = video;
    this.onResult = onResult;
    this.onStatus = onStatus;
    this.onReady = onReady;
    this.worker = null;
    this.workerReady = false;
    this.cameraReady = false;
    this.busy = false;
    this.busySince = 0;
    this.lastSentTs = 0;
    this.delegate = '-';
    this.connections = [];
    this.modelTimer = 0;
  }

  start() {
    this.startWorker();
    this.startCamera();
  }

  readyStatus() {
    if (this.workerReady && this.cameraReady) this.onStatus(`Ready · ${this.delegate}`, 'ok', null, 2500);
  }

  async startCamera() {
    const v = this.video;
    this.onStatus('Requesting camera…', 'busy');
    try {
      v.srcObject?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' },
        audio: false,
      });
      v.srcObject = stream;
      await v.play();
      await new Promise((r) => (v.videoWidth ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
      this.cameraReady = true;
      this.onReady?.();
      this.schedule();
      if (!this.workerReady) this.onStatus('Loading hand model…', 'busy');
      this.readyStatus();
    } catch (err) {
      this.cameraReady = false;
      const msg =
        err.name === 'NotAllowedError' ? 'Camera blocked — allow access in the address bar' :
        err.name === 'NotFoundError' ? 'No camera found' :
        err.name === 'NotReadableError' ? 'Camera is in use by another app' :
        !window.isSecureContext ? 'Camera needs HTTPS or localhost' :
        'Camera error';
      this.onStatus(msg, 'error', () => this.startCamera());
    }
  }

  startWorker() {
    this.worker?.terminate();
    this.workerReady = false;
    this.busy = false;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      clearTimeout(this.modelTimer);
      this.onStatus('Model failed to load', 'error', () => this.startWorker());
      console.error(e);
    };
    this.worker.postMessage({ type: 'init', bundle: C.bundle, wasmBase: C.wasmBase, modelUrl: C.modelUrl });
    clearTimeout(this.modelTimer);
    this.modelTimer = setTimeout(() => {
      if (!this.workerReady) this.onStatus('Model is taking too long', 'error', () => this.startWorker());
    }, C.modelTimeoutMs);
  }

  onWorkerMessage(m) {
    if (m.type === 'ready') {
      clearTimeout(this.modelTimer);
      this.workerReady = true;
      this.delegate = m.delegate;
      this.connections = m.connections;
      this.readyStatus();
    } else if (m.type === 'delegate') {
      this.delegate = m.delegate;
      this.onStatus(`Switched to ${m.delegate}`, 'ok', null, 2500);
    } else if (m.type === 'error') {
      if (m.stage === 'model') this.onStatus('Model failed to load', 'error', () => this.startWorker());
      console.error('[worker]', m.message);
    } else if (m.type === 'result') {
      this.busy = false;
      this.onResult(m);
    }
  }

  async pump() {
    const v = this.video;
    if (!this.workerReady || !this.cameraReady || v.readyState < 2) return;
    if (this.busy) {
      if (performance.now() - this.busySince > C.workerStallMs) this.busy = false;
      else return;
    }
    this.busy = true;
    this.busySince = performance.now();
    let ts = performance.now();
    if (ts <= this.lastSentTs) ts = this.lastSentTs + 0.01;
    this.lastSentTs = ts;
    const iw = C.inferWidth;
    const ih = Math.round((iw * v.videoHeight) / v.videoWidth);
    try {
      const bitmap = await createImageBitmap(v, { resizeWidth: iw, resizeHeight: ih, resizeQuality: 'low' });
      this.worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]);
    } catch {
      this.busy = false;
    }
  }

  schedule() {
    const next = () => { this.pump(); this.schedule(); };
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) this.video.requestVideoFrameCallback(next);
    else requestAnimationFrame(next);
  }
}
