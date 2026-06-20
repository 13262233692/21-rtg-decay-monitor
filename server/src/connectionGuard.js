const MAX_CONCURRENT_STREAMS = 64;
const MAX_CONNECTIONS_PER_IP = 16;
const RATE_LIMIT_WINDOW_MS = 1000;
const MAX_NEW_CONNECTIONS_PER_WINDOW = 32;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 10;
const CIRCUIT_BREAKER_HALF_OPEN_MAX = 3;
const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 30000;

class TokenBucket {
  constructor(capacity, refillPerSecond) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSecond = refillPerSecond;
    this.lastRefill = Date.now();
  }
  tryConsume(n = 1) {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

class CircuitBreaker {
  constructor() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
  allow() {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= CIRCUIT_BREAKER_RESET_TIMEOUT_MS) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        return true;
      }
      return false;
    }
    if (this.state === 'HALF_OPEN' && this.successCount >= CIRCUIT_BREAKER_HALF_OPEN_MAX) {
      this.state = 'CLOSED';
      this.failureCount = 0;
    }
    return true;
  }
  onSuccess() {
    if (this.state === 'HALF_OPEN') this.successCount++;
    if (this.failureCount > 0) this.failureCount = Math.max(0, this.failureCount - 0.5);
  }
  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      this.state = 'OPEN';
    }
  }
}

class ConnectionGuard {
  constructor() {
    this.totalStreams = new Set();
    this.ipConnections = new Map();
    this.ipTokenBuckets = new Map();
    this.globalBucket = new TokenBucket(MAX_NEW_CONNECTIONS_PER_WINDOW * 10, MAX_NEW_CONNECTIONS_PER_WINDOW);
    this.circuitBreaker = new CircuitBreaker();
    this.rejectionCount = 0;
    this.lastRejectionLog = 0;
  }

  _extractIp(peer) {
    try {
      const parts = peer.split(':');
      if (parts.length >= 2) return parts[parts.length - 2];
      return peer;
    } catch { return peer; }
  }

  allowIncoming(peer, streamType) {
    const ip = this._extractIp(peer);
    const now = Date.now();

    if (!this.circuitBreaker.allow()) {
      this.rejectionCount++;
      if (now - this.lastRejectionLog > 1000) {
        console.log(`[GUARD] Circuit breaker OPEN, rejecting ${peer}`);
        this.lastRejectionLog = now;
      }
      return { allowed: false, reason: 'CIRCUIT_OPEN', retryBackoff: 5000 + Math.random() * 5000 };
    }

    if (!this.globalBucket.tryConsume()) {
      this.circuitBreaker.onFailure();
      return { allowed: false, reason: 'GLOBAL_RATE_LIMIT', retryBackoff: 1000 + Math.random() * 1000 };
    }

    let ipBucket = this.ipTokenBuckets.get(ip);
    if (!ipBucket) {
      ipBucket = new TokenBucket(MAX_CONNECTIONS_PER_IP, 5);
      this.ipTokenBuckets.set(ip, ipBucket);
    }
    if (!ipBucket.tryConsume()) {
      this.circuitBreaker.onFailure();
      return { allowed: false, reason: 'IP_RATE_LIMIT', retryBackoff: 2000 + Math.random() * 3000 };
    }

    const ipCount = this.ipConnections.get(ip) || 0;
    if (ipCount >= MAX_CONNECTIONS_PER_IP) {
      this.circuitBreaker.onFailure();
      return { allowed: false, reason: 'IP_CONNECTION_LIMIT', retryBackoff: 3000 + Math.random() * 5000 };
    }

    if (this.totalStreams.size >= MAX_CONCURRENT_STREAMS) {
      this.circuitBreaker.onFailure();
      return { allowed: false, reason: 'GLOBAL_CONNECTION_LIMIT', retryBackoff: 5000 + Math.random() * 10000 };
    }

    this.circuitBreaker.onSuccess();
    const streamId = Symbol.for(`${peer}-${Date.now()}-${Math.random()}`);
    this.totalStreams.add(streamId);
    this.ipConnections.set(ip, ipCount + 1);
    return {
      allowed: true,
      streamId,
      config: {
        maxMessageSize: 64 * 1024 * 1024,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
        initialBackoffMs: 250,
        maxBackoffMs: 60000,
        backoffMultiplier: 2.0,
        jitterFactor: 0.5,
        maxRetries: 10
      }
    };
  }

  release(streamId, peer) {
    if (streamId) this.totalStreams.delete(streamId);
    if (peer) {
      const ip = this._extractIp(peer);
      const count = this.ipConnections.get(ip) || 0;
      if (count > 0) this.ipConnections.set(ip, count - 1);
    }
  }

  reportSuccess() { this.circuitBreaker.onSuccess(); }
  reportFailure() { this.circuitBreaker.onFailure(); }

  getStats() {
    return {
      totalStreams: this.totalStreams.size,
      ipsTracked: this.ipConnections.size,
      rejections: this.rejectionCount,
      circuitState: this.circuitBreaker.state,
      failureCount: this.circuitBreaker.failureCount
    };
  }
}

module.exports = {
  ConnectionGuard,
  TokenBucket,
  CircuitBreaker,
  MAX_CONCURRENT_STREAMS,
  MAX_CONNECTIONS_PER_IP
};
