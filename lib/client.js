'use strict';

const { API_BASE_URL, APPLICATION_ID } = require('./constants');

class HeatzyError extends Error {
  constructor(message, { status = 0, code = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HeatzyError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Minimal Heatzy (Gizwits) API client: login, bindings, devdata, control.
 * Handles token expiry (automatic re-login) with no external dependency.
 */
class HeatzyClient {
  constructor({ username, password, log, baseUrl = API_BASE_URL, fetchImpl, timeoutMs = 20000 }) {
    this.username = username;
    this.password = password;
    this.log = log;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.token = '';
    this.expiresAt = 0;
    this._loginPromise = null;
  }

  async _send(method, path, body, token) {
    const headers = { 'X-Gizwits-Application-Id': APPLICATION_ID, 'Content-Type': 'application/json' };
    if (token) headers['X-Gizwits-User-token'] = token;
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new HeatzyError(`Network: ${error.message}`, { cause: error });
    }
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const detail = data.detail_message || data.error_message || res.statusText;
      throw new HeatzyError(`HTTP ${res.status} ${method} ${path} : ${detail}`, {
        status: res.status,
        code: Number(data.error_code) || 0,
      });
    }
    return data;
  }

  /** Log in (concurrent calls share one request). */
  login() {
    if (!this._loginPromise) {
      this._loginPromise = (async () => {
        try {
          const data = await this._send('POST', '/login', {
            username: this.username,
            password: this.password,
          });
          if (!data.token) throw new HeatzyError('Login response without token');
          this.token = data.token;
          this.expiresAt = Number(data.expire_at) * 1000 || Date.now() + 3600_000;
        } finally {
          this._loginPromise = null;
        }
      })();
    }
    return this._loginPromise;
  }

  async request(method, path, body) {
    if (!this.token || Date.now() > this.expiresAt - 60_000) await this.login();
    try {
      return await this._send(method, path, body, this.token);
    } catch (error) {
      // Token rejected: Gizwits answers 400 (code 9004) or 401 -> log in again, then retry once.
      if (error instanceof HeatzyError && (error.status === 400 || error.status === 401)) {
        this.token = '';
        await this.login();
        return this._send(method, path, body, this.token);
      }
      throw error;
    }
  }

  async listBindings() {
    const devices = [];
    const limit = 100;
    for (let skip = 0; skip < 1000; skip += limit) {
      const data = await this.request('GET', `/bindings?limit=${limit}&skip=${skip}`);
      const page = Array.isArray(data.devices) ? data.devices : [];
      devices.push(...page);
      if (page.length < limit) break;
    }
    return devices;
  }

  async getLatest(did) {
    const data = await this.request('GET', `/devdata/${encodeURIComponent(did)}/latest`);
    return data.attr || {};
  }

  control(did, payload) {
    return this.request('POST', `/control/${encodeURIComponent(did)}`, payload);
  }
}

module.exports = { HeatzyClient, HeatzyError };
