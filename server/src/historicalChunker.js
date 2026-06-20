const crypto = require('crypto');
const { BinaryProtocolParser } = require('./binaryParser');

const DEFAULT_CHUNK_SIZE = 256 * 1024;
const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 2000;

function crc32Buffer(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

class HistoricalChunkEngine {
  constructor(simulator, parser) {
    this.simulator = simulator;
    this.parser = parser;
    this.activeSessions = new Map();
  }

  _generateHistoryBuffer(startNs, endNs, sampleRateHz, includeThermocouple, includePower) {
    const startSec = Number(startNs) / 1e9;
    const endSec = Number(endNs) / 1e9;
    const intervalSec = sampleRateHz > 0 ? 1 / sampleRateHz : 0.00125;
    const totalSamples = Math.floor((endSec - startSec) / intervalSec);
    const recordSize = 8 + 4 + 4;
    const bufSize = totalSamples * recordSize;
    const buf = Buffer.alloc(bufSize);
    let offset = 0;
    for (let i = 0; i < totalSamples; i++) {
      const t = startSec + i * intervalSec;
      const tNs = BigInt(Math.floor(t * 1e9));
      const phase = (t * 7.7) % (Math.PI * 2);
      const phase2 = (t * 53.2) % (Math.PI * 2);
      const baseDT = 1220;
      const noise = (Math.sin(t * 0.3) * 2.1) + (Math.cos(t * 0.17) * 0.9);
      const dT = baseDT + noise;
      const mV = 0.054 * dT + (Math.random() - 0.5) * 0.085 + Math.sin(phase) * 0.032 + Math.sin(phase2) * 0.011;
      const powerW = 4500 * 0.568 * Math.exp(-t * 2.503e-10);
      buf.writeBigInt64BE(tNs, offset);
      buf.writeFloatBE(mV, offset + 8);
      buf.writeFloatBE(powerW, offset + 12);
      offset += recordSize;
    }
    return { buffer: buf, totalSamples, recordSize, sampleRateHz };
  }

  async *streamHistoricalChunks(request) {
    const sessionId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
    const deviceId = request.device_id || 'RTG-DEFAULT';
    const startNs = request.start_timestamp_ns ? BigInt(request.start_timestamp_ns) : (BigInt(Date.now()) * 1000000n - (72n * 3600n * 1000000000n));
    const endNs = request.end_timestamp_ns ? BigInt(request.end_timestamp_ns) : (BigInt(Date.now()) * 1000000n);
    let chunkSize = request.chunk_size_bytes || DEFAULT_CHUNK_SIZE;
    if (chunkSize > MAX_CHUNK_SIZE) chunkSize = MAX_CHUNK_SIZE;
    if (chunkSize < 4096) chunkSize = 4096;
    const sampleRateHz = request.sample_rate_hz || 800;
    const includeThermocouple = request.include_thermocouple !== false;
    const includePower = request.include_power !== false;

    console.log(`[HIST] Session ${sessionId} start: ${startNs} end: ${endNs} rate: ${sampleRateHz}Hz`);

    const { buffer, totalSamples, recordSize } = this._generateHistoryBuffer(
      startNs, endNs, sampleRateHz, includeThermocouple, includePower
    );

    const totalChunks = Math.max(1, Math.ceil(buffer.length / chunkSize));
    const startTime = Date.now();
    let bytesTransferred = 0;
    let sampleCountAccum = 0;

    yield {
      session_id: sessionId.toString(),
      chunk_index: 0,
      total_chunks: totalChunks,
      payload_bytes: 0,
      crc32: 0,
      start_timestamp_ns: startNs.toString(),
      end_timestamp_ns: endNs.toString(),
      sample_count: totalSamples,
      payload: Buffer.alloc(0),
      chunk_type: 'CHUNK_METADATA',
      status: [{
        expected_chunks: totalChunks,
        received_chunks: 0,
        bytes_transferred: 0,
        throughput_mbps: 0,
        retry_count: 0
      }],
      error_message: ''
    };

    let lastHeartbeat = Date.now();
    let chunkIndex = 1;

    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const endOffset = Math.min(offset + chunkSize, buffer.length);
      const chunkData = buffer.subarray(offset, endOffset);
      const samplesInChunk = Math.floor(chunkData.length / recordSize);
      const crc = crc32Buffer(chunkData);
      const elapsedSec = (Date.now() - startTime) / 1000;
      const throughputMbps = elapsedSec > 0 ? (bytesTransferred * 8 / 1e6 / elapsedSec) : 0;
      bytesTransferred += chunkData.length;
      sampleCountAccum += samplesInChunk;

      const firstSampleTs = startNs + BigInt(Math.floor(offset / recordSize) * (1e9 / sampleRateHz));
      const lastSampleTs = startNs + BigInt(Math.floor(endOffset / recordSize - 1) * (1e9 / sampleRateHz));

      yield {
        session_id: sessionId.toString(),
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        payload_bytes: chunkData.length,
        crc32: crc,
        start_timestamp_ns: firstSampleTs.toString(),
        end_timestamp_ns: lastSampleTs.toString(),
        sample_count: samplesInChunk,
        payload: chunkData,
        chunk_type: 'CHUNK_DATA',
        status: [{
          expected_chunks: totalChunks,
          received_chunks: chunkIndex,
          bytes_transferred: bytesTransferred,
          throughput_mbps: throughputMbps,
          retry_count: 0
        }],
        error_message: ''
      };

      chunkIndex++;

      if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        yield {
          session_id: sessionId.toString(),
          chunk_index: chunkIndex - 1,
          total_chunks: totalChunks,
          payload_bytes: 0,
          crc32: 0,
          start_timestamp_ns: firstSampleTs.toString(),
          end_timestamp_ns: lastSampleTs.toString(),
          sample_count: 0,
          payload: Buffer.alloc(0),
          chunk_type: 'CHUNK_HEARTBEAT',
          status: [{
            expected_chunks: totalChunks,
            received_chunks: chunkIndex - 1,
            bytes_transferred: bytesTransferred,
            throughput_mbps: throughputMbps,
            retry_count: 0
          }],
          error_message: ''
        };
        lastHeartbeat = Date.now();
        await new Promise(r => setImmediate(r));
      } else {
        await new Promise(r => setImmediate(r));
      }
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    const throughputMbps = elapsedSec > 0 ? (bytesTransferred * 8 / 1e6 / elapsedSec) : 0;
    console.log(`[HIST] Session ${sessionId} complete: ${bytesTransferred} bytes, ${elapsedSec.toFixed(1)}s, ${throughputMbps.toFixed(2)} Mbps`);

    yield {
      session_id: sessionId.toString(),
      chunk_index: totalChunks + 1,
      total_chunks: totalChunks,
      payload_bytes: 0,
      crc32: crc32Buffer(buffer),
      start_timestamp_ns: startNs.toString(),
      end_timestamp_ns: endNs.toString(),
      sample_count: totalSamples,
      payload: Buffer.alloc(0),
      chunk_type: 'CHUNK_FINAL',
      status: [{
        expected_chunks: totalChunks,
        received_chunks: totalChunks,
        bytes_transferred: bytesTransferred,
        throughput_mbps: throughputMbps,
        retry_count: 0
      }],
      error_message: ''
    };
  }
}

module.exports = { HistoricalChunkEngine, crc32Buffer, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE };
