export const DOWNLOAD_REFRESH_TIMEOUT_MS = 10000;

export async function readDownloadJobs(listJobs, options = {}) {
  if (typeof listJobs !== 'function') return [];

  const configuredTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DOWNLOAD_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const jobs = await listJobs({ signal: controller.signal });
    return Array.isArray(jobs) ? jobs : [];
  } finally {
    clearTimeout(timer);
  }
}
