'use strict';

function createZowieboxClient({
  baseUrl,
  username,
  password,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4_000,
} = {}) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/i.test(origin)) throw new Error('ZowieBox base URL is invalid');
  if (!username || !password) throw new Error('ZowieBox service credentials are not configured');
  if (typeof fetchImpl !== 'function') throw new Error('ZowieBox fetch implementation is unavailable');

  let uuid = '';

  async function post(requestPath, body, includeSession = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (includeSession && uuid) headers.uuid = uuid;
      const response = await fetchImpl(`${origin}${requestPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('ZowieBox management request failed');
      const data = await response.json();
      if (data?.status !== '00000') {
        const error = new Error(`ZowieBox rejected management request (${String(data?.status || 'unknown')})`);
        error.deviceStatus = data?.status || null;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('ZowieBox management request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function login() {
    const result = await post('/system?option=setinfo', {
      group: 'account',
      opt: 'login_account',
      data: { username, password },
    });
    uuid = String(result?.data?.uuid || '');
    if (!uuid) throw new Error('ZowieBox login did not return a session');
  }

  async function authenticated(requestPath, body, retry = true) {
    if (!uuid) await login();
    try {
      return await post(requestPath, body, true);
    } catch (error) {
      if (retry && error?.deviceStatus === '80003') {
        uuid = '';
        await login();
        return authenticated(requestPath, body, false);
      }
      throw error;
    }
  }

  async function getInput() {
    const result = await authenticated('/video?option=getinfo&login_check_flag=1', {
      group: 'hdmi',
      opt: 'get_input_info',
    });
    return result.data || {};
  }

  async function getSystemInfo() {
    const result = await authenticated('/system?option=getinfo&login_check_flag=1', {
      group: 'sys_attr',
      opt: 'get_sys_attr_info',
    });
    return result.data || {};
  }

  async function getAudioInfo() {
    const result = await authenticated('/audio?option=getinfo&login_check_flag=1', {
      group: 'all',
    });
    return result.all || {};
  }

  return {
    getAudioInfo,
    getInput,
    getSystemInfo,
    resetSession() { uuid = ''; },
  };
}

module.exports = { createZowieboxClient };
