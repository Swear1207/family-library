import { parentPort, workerData } from 'node:worker_threads';
import { renderCover } from './cover-renderer.mjs';
try {
  const bytes = await renderCover(workerData);
  parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]);
} catch { parentPort.postMessage({ ok: false }); }
parentPort.close();
