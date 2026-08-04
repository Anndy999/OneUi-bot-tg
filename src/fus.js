import { docUrl, normalizeFirmwareVersion } from "./utils.js";
import { validateModelCsc } from "./targets.js";

const FUS_BASE = "https://neofussvr.sslcs.cdngc.net";
const NONCE_PATH = "/NF_SmartDownloadGenerateNonce.do";
const HISTORY_PATH = "/SmartHistory.do";
const BINARY_INFORM_PATH = "/NF_SmartDownloadBinaryInform.do";
const BINARY_INIT_PATH = "/NF_SmartDownloadBinaryInitForMass.do";
const FUS_USER_AGENT = "SMART 2.0";
const MODERN_NONCE_KEY = "vicopx7dqu06emacgpnpy8j8zwhduwlh";
const MODERN_AUTH_KEY = "9u7qab84rpc16gvk";

function webCrypto() {
  return globalThis.crypto;
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unpadPkcs7(value) {
  if (!value.length) return value;
  const padding = value[value.length - 1];
  if (padding < 1 || padding > 16 || padding > value.length) return value;
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value[index] !== padding) return value;
  }
  return value.slice(0, value.length - padding);
}

function padPkcs7(value) {
  const padding = 16 - (value.length % 16 || 16) || 16;
  const padded = new Uint8Array(value.length + padding);
  padded.set(value);
  padded.fill(padding, value.length);
  return padded;
}

async function decryptModernNonce(value) {
  try {
    const binary = base64ToBytes(value);
    const crypto = webCrypto();
    if (!binary.length || binary.length % 16 !== 0 || !crypto?.subtle) return "";
    const key = new TextEncoder().encode(MODERN_NONCE_KEY);
    const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: key.slice(0, 16) }, cryptoKey, binary);
    return new TextDecoder().decode(unpadPkcs7(new Uint8Array(plain)));
  } catch {
    return "";
  }
}

async function makeModernFusSignature(nonce) {
  const value = String(nonce || "");
  const crypto = webCrypto();
  if (value.length < 16 || !crypto?.subtle) return "";
  try {
    const keyPrefix = Array.from({ length: 16 }, (_, index) => MODERN_NONCE_KEY[value.charCodeAt(index) % 16]).join("");
    const key = new TextEncoder().encode(`${keyPrefix}${MODERN_AUTH_KEY}`);
    const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: key.slice(0, 16) },
      cryptoKey,
      padPkcs7(new TextEncoder().encode(value))
    );
    return bytesToBase64(new Uint8Array(encrypted));
  } catch {
    return "";
  }
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripXml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").trim();
}

function tagValue(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  const inner = decodeXml(match[1] || "").trim();
  const dataMatch = inner.match(/<Data\b[^>]*>([\s\S]*?)<\/Data>/i);
  if (dataMatch) return decodeXml(dataMatch[1] || "").trim();
  return stripXml(inner) || inner;
}

function logicCheck(input, nonce) {
  const source = String(input || "");
  const seed = String(nonce || "");
  if (source.length < 16 || !seed) return "";
  return [...seed].map((character) => source.charAt(character.charCodeAt(0) & 0x0f)).join("");
}

function firmwareDecryptionInfo(fileName, version, model, csc, logicValue) {
  const name = String(fileName || "").toLowerCase();
  if (name.endsWith(".enc2")) {
    return { mode: "enc2", keySeed: `${String(csc || "").toUpperCase()}:${String(model || "").toUpperCase()}:${String(version || "")}` };
  }
  if (!name.endsWith(".enc4")) return null;
  const keySeed = logicCheck(version, logicValue);
  if (!keySeed) throw new Error("Samsung FUS did not return a usable decryption key for this firmware");
  return { mode: "enc4", keySeed };
}

function collectTags(xml, tag) {
  const out = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let match;
  while ((match = pattern.exec(String(xml || "")))) out.push(match[0]);
  return out;
}

function extractCookies(response) {
  const cookies = [];
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || response.headers.get("Set-Cookie") || ""];
  for (const value of values) {
    for (const part of String(value || "").split(/,(?=\s*[^;,]+=)/)) {
      const first = part.split(";")[0]?.trim();
      if (/^(JSESSIONID|SESSION)=/i.test(first)) cookies.push(first);
    }
  }
  return cookies.join(";");
}

const fusLanes = new Map();
const activeLaneByTarget = new Map();
const laneAffinity = new Map();

function monitorLaneCount(env) {
  const value = Number(env?.FUS_MONITOR_LANES || 3);
  return Number.isFinite(value) && value >= 1 ? Math.min(4, Math.floor(value)) : 3;
}

function interactiveLaneCount(env) {
  const value = Number(env?.FUS_INTERACTIVE_LANES || 3);
  return Number.isFinite(value) && value >= 1 ? Math.min(3, Math.floor(value)) : 3;
}

function stableHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (const ch of text) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

export function fusLaneIdFor(env, model, csc, options = {}) {
  const role = String(options.role || options.priority || (options.monitor ? "monitor" : "interactive")).toLowerCase();
  if (role === "admin") return "admin";
  const key = `${String(model || "").toUpperCase()}:${String(csc || "").toUpperCase()}`;
  if (role === "monitor") return `monitor-${stableHash(key) % monitorLaneCount(env)}`;
  return `interactive-${stableHash(key) % interactiveLaneCount(env)}`;
}

function createLane(id) {
  return {
    id,
    session: null,
    noncePromise: null,
    requestTail: Promise.resolve(),
    circuit: { failures: 0, openUntil: 0 },
    queueLength: 0,
    ewmaLatencyMs: 0,
    recentErrors: 0,
    lastSuccessAt: 0
  };
}

function laneIdsFor(env, role) {
  if (role === "admin") return ["admin"];
  const count = role === "monitor" ? monitorLaneCount(env) : interactiveLaneCount(env);
  return Array.from({ length: count }, (_, index) => `${role}-${index}`);
}

function runtimeLaneScore(env, lane) {
  const circuitPenalty = lane.circuit.openUntil > Date.now() ? 100_000 : 0;
  const sessionPenalty = isSessionUsable(env, lane) ? 0 : 300;
  return lane.queueLength * 1000 + Number(lane.ewmaLatencyMs || 0) +
    Number(lane.recentErrors || 0) * 500 + sessionPenalty + circuitPenalty;
}

function selectRuntimeLane(env, model, csc, options = {}) {
  const role = String(options.role || options.priority || (options.monitor ? "monitor" : "interactive")).toLowerCase();
  if (role === "admin") return getLane("admin");
  const targetKey = `${role}:${String(model || "").toUpperCase()}:${String(csc || "").toUpperCase()}`;
  const active = activeLaneByTarget.get(targetKey);
  if (active?.id) {
    active.references += 1;
    return getLane(active.id);
  }
  const affinity = laneAffinity.get(targetKey);
  if (affinity?.id && Number(affinity.expiresAt || 0) > Date.now()) {
    activeLaneByTarget.set(targetKey, { id: affinity.id, references: 1 });
    return getLane(affinity.id);
  }
  const preferred = fusLaneIdFor(env, model, csc, options);
  const lanes = laneIdsFor(env, role).map((id) => getLane(id));
  lanes.sort((a, b) => {
    const score = runtimeLaneScore(env, a) - runtimeLaneScore(env, b);
    if (score) return score;
    if (a.id === preferred) return -1;
    if (b.id === preferred) return 1;
    return a.id.localeCompare(b.id);
  });
  activeLaneByTarget.set(targetKey, { id: lanes[0].id, references: 1 });
  laneAffinity.set(targetKey, { id: lanes[0].id, expiresAt: Date.now() + 10 * 60 * 1000 });
  return lanes[0];
}

function releaseRuntimeLane(model, csc, options, lane) {
  const role = String(options.role || options.priority || (options.monitor ? "monitor" : "interactive")).toLowerCase();
  if (role === "admin") return;
  const targetKey = `${role}:${String(model || "").toUpperCase()}:${String(csc || "").toUpperCase()}`;
  const active = activeLaneByTarget.get(targetKey);
  if (!active || active.id !== lane.id) return;
  active.references -= 1;
  if (active.references <= 0) activeLaneByTarget.delete(targetKey);
}

function getLane(id) {
  const key = String(id || "interactive");
  let lane = fusLanes.get(key);
  if (!lane) {
    lane = createLane(key);
    fusLanes.set(key, lane);
  }
  return lane;
}

function sessionTtlMs(env) {
  const value = Number(env?.FUS_SESSION_TTL_MS || 300000);
  return Number.isFinite(value) && value > 0 ? value : 300000;
}

function circuitFailureThreshold(env) {
  const value = Number(env?.FUS_CIRCUIT_FAILURE_THRESHOLD || 3);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 3;
}

function circuitCooldownMs(env) {
  const value = Number(env?.FUS_CIRCUIT_COOLDOWN_MS || 30000);
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

function isSessionUsable(env, lane) {
  if (!lane.session?.nonce || !lane.session?.createdAt) return false;
  return Date.now() - lane.session.createdAt < sessionTtlMs(env);
}

function assertCircuitClosed(lane) {
  if (lane.circuit.openUntil > Date.now()) {
    const retryAfterMs = lane.circuit.openUntil - Date.now();
    const error = new Error(`SmartHistory circuit open on ${lane.id}; retry after ${retryAfterMs} ms`);
    error.code = "FUS_CIRCUIT_OPEN";
    error.retryAfterMs = retryAfterMs;
    error.laneId = lane.id;
    throw error;
  }
  if (lane.circuit.openUntil) lane.circuit = { failures: 0, openUntil: 0 };
}

function recordCircuitSuccess(lane) {
  lane.circuit = { failures: 0, openUntil: 0 };
  lane.recentErrors = Math.max(0, Number(lane.recentErrors || 0) - 1);
  lane.lastSuccessAt = Date.now();
}

function shouldCountCircuitFailure(error) {
  const status = Number(error?.status || 0);
  return status !== 403 && status !== 404;
}

function recordCircuitFailure(env, lane, error) {
  lane.recentErrors = Math.min(10, Number(lane.recentErrors || 0) + 1);
  if (!shouldCountCircuitFailure(error)) return;
  const failures = lane.circuit.failures + 1;
  lane.circuit = {
    failures,
    openUntil: failures >= circuitFailureThreshold(env)
      ? Date.now() + circuitCooldownMs(env)
      : 0
  };
}

async function withFusRequestLock(lane, factory) {
  const previous = lane.requestTail;
  let release;
  lane.requestTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await factory();
  } finally {
    release();
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 4000);
  if (!signal) return timeoutSignal;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : signal;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textNode(tag, value) {
  return `<${tag}>${escapeXml(value)}</${tag}>`;
}

function dataNode(tag, value) {
  return `<${tag}>${textNode("Data", value)}</${tag}>`;
}

function smartHistoryBody(model, csc) {
  return [
    "<FUSMsg>",
    "  <FUSHdr>",
    `    ${textNode("ProtoVer", "1")}`,
    `    ${textNode("SessionID", "0")}`,
    `    ${textNode("MsgID", "1")}`,
    "  </FUSHdr>",
    "  <FUSBody>",
    "    <Put>",
    `      ${dataNode("ACCESS_MODE", "1")}`,
    `      ${dataNode("BINARY_MODEL_NAME", model)}`,
    `      ${dataNode("BINARY_LOCAL_CODE", csc)}`,
    "    </Put>",
    "  </FUSBody>",
    "</FUSMsg>"
  ].join("\n");
}

function binaryInformBody(model, csc, version, nonce) {
  return [
    "<FUSMsg>",
    "  <FUSHdr>",
    `    ${textNode("ProtoVer", "1")}`,
    `    ${textNode("SessionID", "0")}`,
    `    ${textNode("MsgID", "1")}`,
    "  </FUSHdr>",
    "  <FUSBody>",
    "    <Put>",
    `      ${textNode("CmdID", "1")}`,
    `      ${dataNode("REQUEST_TYPE", "2")}`,
    `      ${dataNode("BINARY_SW_VERSION", version)}`,
    `      ${dataNode("DEVICE_SN_NUMBER", "")}`,
    `      ${dataNode("BINARY_LOCAL_CODE", csc)}`,
    `      ${dataNode("BINARY_MODEL_NAME", model)}`,
    `      ${dataNode("ACCESS_MODE", "1")}`,
    `      ${dataNode("BINARY_NATURE", "1")}`,
    `      ${dataNode("LOGIC_CHECK", logicCheck(version, nonce))}`,
    "    </Put>",
    "    <Get>",
    `      ${textNode("CmdID", "2")}`,
    `      ${textNode("BINARY_SW_VERSION", "")}`,
    "    </Get>",
    "  </FUSBody>",
    "</FUSMsg>"
  ].join("\n");
}

function binaryInitBody(fileName, version, csc, modelType, nonce) {
  const checkInput = String(fileName || "").slice(-25, -9);
  return [
    "<FUSMsg>",
    "  <FUSHdr>",
    `    ${textNode("ProtoVer", "1")}`,
    `    ${textNode("SessionID", "0")}`,
    `    ${textNode("MsgID", "1")}`,
    "  </FUSHdr>",
    "  <FUSBody>",
    "    <Put>",
    `      ${dataNode("BINARY_NAME", fileName)}`,
    `      ${dataNode("BINARY_SW_VERSION", version)}`,
    `      ${dataNode("DEVICE_LOCAL_CODE", csc)}`,
    `      ${dataNode("DEVICE_MODEL_TYPE", modelType)}`,
    `      ${dataNode("LOGIC_CHECK", logicCheck(checkInput, nonce))}`,
    "    </Put>",
    "  </FUSBody>",
    "</FUSMsg>"
  ].join("\n");
}

function fourPartFirmwareVersion(value) {
  const normalized = normalizeFirmwareVersion(value);
  const parts = normalized.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 4) return parts.join("/");
  if (parts.length === 3) return [...parts, parts[0]].join("/");
  return "";
}

/**
 * SmartHistory can return only the PDA/build code for some newer models.
 * Samsung's public version.xml remains the authoritative source for the
 * complete FUS PDA/CSC/CP/PDA tuple needed by BinaryInform.
 */
export async function resolveOfficialFirmwareVersion(env, model, csc, version, options = {}) {
  const direct = fourPartFirmwareVersion(version);
  if (direct) return direct;

  const { model: normalizedModel, csc: normalizedCsc } = validateModelCsc(model, csc);
  const metadataUrl = `https://fota-cloud-dn.ospserver.net/firmware/${encodeURIComponent(normalizedCsc)}/${encodeURIComponent(normalizedModel)}/version.xml`;
  const response = await fetch(metadataUrl, {
    headers: { accept: "application/xml,text/xml", "user-agent": FUS_USER_AGENT },
    signal: combinedSignal(options.signal, Number(options.timeoutMs || 4000))
  });
  if (!response.ok) {
    throw new Error(`Samsung firmware metadata HTTP ${response.status}`);
  }
  const xml = await response.text();
  const latest = tagValue(xml, "latest");
  const resolved = fourPartFirmwareVersion(latest);
  if (!resolved) {
    throw new Error("Samsung official metadata did not return a complete firmware version");
  }
  return resolved;
}

function md5(input) {
  const str = unescape(encodeURIComponent(String(input || "")));
  const x = [];
  let i;
  for (i = 0; i < str.length; i += 1) {
    x[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
  }
  x[str.length >> 2] |= 0x80 << ((str.length % 4) * 8);
  x[(((str.length + 8) >> 6) + 1) * 16 - 2] = str.length * 8;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  function add32(xValue, yValue) {
    return (xValue + yValue) | 0;
  }
  function cmn(q, aValue, bValue, xValue, s, t) {
    aValue = add32(add32(aValue, q), add32(xValue, t));
    return add32((aValue << s) | (aValue >>> (32 - s)), bValue);
  }
  function ff(aValue, bValue, cValue, dValue, xValue, s, t) {
    return cmn((bValue & cValue) | (~bValue & dValue), aValue, bValue, xValue, s, t);
  }
  function gg(aValue, bValue, cValue, dValue, xValue, s, t) {
    return cmn((bValue & dValue) | (cValue & ~dValue), aValue, bValue, xValue, s, t);
  }
  function hh(aValue, bValue, cValue, dValue, xValue, s, t) {
    return cmn(bValue ^ cValue ^ dValue, aValue, bValue, xValue, s, t);
  }
  function ii(aValue, bValue, cValue, dValue, xValue, s, t) {
    return cmn(cValue ^ (bValue | ~dValue), aValue, bValue, xValue, s, t);
  }

  for (i = 0; i < x.length; i += 16) {
    const olda = a;
    const oldb = b;
    const oldc = c;
    const oldd = d;

    a = ff(a, b, c, d, x[i + 0] || 0, 7, -680876936);
    d = ff(d, a, b, c, x[i + 1] || 0, 12, -389564586);
    c = ff(c, d, a, b, x[i + 2] || 0, 17, 606105819);
    b = ff(b, c, d, a, x[i + 3] || 0, 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4] || 0, 7, -176418897);
    d = ff(d, a, b, c, x[i + 5] || 0, 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6] || 0, 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7] || 0, 22, -45705983);
    a = ff(a, b, c, d, x[i + 8] || 0, 7, 1770035416);
    d = ff(d, a, b, c, x[i + 9] || 0, 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10] || 0, 17, -42063);
    b = ff(b, c, d, a, x[i + 11] || 0, 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12] || 0, 7, 1804603682);
    d = ff(d, a, b, c, x[i + 13] || 0, 12, -40341101);
    c = ff(c, d, a, b, x[i + 14] || 0, 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15] || 0, 22, 1236535329);

    a = gg(a, b, c, d, x[i + 1] || 0, 5, -165796510);
    d = gg(d, a, b, c, x[i + 6] || 0, 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11] || 0, 14, 643717713);
    b = gg(b, c, d, a, x[i + 0] || 0, 20, -373897302);
    a = gg(a, b, c, d, x[i + 5] || 0, 5, -701558691);
    d = gg(d, a, b, c, x[i + 10] || 0, 9, 38016083);
    c = gg(c, d, a, b, x[i + 15] || 0, 14, -660478335);
    b = gg(b, c, d, a, x[i + 4] || 0, 20, -405537848);
    a = gg(a, b, c, d, x[i + 9] || 0, 5, 568446438);
    d = gg(d, a, b, c, x[i + 14] || 0, 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3] || 0, 14, -187363961);
    b = gg(b, c, d, a, x[i + 8] || 0, 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13] || 0, 5, -1444681467);
    d = gg(d, a, b, c, x[i + 2] || 0, 9, -51403784);
    c = gg(c, d, a, b, x[i + 7] || 0, 14, 1735328473);
    b = gg(b, c, d, a, x[i + 12] || 0, 20, -1926607734);

    a = hh(a, b, c, d, x[i + 5] || 0, 4, -378558);
    d = hh(d, a, b, c, x[i + 8] || 0, 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11] || 0, 16, 1839030562);
    b = hh(b, c, d, a, x[i + 14] || 0, 23, -35309556);
    a = hh(a, b, c, d, x[i + 1] || 0, 4, -1530992060);
    d = hh(d, a, b, c, x[i + 4] || 0, 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7] || 0, 16, -155497632);
    b = hh(b, c, d, a, x[i + 10] || 0, 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13] || 0, 4, 681279174);
    d = hh(d, a, b, c, x[i + 0] || 0, 11, -358537222);
    c = hh(c, d, a, b, x[i + 3] || 0, 16, -722521979);
    b = hh(b, c, d, a, x[i + 6] || 0, 23, 76029189);
    a = hh(a, b, c, d, x[i + 9] || 0, 4, -640364487);
    d = hh(d, a, b, c, x[i + 12] || 0, 11, -421815835);
    c = hh(c, d, a, b, x[i + 15] || 0, 16, 530742520);
    b = hh(b, c, d, a, x[i + 2] || 0, 23, -995338651);

    a = ii(a, b, c, d, x[i + 0] || 0, 6, -198630844);
    d = ii(d, a, b, c, x[i + 7] || 0, 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14] || 0, 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5] || 0, 21, -57434055);
    a = ii(a, b, c, d, x[i + 12] || 0, 6, 1700485571);
    d = ii(d, a, b, c, x[i + 3] || 0, 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10] || 0, 15, -1051523);
    b = ii(b, c, d, a, x[i + 1] || 0, 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8] || 0, 6, 1873313359);
    d = ii(d, a, b, c, x[i + 15] || 0, 10, -30611744);
    c = ii(c, d, a, b, x[i + 6] || 0, 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13] || 0, 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4] || 0, 6, -145523070);
    d = ii(d, a, b, c, x[i + 11] || 0, 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2] || 0, 15, 718787259);
    b = ii(b, c, d, a, x[i + 9] || 0, 21, -343485551);

    a = add32(a, olda);
    b = add32(b, oldb);
    c = add32(c, oldc);
    d = add32(d, oldd);
  }

  function rhex(n) {
    let s = "";
    for (let j = 0; j < 4; j += 1) {
      s += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16);
    }
    return s;
  }

  return rhex(a) + rhex(b) + rhex(c) + rhex(d);
}

export async function makeSignatureHash(nonce, signature) {
  if (!signature) return "";
  const a = md5(`auth:${nonce}:00000001`);
  const b = md5(`interface:${signature}`);
  return md5(`${a}:FUS:${b}`);
}

async function authHeader(lane, signature = "") {
  const sig = String(signature || "").trim();
  const serverNonce = lane.session?.serverNonce || lane.session?.nonce || "";
  if (sig) {
    const logicNonce = lane.session?.nonce || serverNonce;
    return `FUS nonce="${serverNonce}", signature="${await makeSignatureHash(logicNonce, sig)}", nc="00000001", type="auth", realm="interface"`;
  }
  return `FUS nonce="${serverNonce}", signature="${lane.session?.auth || ""}", nc="", type="", realm=""`;
}

function isAuthFailure(response, body) {
  if (response.status === 401) return true;
  return tagValue(body, "Status") === "401";
}

async function postFus(path, data, authorization, lane, options = {}) {
  const activeSession = lane.session;
  const headers = {
    "authorization": authorization,
    "user-agent": FUS_USER_AGENT,
    "content-type": "application/xml; charset=UTF-8"
  };
  if (activeSession?.cookie) headers.cookie = activeSession.cookie;

  const response = await fetch(`${FUS_BASE}${path}`, {
    method: "POST",
    headers,
    body: data || "",
    signal: combinedSignal(options.signal, Number(options.timeoutMs || 4000))
  });
  const text = await response.text();
  const cookie = extractCookies(response);
  const nonce = response.headers.get("NONCE") || response.headers.get("nonce") || tagValue(text, "NONCE") || tagValue(text, "Nonce") || tagValue(text, "nonce");

  // Only mutate the session that initiated this request. A late response from
  // an expired session must not overwrite a freshly-created lane session.
  if (lane.session && lane.session === activeSession) {
    if (cookie) lane.session.cookie = cookie;
    if (nonce) {
      const decrypted = await decryptModernNonce(nonce);
      const logicalNonce = decrypted || nonce;
      lane.session.serverNonce = nonce;
      lane.session.nonce = logicalNonce;
      lane.session.auth = await makeModernFusSignature(logicalNonce);
      lane.session.createdAt = Date.now();
    }
  }
  return { response, text, cookie, nonce };
}

export async function generateNonce(env, options = {}) {
  const lane = options.lane || getLane(options.laneId || "interactive");
  const authorization = `FUS nonce="", signature="", nc="", type="", realm=""`;
  const { response, cookie, nonce } = await postFus(NONCE_PATH, "", authorization, lane, options);
  if (!response.ok) {
    const error = new Error(`SmartHistory nonce HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!nonce) throw new Error("SmartHistory nonce is empty");
  const decrypted = await decryptModernNonce(nonce) || nonce;
  lane.session = {
    serverNonce: nonce,
    nonce: decrypted,
    cookie,
    auth: await makeModernFusSignature(decrypted),
    createdAt: Date.now()
  };
  return lane.session;
}

async function ensureNonceWithOptions(env, lane, options = {}) {
  const startedAt = Date.now();
  const timing = options.timing && typeof options.timing === "object" ? options.timing : null;
  if (isSessionUsable(env, lane)) {
    if (timing) {
      timing.sessionReused = true;
      timing.sessionAcquireMs = Number(timing.sessionAcquireMs || 0) + (Date.now() - startedAt);
    }
    return lane.session;
  }
  lane.session = null;
  if (!lane.noncePromise) {
    lane.noncePromise = generateNonce(env, { ...options, lane }).finally(() => {
      lane.noncePromise = null;
    });
  }
  try {
    return await lane.noncePromise;
  } finally {
    if (timing) {
      const elapsed = Date.now() - startedAt;
      timing.sessionReused = false;
      timing.sessionAcquireMs = Number(timing.sessionAcquireMs || 0) + elapsed;
      timing.nonceMs = Number(timing.nonceMs || 0) + elapsed;
    }
  }
}

async function makeFusRequestUnlocked(env, lane, requestPath, data, signature, retry, options) {
  await ensureNonceWithOptions(env, lane, options);
  const authorization = await authHeader(lane, signature);
  const requestStartedAt = Date.now();
  const requestData = typeof options.bodyFactory === "function"
    ? await options.bodyFactory(lane.session)
    : data;
  const { response, text } = await postFus(requestPath, requestData, authorization, lane, options);
  if (options.timing && typeof options.timing === "object") {
    options.timing.smartHistoryMs = Number(options.timing.smartHistoryMs || 0) +
      (Date.now() - requestStartedAt);
  }

  if (isAuthFailure(response, text) && retry) {
    lane.session = null;
    await ensureNonceWithOptions(env, lane, options);
    return makeFusRequestUnlocked(env, lane, requestPath, data, signature, false, options);
  }

  if (!response.ok) {
    const error = new Error(`SmartHistory HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (isAuthFailure(response, text)) {
    const error = new Error("SmartHistory authorization failed");
    error.status = 401;
    throw error;
  }
  return text;
}

export async function makeFusRequest(env, requestPath, data, signature, retry = true, options = {}) {
  const model = options.model || signature;
  const csc = options.csc || "";
  const lane = selectRuntimeLane(env, model, csc, options);
  const timing = options.timing && typeof options.timing === "object" ? options.timing : null;
  if (timing) timing.laneId = lane.id;
  const queuedAt = Date.now();
  lane.queueLength += 1;
  try {
    assertCircuitClosed(lane);
    return await withFusRequestLock(lane, async () => {
      assertCircuitClosed(lane);
      const startedAt = Date.now();
      if (timing) timing.laneQueueWaitMs = Number(timing.laneQueueWaitMs || 0) + (startedAt - queuedAt);
      try {
        const text = await makeFusRequestUnlocked(env, lane, requestPath, data, signature, retry, options);
        const elapsed = Date.now() - startedAt;
        lane.ewmaLatencyMs = lane.ewmaLatencyMs > 0
          ? Math.round(lane.ewmaLatencyMs * 0.75 + elapsed * 0.25)
          : elapsed;
        lane.lastQueueWaitMs = startedAt - queuedAt;
        recordCircuitSuccess(lane);
        return text;
      } catch (error) {
        recordCircuitFailure(env, lane, error);
        error.laneId = lane.id;
        throw error;
      }
    });
  } finally {
    lane.queueLength = Math.max(0, lane.queueLength - 1);
    releaseRuntimeLane(model, csc, options, lane);
  }
}

export async function querySmartHistory(env, model, csc, options = {}) {
  const { model: normalizedModel, csc: normalizedCsc } = validateModelCsc(model, csc);
  const body = smartHistoryBody(normalizedModel, normalizedCsc);
  const xml = await makeFusRequest(env, HISTORY_PATH, body, "", true, {
    ...options,
    model: normalizedModel,
    csc: normalizedCsc
  });
  const status = tagValue(xml, "Status");
  if (status && status !== "200" && status !== "S00") {
    const error = new Error(`SmartHistory returned ${status}`);
    error.code = "FUS_SMART_HISTORY_STATUS";
    error.status = status;
    throw error;
  }
  const parseStartedAt = Date.now();
  const parsed = parseSmartHistory(xml, normalizedModel, normalizedCsc);
  if (options.timing && typeof options.timing === "object") {
    options.timing.parseHistoryMs = Number(options.timing.parseHistoryMs || 0) +
      (Date.now() - parseStartedAt);
  }
  return parsed;
}

/**
 * Resolve a Samsung FUS firmware bundle to the short-lived official cloud
 * URL and authorization header required by the binary download endpoint.
 * The URL is intentionally consumed by the VPS download service and is never
 * exposed in Telegram responses.
 */
export async function resolveOfficialFirmwareDownload(env, model, csc, version, options = {}) {
  const { model: normalizedModel, csc: normalizedCsc } = validateModelCsc(model, csc);
  const fusVersion = await resolveOfficialFirmwareVersion(env, normalizedModel, normalizedCsc, version, options);
  const timing = options.timing && typeof options.timing === "object" ? options.timing : null;
  const xml = await makeFusRequest(env, BINARY_INFORM_PATH, "", "", true, {
    ...options,
    role: "admin",
    model: normalizedModel,
    csc: normalizedCsc,
    bodyFactory: (session) => binaryInformBody(
      normalizedModel,
      normalizedCsc,
      fusVersion,
      session?.nonce || ""
    ),
    timing
  });
  const status = tagValue(xml, "Status");
  if (status && status !== "200" && status !== "S00") {
    const error = new Error(`Samsung FUS binary inform returned ${status}`);
    error.code = "FUS_BINARY_INFORM_FAILED";
    error.status = Number(status) || 0;
    throw error;
  }
  const fileName = tagValue(xml, "BINARY_NAME");
  const modelPath = tagValue(xml, "MODEL_PATH");
  const byteSize = Number(tagValue(xml, "BINARY_BYTE_SIZE") || 0);
  const resolvedVersion = tagValue(xml, "BINARY_SW_VERSION") || fusVersion;
  const logicValue = tagValue(xml, "LOGIC_VALUE_FACTORY") || tagValue(xml, "LOGIC_VALUE_HOME");
  if (!fileName || !modelPath) throw new Error("Samsung FUS did not return a firmware bundle");
  const modelType = tagValue(xml, "DEVICE_MODEL_TYPE");
  if (!modelType) throw new Error("Samsung FUS did not return the firmware model type");
  const initXml = await makeFusRequest(env, BINARY_INIT_PATH, "", "", true, {
    ...options,
    role: "admin",
    model: normalizedModel,
    csc: normalizedCsc,
    bodyFactory: (session) => binaryInitBody(fileName, fusVersion, normalizedCsc, modelType, session?.nonce || ""),
    timing
  });
  const initStatus = tagValue(initXml, "Status");
  if (initStatus && initStatus !== "200" && initStatus !== "S00") {
    const error = new Error(`Samsung FUS binary init returned ${initStatus}`);
    error.code = "FUS_BINARY_INIT_FAILED";
    error.status = Number(initStatus) || 0;
    throw error;
  }
  const lane = getLane("admin");
  const serverNonce = lane.session?.serverNonce || "";
  const auth = lane.session?.auth || "";
  if (!serverNonce || !auth) throw new Error("Samsung FUS authorization is incomplete");
  const filePath = `${modelPath}${fileName}`;
  const sourceUrl = `http://cloud-neofussvr.samsungmobile.com/NF_SmartDownloadBinaryForMass.do?file=${encodeURIComponent(filePath)}`;
  return {
    sourceUrl,
    sourceHeaders: {
      authorization: `FUS nonce="${serverNonce}", signature="${auth}", nc="", type="", realm=""`,
      "user-agent": FUS_USER_AGENT,
      ...(lane.session?.cookie ? { cookie: lane.session.cookie } : {})
    },
    fileName,
    size: Number.isFinite(byteSize) ? byteSize : 0,
    model: normalizedModel,
    csc: normalizedCsc,
    version: resolvedVersion,
    decryption: firmwareDecryptionInfo(fileName, resolvedVersion, normalizedModel, normalizedCsc, logicValue),
    source: "Samsung FUS"
  };
}

export function resetFusSession() {
  fusLanes.clear();
  activeLaneByTarget.clear();
  laneAffinity.clear();
}

export function fusPoolSnapshot() {
  return [...fusLanes.values()].map((lane) => ({
    id: lane.id,
    hasSession: Boolean(lane.session?.nonce),
    sessionAgeMs: lane.session?.createdAt ? Math.max(0, Date.now() - lane.session.createdAt) : null,
    circuitFailures: lane.circuit.failures,
    circuitOpenUntil: lane.circuit.openUntil || 0,
    queueLength: lane.queueLength,
    ewmaLatencyMs: lane.ewmaLatencyMs,
    lastQueueWaitMs: Number(lane.lastQueueWaitMs || 0),
    recentErrors: lane.recentErrors,
    lastSuccessAt: lane.lastSuccessAt
  }));
}


function isFutureOpenDate(value, now = Date.now()) {
  const text = String(value || "").trim();
  if (!/^\d{8}$/.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const parsed = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(parsed)) return false;
  const today = new Date(now);
  const tomorrowUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1
  );
  return parsed > tomorrowUtc;
}

export function parseSmartHistoryRows(xml, model, csc) {
  const { model: normalizedModel, csc: normalizedCsc } = validateModelCsc(model, csc);
  const blocks = collectTags(xml, "BINARY_INFO");
  return blocks.map((block, index) => {
    const rawLatest = tagValue(block, "BINARY_SW_VERSION");
    const latest = normalizeFirmwareVersion(rawLatest);
    const parts = latest.split("/").map((part) => part.trim()).filter(Boolean);
    const sequenceText = tagValue(block, "BINARY_SEQUENCE");
    const sequence = Number(sequenceText);
    const rawAndroid = tagValue(block, "BINARY_OS_NAME");
    const localCode = tagValue(block, "BINARY_LOCAL_CODE").toUpperCase();
    const buyerCode = tagValue(block, "BINARY_BUYER_CODE").toUpperCase();
    const cscRank = localCode === normalizedCsc
      ? 3
      : buyerCode === normalizedCsc
        ? 2
        : (!localCode && !buyerCode ? 1 : 0);
    const cscMatchType = cscRank === 3
      ? "local"
      : cscRank === 2
        ? "buyer"
        : cscRank === 1
          ? "generic"
          : "foreign";
    return {
      index,
      model: tagValue(block, "BINARY_MODEL_NAME").toUpperCase(),
      csc: localCode || buyerCode,
      localCode,
      buyerCode,
      cscRank,
      cscMatchType,
      cscMatched: cscRank >= 2,
      latest,
      rawLatest,
      pda: parts[0] || "N/A",
      cscVersion: parts[1] || "N/A",
      modem: parts[2] || parts[0] || "N/A",
      rawAndroid,
      android: rawAndroid || "\u672A\u77E5",
      sequence: Number.isFinite(sequence) ? sequence : null,
      openDate: tagValue(block, "BINARY_OPEN_DATE"),
      securityPatch: tagValue(block, "BINARY_SECURITY_PATCH_LEVEL") || tagValue(block, "BINARY_SECURITY_PATCH"),
      displayVersion: tagValue(block, "BINARY_SW_DISPLAYVERSION"),
      directVersion: tagValue(block, "BINARY_DIRECT_VERSION"),
      status: tagValue(block, "BINARY_STATUS"),
      exists: tagValue(block, "BINARY_EXIST"),
      platform: tagValue(block, "DEVICE_PLATFORM")
    };
  }).filter((row) => {
    if (!row.latest) return false;
    if (row.rawAndroid === "Z(Android 99)") return false;
    if (row.model && row.model !== normalizedModel) return false;
    // Samsung occasionally leaves withdrawn/unavailable records in History.
    // Only reject explicit false values; unknown or missing values remain valid
    // until their semantics are confirmed from real responses.
    if (/^(?:0|N|NO|FALSE)$/i.test(String(row.exists || "").trim())) return false;
    // Only accept records whose public/open date is not in the future. Unknown
    // formats stay eligible because Samsung does not document every legacy format.
    if (isFutureOpenDate(row.openDate)) return false;
    return true;
  });
}

export function officialCscOptionsFromSmartHistoryRows(rows = []) {
  const byCsc = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const codes = [...new Set([row.localCode, row.buyerCode].filter((value) => /^[A-Z0-9]{3}$/.test(String(value || ""))))];
    for (const code of codes) {
      const option = {
        csc: code,
        latest: row.latest,
        pda: row.pda,
        android: row.android,
        openDate: row.openDate,
        sequence: row.sequence,
        localCode: row.localCode,
        buyerCode: row.buyerCode
      };
      const previous = byCsc.get(code);
      const newerDate = String(option.openDate || "").localeCompare(String(previous?.openDate || ""));
      const newerSequence = Number(option.sequence ?? -1) - Number(previous?.sequence ?? -1);
      if (!previous || newerDate > 0 || (newerDate === 0 && newerSequence > 0)) byCsc.set(code, option);
    }
  }
  return [...byCsc.values()];
}

export function parseSmartHistory(xml, model, csc) {
  const { model: normalizedModel, csc: normalizedCsc } = validateModelCsc(model, csc);
  const rows = parseSmartHistoryRows(xml, normalizedModel, normalizedCsc);

  if (!rows.length) {
    const error = new Error("SmartHistory has no usable firmware history");
    error.code = "FUS_SMART_HISTORY_EMPTY";
    throw error;
  }

  // Never allow a higher sequence from another CSC to masquerade as the
  // requested region. Prefer exact local CSC, then buyer CSC, then generic rows.
  const bestCscRank = Math.max(...rows.map((row) => row.cscRank));
  if (bestCscRank <= 0) {
    const error = new Error(`SmartHistory has no matching CSC record for ${normalizedCsc}`);
    error.code = "EXACT_CSC_REQUIRED";
    error.officialCscOptions = officialCscOptionsFromSmartHistoryRows(rows);
    throw error;
  }
  const candidates = rows.filter((row) => row.cscRank === bestCscRank);
  candidates.sort((a, b) => {
    if (a.sequence !== null && b.sequence !== null && a.sequence !== b.sequence) return a.sequence - b.sequence;
    if (a.sequence === null && b.sequence !== null) return -1;
    if (a.sequence !== null && b.sequence === null) return 1;
    if (a.openDate !== b.openDate) return String(a.openDate || "").localeCompare(String(b.openDate || ""));
    return a.index - b.index;
  });
  const latest = candidates[candidates.length - 1];
  return {
    ok: true,
    model: normalizedModel,
    csc: normalizedCsc,
    latest: latest.latest,
    rawLatest: latest.rawLatest,
    pda: latest.pda,
    cscVersion: latest.cscVersion,
    modem: latest.modem,
    android: latest.android,
    rawAndroid: latest.rawAndroid,
    docUrl: docUrl(normalizedModel, normalizedCsc),
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    smartHistory: {
      authMode: "Bifrost SmartDownload history query",
      sequence: latest.sequence,
      openDate: latest.openDate,
      securityPatch: latest.securityPatch,
      displayVersion: latest.displayVersion,
      directVersion: latest.directVersion,
      cscMatched: latest.cscMatched,
      cscMatchType: latest.cscMatchType,
      returnedCsc: latest.csc,
      localCode: latest.localCode,
      buyerCode: latest.buyerCode,
      candidateCount: candidates.length,
      status: latest.status,
      exists: latest.exists,
      platform: latest.platform
    },
    rawOutput: xml
  };
}
