const DEFAULT_DOWNLOAD_API_URL = "http://127.0.0.1:8788";

function apiUrl(env = process.env) {
  return String(env.DOWNLOAD_API_URL || DEFAULT_DOWNLOAD_API_URL).replace(/\/+$/, "");
}

function apiSecret(env = process.env) {
  return String(env.DOWNLOAD_API_SECRET || "").trim();
}

async function downloadApiRequest(env, path, options = {}) {
  const secret = apiSecret(env);
  if (!secret) return { ok: false, configured: false, error: "DOWNLOAD_API_SECRET is not configured" };
  const headers = {
    accept: "application/json",
    "x-download-api-key": secret,
    ...(options.headers || {})
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  try {
    const response = await fetch(`${apiUrl(env)}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(Number(options.timeoutMs || 8000))
    });
    const data = await response.json().catch(() => ({}));
    return {
      ...data,
      ok: response.ok && data.ok !== false,
      status: response.status,
      configured: true
    };
  } catch (error) {
    return { ok: false, configured: true, error: String(error?.message || error) };
  }
}

export function listFirmwareDownloads(env) {
  return downloadApiRequest(env, "/api/v1/downloads");
}

export function createFirmwareDownload(env, payload, requestedBy) {
  return downloadApiRequest(env, "/api/v1/downloads", {
    method: "POST",
    headers: { "x-admin-id": String(requestedBy || "admin") },
    body: payload
  });
}

export function previewFirmwareDownload(env, payload) {
  return downloadApiRequest(env, "/api/v1/downloads/preview", {
    method: "POST",
    body: payload
  });
}

export function getFirmwareDownload(env, id) {
  return downloadApiRequest(env, `/api/v1/downloads/${encodeURIComponent(String(id || ""))}`);
}

export function cancelFirmwareDownload(env, id) {
  return downloadApiRequest(env, `/api/v1/downloads/${encodeURIComponent(String(id || ""))}`, { method: "DELETE" });
}

export function pauseFirmwareDownload(env, id) {
  return downloadApiRequest(env, `/api/v1/downloads/${encodeURIComponent(String(id || ""))}/pause`, { method: "POST" });
}

export function resumeFirmwareDownload(env, id) {
  return downloadApiRequest(env, `/api/v1/downloads/${encodeURIComponent(String(id || ""))}/resume`, { method: "POST" });
}

export function deleteFirmwareDownload(env, id) {
  return downloadApiRequest(env, `/api/v1/downloads/${encodeURIComponent(String(id || ""))}/delete`, { method: "POST" });
}
