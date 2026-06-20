import { ProtoCodec } from './protoCodec.js';

const PROXY_BASE = '';
const SERVICE_PATH = '/rtgmonitor.RTGMonitorService';

export class RTGGrpcWebClient {
  constructor() {
    this.streamAbortControllers = new Set();
  }

  async unary(methodName, requestMessage, encodeReq, decodeResp) {
    const url = `${PROXY_BASE}${SERVICE_PATH}/${methodName}`;
    const body = ProtoCodec.writeGrpcWebFrame(encodeReq(requestMessage));
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body
    });
    const ab = await resp.arrayBuffer();
    const buf = new Uint8Array(ab);
    const frame = ProtoCodec.readGrpcWebFrame(buf);
    if (frame) {
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
  }

  serverStream(methodName, requestMessage, encodeReq, decodeResp, onMessage, onEnd) {
    const url = `${PROXY_BASE}${SERVICE_PATH}/${methodName}`;
    const body = ProtoCodec.writeGrpcWebFrame(encodeReq(requestMessage));
    const controller = new AbortController();
    this.streamAbortControllers.add(controller);

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body,
      signal: controller.signal
    }).then(async (resp) => {
      const reader = resp.body.getReader();
      let buffer = new Uint8Array(0);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const newBuf = new Uint8Array(buffer.length + value.length);
          newBuf.set(buffer, 0); newBuf.set(value, buffer.length);
          buffer = newBuf;
          while (true) {
            const frame = ProtoCodec.readGrpcWebFrame(buffer);
            if (!frame) break;
            if (frame.flags & 0x80) {
              buffer = frame.rest;
              continue;
            }
            try {
              const decoded = decodeResp(frame.payload);
              onMessage(decoded);
            } catch (e) { console.warn('[grpc-web] decode err', e); }
            buffer = frame.rest;
          }
        }
        onEnd && onEnd(null);
      } catch (e) {
        if (e.name !== 'AbortError') onEnd && onEnd(e);
        else onEnd && onEnd(null);
      } finally {
        this.streamAbortControllers.delete(controller);
      }
    }).catch(e => {
      if (e.name !== 'AbortError') onEnd && onEnd(e);
      this.streamAbortControllers.delete(controller);
    });

    return () => {
      try { controller.abort(); } catch {}
      this.streamAbortControllers.delete(controller);
    };
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
