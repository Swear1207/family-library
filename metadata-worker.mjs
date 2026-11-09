import {parentPort,workerData} from 'node:worker_threads';
import {extractMetadata} from './metadata-extractor.mjs';
try {
  const metadata=await extractMetadata(null,{fd:workerData.fd,size:workerData.size,format:workerData.format,maxPdfPages:3});
  parentPort.postMessage({ok:true,metadata});
} catch { parentPort.postMessage({ok:false}); }
parentPort.close();
