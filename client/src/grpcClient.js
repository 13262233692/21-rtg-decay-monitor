import { ProtoCodec } from './protoCodec.js';

const PROXY_BASE = '';
const SERVICE_PATH = '/rtgmonitor.RTGMonitorService';

const GRPC_CODES = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16
};

const RETRIABLE_CODES = new Set([
  GRPC_CODES.RESOURCE_EXHAUSTED,
  GRPC_CODES.UNAVAILABLE,
  GRPC_CODES.DEADLINE_EXCEEDED,
  GRPC_CODES.ABORTED,
  GRPC_CODES.INTERNAL,
  GRPC_CODES.UNKNOWN
]);

const DEFAULT_BACKOFF_CONFIG = {
  initialBackoffMs: 100,
  maxBackoffMs: 30000,
  multiplier: 2,
  jitterFactor: 1.0,
  maxRetries: 10,
  resetBackoffAfterMs: 10000
};

function truncatedJitterBackoff(retryCount, config) {
  const { initialBackoffMs, maxBackoffMs, multiplier, jitterFactor } = config;
  const baseDelay = Math.min(initialBackoffMs * Math.pow(multiplier, retryCount), maxBackoffMs);
  const jitter = 0.5 + Math.random() * jitterFactor;
  return Math.floor(baseDelay * jitter);
}

function parseGrpcError(error) {
  let code = GRPC_CODES.UNKNOWN;
  let message = error.message || String(error);
  let serverBackoffMs = null;
  let details = null;

  const codeMatch = message.match(/code[:=]\s*(\d+)/i);
  if (codeMatch) {
    code = parseInt(codeMatch[1], 10);
  }

  const backoffMatch = message.match(/backoff[=:]\s*(\d+)\s*ms/i);
  if (backoffMatch) {
    serverBackoffMs = parseInt(backoffMatch[1], 10);
  }

  const detailsMatch = message.match(/details[:=]\s*"([^"]+)"/i);
  if (detailsMatch) {
    details = detailsMatch[1];
  }

  return { code, message, serverBackoffMs, details, isRetriable: RETRIABLE_CODES.has(code) };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RTGGrpcWebClient {
  constructor(backoffConfig = {}) {
    this.streamAbortControllers = new Set();
    this.backoffConfig = { ...DEFAULT_BACKOFF_CONFIG, ...backoffConfig };
    this.lastSuccessTime = new Map();
    this.retryCounters = new Map();
  }

  _getRetryKey(methodName) {
    return methodName;
  }

  _getRetryCount(methodName) {
    const key = this._getRetryKey(methodName);
    const lastSuccess = this.lastSuccessTime.get(key);
    if (lastSuccess && Date.now() - lastSuccess > this.backoffConfig.resetBackoffAfterMs) {
      this.retryCounters.delete(key);
    }
    return this.retryCounters.get(key) || 0;
  }

  _incrementRetry(methodName) {
    const key = this._getRetryKey(methodName);
    const count = this._getRetryCount(methodName) + 1;
    this.retryCounters.set(key, count);
    return count;
  }

  _resetRetry(methodName) {
    const key = this._getRetryKey(methodName);
    this.retryCounters.delete(key);
    this.lastSuccessTime.set(key, Date.now());
  }

  async _executeWithRetry(methodName, operation) {
    let lastError = null;
    const maxRetries = this.backoffConfig.maxRetries;

    while (true) {
      try {
        const result = await operation();
        this._resetRetry(methodName);
        return result;
      } catch (error) {
        lastError = error;
        const parsed = parseGrpcError(error);

        if (!parsed.isRetriable) {
          this._resetRetry(methodName);
          throw error;
        }

        const retryCount = this._incrementRetry(methodName);
        if (retryCount > maxRetries) {
          this._resetRetry(methodName);
          throw new Error(`Max retries (${maxRetries}) exceeded for ${methodName}: ${error.message}`);
        }

        let delayMs;
        if (parsed.serverBackoffMs !== null) {
          delayMs = parsed.serverBackoffMs;
        } else {
          delayMs = truncatedJitterBackoff(retryCount - 1, this.backoffConfig);
        }

        console.warn(`[grpc-web] Retrying ${methodName} (attempt ${retryCount}/${maxRetries}) after ${delayMs}ms due to: ${parsed.message}`);
        await sleep(delayMs);
      }
    }
  }

  async unary(methodName, requestMessage, encodeReq, decodeResp) {
    return this._executeWithRetry(methodName, async () => {
      const url = `${PROXY_BASE}${SERVICE_PATH}/${methodName}`;
      const body = ProtoCodec.writeGrpcWebFrame(encodeReq(requestMessage));
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
        body
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errorText}`);
      }

      const ab = await resp.arrayBuffer();
      const buf = new Uint8Array(ab);
      const frame = ProtoCodec.readGrpcWebFrame(buf);
      if (frame) {
        if (frame.flags & 0x80) {
          const trailerText = new TextDecoder('utf-8').decode(frame.payload);
          const statusMatch = trailerText.match(/grpc-status:(\d+)/);
          const msgMatch = trailerText.match(/grpc-message:([^\r\n]+)/);
          if (statusMatch) {
            const code = parseInt(statusMatch[1], 10);
            const msg = msgMatch ? decodeURIComponent(msgMatch[1]) : 'gRPC error';
            throw new Error(`gRPC error code=${code} message="${msg}"`);
          }
        }
        let rest = frame.rest;
        while (rest && rest.length >= 5) {
          const tf = ProtoCodec.readGrpcWebFrame(rest);
          if (!tf) break;
          if (tf.flags & 0x80) break;
          rest = tf.rest;
        }
        return decodeResp(frame.payload);
      }
      return null;
    });
  }

  serverStream(methodName, requestMessage, encodeReq, decodeResp, onMessage, onEnd) {
    let currentController = null;
    let closed = false;
    let retryCount = 0;
    const { maxRetries } = this.backoffConfig;

    const performStream = async () => {
      if (closed) return;

      const url = `${PROXY_BASE}${SERVICE_PATH}/${methodName}`;
      const body = ProtoCodec.writeGrpcWebFrame(encodeReq(requestMessage));
      currentController = new AbortController();
      this.streamAbortControllers.add(currentController);

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
          body,
          signal: currentController.signal
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        }

        this._resetRetry(methodName);
        retryCount = 0;

        const reader = resp.body.getReader();
        let buffer = new Uint8Array(0);

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;

          const newBuf = new Uint8Array(buffer.length + value.length);
          newBuf.set(buffer, 0);
          newBuf.set(value, buffer.length);
          buffer = newBuf;

          while (true) {
            const frame = ProtoCodec.readGrpcWebFrame(buffer);
            if (!frame) break;

            if (frame.flags & 0x80) {
              const trailerText = new TextDecoder('utf-8').decode(frame.payload);
              const statusMatch = trailerText.match(/grpc-status:(\d+)/);
              if (statusMatch && statusMatch[1] !== '0') {
                const msgMatch = trailerText.match(/grpc-message:([^\r\n]+)/);
                const msg = msgMatch ? decodeURIComponent(msgMatch[1]) : 'Stream error';
                throw new Error(`gRPC stream error code=${statusMatch[1]} message="${msg}"`);
              }
              buffer = frame.rest;
              continue;
            }

            try {
              const decoded = decodeResp(frame.payload);
              onMessage(decoded);
            } catch (e) {
              console.warn('[grpc-web] decode err', e);
            }
            buffer = frame.rest;
          }
        }

        if (!closed) {
          onEnd && onEnd(null);
        }
      } catch (error) {
        if (closed || error.name === 'AbortError') {
          onEnd && onEnd(null);
          return;
        }

        const parsed = parseGrpcError(error);
        if (!parsed.isRetriable || retryCount >= maxRetries) {
          console.error(`[grpc-web] Stream ${methodName} failed permanently:`, error);
          onEnd && onEnd(error);
          return;
        }

        retryCount++;
        let delayMs;
        if (parsed.serverBackoffMs !== null) {
          delayMs = parsed.serverBackoffMs;
        } else {
          delayMs = truncatedJitterBackoff(retryCount - 1, this.backoffConfig);
        }

        console.warn(`[grpc-web] Stream ${methodName} reconnecting (attempt ${retryCount}/${maxRetries}) after ${delayMs}ms: ${parsed.message}`);
        await sleep(delayMs);

        if (!closed) {
          performStream();
        }
      } finally {
        if (currentController) {
          this.streamAbortControllers.delete(currentController);
        }
      }
    };

    performStream();

    return () => {
      closed = true;
      if (currentController) {
        try { currentController.abort(); } catch {}
        this.streamAbortControllers.delete(currentController);
      }
    };
  }

  async streamHistoricalBurst(request, options = {}) {
    const {
      onProgress,
      onChunk,
      maxChunkRetries = 3
    } = options;

    return this._executeWithRetry('StreamHistoricalBurst', async () => {
      const chunks = new Map();
      const failedChunks = new Set();
      let metadata = null;
      let totalChunks = null;
      let startTime = Date.now();
      let bytesReceived = 0;
      let currentAbortController = null;

      const receiveStream = () => new Promise((resolve, reject) => {
        const url = `${PROXY_BASE}${SERVICE_PATH}/StreamHistoricalBurst`;
        const body = ProtoCodec.writeGrpcWebFrame(ProtoCodec.encodeHistoricalRequest(request));
        currentAbortController = new AbortController();
        this.streamAbortControllers.add(currentAbortController);

        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
          body,
          signal: currentAbortController.signal
        }).then(async (resp) => {
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          }

          const reader = resp.body.getReader();
          let buffer = new Uint8Array(0);

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const newBuf = new Uint8Array(buffer.length + value.length);
            newBuf.set(buffer, 0);
            newBuf.set(value, buffer.length);
            buffer = newBuf;

            while (true) {
              const frame = ProtoCodec.readGrpcWebFrame(buffer);
              if (!frame) break;

              if (frame.flags & 0x80) {
                const trailerText = new TextDecoder('utf-8').decode(frame.payload);
                const statusMatch = trailerText.match(/grpc-status:(\d+)/);
                if (statusMatch && statusMatch[1] !== '0') {
                  const msgMatch = trailerText.match(/grpc-message:([^\r\n]+)/);
                  const msg = msgMatch ? decodeURIComponent(msgMatch[1]) : 'Stream error';
                  reject(new Error(`gRPC stream error code=${statusMatch[1]} message="${msg}"`));
                  return;
                }
                buffer = frame.rest;
                continue;
              }

              try {
                const chunk = ProtoCodec.decodeHistoricalChunk(frame.payload);
                bytesReceived += chunk.payload ? chunk.payload.length : 0;

                if (chunk.chunk_type === 'CHUNK_METADATA') {
                  metadata = JSON.parse(new TextDecoder('utf-8').decode(chunk.payload));
                  totalChunks = chunk.total_chunks;
                  if (onProgress) {
                    onProgress({
                      type: 'metadata',
                      metadata,
                      totalChunks,
                      sessionId: chunk.session_id
                    });
                  }
                } else if (chunk.chunk_type === 'CHUNK_DATA') {
                  const expectedCrc = chunk.crc32;
                  const actualCrc = chunk.payload ? ProtoCodec.crc32(chunk.payload) : 0;

                  if (expectedCrc !== 0 && actualCrc !== expectedCrc) {
                    console.warn(`[historical] CRC mismatch for chunk ${chunk.chunk_index}: expected=${expectedCrc}, actual=${actualCrc}`);
                    failedChunks.add(chunk.chunk_index);
                  } else {
                    chunks.set(chunk.chunk_index, chunk);
                    if (failedChunks.has(chunk.chunk_index)) {
                      failedChunks.delete(chunk.chunk_index);
                    }
                  }

                  if (onChunk) {
                    onChunk({
                      chunk,
                      verified: actualCrc === expectedCrc,
                      receivedCount: chunks.size,
                      totalChunks,
                      bytesReceived,
                      throughput: bytesReceived / ((Date.now() - startTime) / 1000)
                    });
                  }

                  if (onProgress && totalChunks !== null) {
                    onProgress({
                      type: 'progress',
                      percent: (chunks.size / totalChunks) * 100,
                      received: chunks.size,
                      total: totalChunks,
                      bytesReceived,
                      throughput: bytesReceived / ((Date.now() - startTime) / 1000),
                      failedCount: failedChunks.size
                    });
                  }
                } else if (chunk.chunk_type === 'CHUNK_FINAL') {
                  const finalCrc = chunk.crc32;
                  if (finalCrc !== 0) {
                    let fullData = new Uint8Array(0);
                    const sortedChunks = Array.from(chunks.values()).sort((a, b) => a.chunk_index - b.chunk_index);
                    for (const c of sortedChunks) {
                      if (c.payload) {
                        const combined = new Uint8Array(fullData.length + c.payload.length);
                        combined.set(fullData, 0);
                        combined.set(c.payload, fullData.length);
                        fullData = combined;
                      }
                    }
                    const actualFullCrc = ProtoCodec.crc32(fullData);
                    if (actualFullCrc !== finalCrc) {
                      throw new Error(`Full data CRC mismatch: expected=${finalCrc}, actual=${actualFullCrc}`);
                    }
                  }

                  if (failedChunks.size > 0) {
                    throw new Error(`${failedChunks.size} chunks failed verification: ${Array.from(failedChunks).join(', ')}`);
                  }

                  const duration = (Date.now() - startTime) / 1000;
                  const result = {
                    sessionId: chunk.session_id,
                    chunkCount: chunks.size,
                    totalBytes: bytesReceived,
                    duration,
                    throughput: bytesReceived / duration,
                    metadata,
                    chunks: Array.from(chunks.values()).sort((a, b) => a.chunk_index - b.chunk_index)
                  };

                  if (onProgress) {
                    onProgress({
                      type: 'complete',
                      ...result
                    });
                  }

                  resolve(result);
                  return;
                } else if (chunk.chunk_type === 'CHUNK_ERROR') {
                  const errorMsg = new TextDecoder('utf-8').decode(chunk.payload);
                  reject(new Error(`Server error: ${errorMsg}`));
                  return;
                } else if (chunk.chunk_type === 'CHUNK_REJECT') {
                  const rejectMsg = new TextDecoder('utf-8').decode(chunk.payload);
                  reject(new Error(`Connection rejected: ${rejectMsg}`));
                  return;
                } else if (chunk.chunk_type === 'CHUNK_HEARTBEAT') {
                  if (onProgress) {
                    onProgress({
                      type: 'heartbeat',
                      sessionId: chunk.session_id,
                      bytesReceived,
                      elapsed: (Date.now() - startTime) / 1000
                    });
                  }
                }
              } catch (e) {
                console.warn('[historical] chunk decode err', e);
              }
              buffer = frame.rest;
            }
          }

          resolve(null);
        }).catch(err => {
          if (err.name === 'AbortError') {
            resolve(null);
          } else {
            reject(err);
          }
        }).finally(() => {
          if (currentAbortController) {
            this.streamAbortControllers.delete(currentAbortController);
          }
        });
      });

      return receiveStream();
    });
  }

  streamRTGData(deviceId, onMsg, onEnd) {
    return this.serverStream(
      'StreamRTGData',
      { device_id: deviceId, sample_rate_hz: 20 },
      ProtoCodec.encodeStreamRequest.bind(ProtoCodec),
      ProtoCodec.decodeRTGDataPoint.bind(ProtoCodec),
      onMsg, onEnd
    );
  }

  streamThermocoupleWave(deviceId, onMsg, onEnd) {
    return this.serverStream(
      'StreamThermocoupleWave',
      { device_id: deviceId, sample_rate_hz: 800 },
      ProtoCodec.encodeStreamRequest.bind(ProtoCodec),
      ProtoCodec.decodeThermocoupleSample.bind(ProtoCodec),
      onMsg, onEnd
    );
  }

  async getSnapshot(deviceId) {
    return this.unary(
      'GetRTGSnapshot',
      { device_id: deviceId },
      ProtoCodec.encodeSnapshotRequest.bind(ProtoCodec),
      ProtoCodec.decodeRTGSnapshot.bind(ProtoCodec)
    );
  }

  closeAll() {
    this.streamAbortControllers.forEach(c => { try { c.abort(); } catch {} });
    this.streamAbortControllers.clear();
  }
}
