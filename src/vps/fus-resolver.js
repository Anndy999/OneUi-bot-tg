import { readFile } from "node:fs/promises";
import { validateModelCsc } from "../targets.js";
import { resolveOfficialFirmwareVersion } from "../fus.js";

const FUS_BASE = "https://neofussvr.sslcs.cdngc.net";
const NONCE_PATH = "/NF_SmartDownloadGenerateNonce.do";
const BINARY_INFORM_PATH = "/NF_SmartDownloadBinaryInform.do";
const BINARY_INIT_PATH = "/NF_SmartDownloadBinaryInitForMass.do";
const FUS_USER_AGENT = "SMART 2.0";
const SHIFT_INDICES = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
let authParametersPromise = null;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textNode(tag, value) { return `<${tag}>${escapeXml(value)}</${tag}>`; }
function dataNode(tag, value) { return `<${tag}>${textNode("Data", value)}</${tag}>`; }

function tagValue(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  const value = match[1].match(/<Data\b[^>]*>([\s\S]*?)<\/Data>/i)?.[1] ?? match[1];
  return String(value).replace(/<[^>]+>/g, "").trim();
}

function logicCheck(input, nonce) {
  const source = String(input || "");
  const seed = String(nonce || "");
  if (source.length < 16 || !seed) return "";
  return [...seed].map((character) => source.charAt(character.charCodeAt(0) & 0x0f)).join("");
}

function binaryInformBody(model, csc, version, nonce) {
  return [
    "<FUSMsg><FUSHdr>", textNode("ProtoVer", "1"), textNode("SessionID", "0"), textNode("MsgID", "1"), "</FUSHdr><FUSBody><Put>",
    textNode("CmdID", "1"), dataNode("ACCESS_MODE", "1"), dataNode("BINARY_NATURE", "1"), dataNode("REQUEST_TYPE", "2"),
    dataNode("LOGIC_CHECK", logicCheck(version, nonce)), dataNode("BINARY_SW_VERSION", version), dataNode("DEVICE_SN_NUMBER", ""),
    dataNode("BINARY_LOCAL_CODE", csc), dataNode("BINARY_MODEL_NAME", model), "</Put><Get>", textNode("CmdID", "2"), textNode("BINARY_SW_VERSION", ""),
    "</Get></FUSBody></FUSMsg>"
  ].join("");
}

function binaryInitBody(fileName, version, csc, modelType, nonce) {
  const checkInput = String(fileName || "").slice(-25, -9);
  return [
    "<FUSMsg><FUSHdr>", textNode("ProtoVer", "1"), textNode("SessionID", "0"), textNode("MsgID", "1"), "</FUSHdr><FUSBody><Put>",
    dataNode("BINARY_NAME", fileName), dataNode("BINARY_SW_VERSION", version), dataNode("DEVICE_LOCAL_CODE", csc),
    dataNode("DEVICE_MODEL_TYPE", modelType), dataNode("LOGIC_CHECK", logicCheck(checkInput, nonce)), "</Put></FUSBody></FUSMsg>"
  ].join("");
}

function extractCookies(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  const cookies = [];
  for (const value of values) {
    for (const part of String(value).split(/,(?=\s*[^;,]+=)/)) {
      const first = part.split(";")[0]?.trim();
      if (/^(JSESSIONID|SESSION)=/i.test(first)) cookies.push(first);
    }
  }
  return cookies.join(";");
}

async function authParameters() {
  if (!authParametersPromise) authParametersPromise = readFile(new URL("./auth_param.dat", import.meta.url));
  return authParametersPromise;
}

async function authenticateNonce(value) {
  const parameters = await authParameters();
  if (parameters.length < 57) throw new Error("Samsung FUS authentication parameters are unavailable");
  const header = {
    block1Size: parameters.readUInt32LE(12),
    block2Size: parameters.readUInt32LE(20),
    block3Size: parameters.readUInt32LE(44)
  };
  const dataOffset = 56;
  const read = (position, length = 1) => parameters.subarray(dataOffset + position, dataOffset + position + length);
  const input = Buffer.from(String(value || ""), "utf8");
  if (input.length < 16) throw new Error("Samsung FUS returned an invalid nonce");
  const temp = new Uint8Array(320);
  temp.set(input.subarray(0, 16));
  const transformed = new Uint8Array(64);
  const finalBase = header.block1Size;
  for (let round = 0; round < 9; round += 1) {
    const sourceStart = round * 32;
    const nextStart = (round + 1) * 32;
    const middle = sourceStart + 16;
    const blockBase = round * 16;
    for (let index = 0; index < 16; index += 1) temp[middle + index] = temp[sourceStart + SHIFT_INDICES[index]];
    for (let row = 0; row < 4; row += 1) {
      const row4 = row * 4;
      const row16 = row * 16;
      const tableBase = finalBase + header.block2Size + header.block3Size + (6144 * (row + round * 4));
      for (let column = 0; column < 4; column += 1) {
        const blockId = blockBase + row4 + column;
        const source = read(blockId * 4096 + temp[middle + row4 + column] * 16, 16);
        const selectors = read(finalBase + header.block2Size + blockId * 32, 32);
        const outputStart = row16 + column * 4;
        for (let output = 0; output < 4; output += 1) {
          let accumulator = 0;
          for (let bit = 0; bit < 8; bit += 1) {
            const selector = selectors[output * 8 + bit];
            const sourceIndex = (selector >>> 3) & 0x1f;
            const sourceByte = sourceIndex < 16 ? source[sourceIndex] : 0;
            accumulator |= ((sourceByte >>> (7 - (selector & 7))) & 1) << (7 - bit);
          }
          transformed[outputStart + output] = accumulator;
        }
      }
      for (let column = 0; column < 4; column += 1) {
        const a1 = transformed[row16 + column];
        const a2 = transformed[row16 + column + 4];
        const a3 = transformed[row16 + column + 8];
        const a4 = transformed[row16 + column + 12];
        const table = read(tableBase + 1536 * column, 1536);
        const hi1 = ((a1 & 0xf0) | (a2 >>> 4)) & 0xff;
        const lo1 = (((a1 & 0x0f) << 4) | (a2 & 0x0f)) & 0xff;
        const v6 = ((16 * table[hi1]) ^ table[256 + lo1]) & 0xff;
        const hi2 = ((a3 & 0xf0) | (a4 >>> 4)) & 0xff;
        const lo2 = (((a3 & 0x0f) << 4) | (a4 & 0x0f)) & 0xff;
        const v7 = ((16 * table[512 + hi2]) ^ table[768 + lo2]) & 0xff;
        const hi3 = ((v6 & 0xf0) | (v7 >>> 4)) & 0xff;
        const lo3 = (((v6 & 0x0f) << 4) | (v7 & 0x0f)) & 0xff;
        temp[nextStart + row4 + column] = ((16 * table[1024 + hi3]) ^ table[1280 + lo3]) & 0xff;
      }
    }
  }
  const output = Buffer.alloc(16);
  for (let index = 0; index < 16; index += 1) output[index] = read(finalBase + index * 256 + temp[288 + SHIFT_INDICES[index]])[0];
  return output.toString("hex");
}

function authorization(session) {
  return `FUS nonce="${session.nonce}", signature="${session.auth}", nc="", type="", realm=""`;
}

// Samsung's cloud binary endpoint uses the auth produced by BinaryInit but
// expects an empty nonce. This is intentionally different from the XML FUS
// calls above; reusing their nonce/cookie can make the cloud endpoint return
// HTTP 401, especially when the request is resumed with Range.
function cloudAuthorization(session) {
  return `FUS nonce="", signature="${session.auth}", nc="", type="", realm=""`;
}

async function request(session, path, body, fetchImpl, signal, retry = true) {
  const response = await fetchImpl(`${FUS_BASE}${path}`, {
    method: "POST",
    headers: { authorization: authorization(session), "user-agent": FUS_USER_AGENT, "content-type": "application/xml; charset=UTF-8", ...(session.cookie ? { cookie: session.cookie } : {}) },
    body,
    signal
  });
  const text = await response.text();
  if ((response.status === 401 || tagValue(text, "Status") === "401") && retry) {
    Object.assign(session, await createSession(fetchImpl, signal));
    return request(session, path, body, fetchImpl, signal, false);
  }
  if (!response.ok) throw new Error(`Samsung FUS HTTP ${response.status}`);
  if (tagValue(text, "Status") === "401") throw new Error("Samsung FUS authorization failed");
  const rotatedNonce = response.headers.get("nonce") || response.headers.get("NONCE") || "";
  if (rotatedNonce) {
    session.nonce = rotatedNonce;
    session.auth = await authenticateNonce(rotatedNonce);
  }
  const cookie = extractCookies(response);
  if (cookie) session.cookie = cookie;
  return text;
}

async function createSession(fetchImpl, signal) {
  const response = await fetchImpl(`${FUS_BASE}${NONCE_PATH}`, {
    method: "POST",
    headers: { authorization: "FUS nonce=\"\", signature=\"\", nc=\"\", type=\"\", realm=\"\"", "user-agent": FUS_USER_AGENT, "content-type": "application/xml; charset=UTF-8" },
    body: "",
    signal
  });
  const nonce = response.headers.get("nonce") || response.headers.get("NONCE") || "";
  if (!response.ok || !nonce) throw new Error(`Samsung FUS nonce HTTP ${response.status}`);
  return { nonce, auth: await authenticateNonce(nonce), cookie: extractCookies(response) };
}

function decryption(fileName, version, model, csc, logicValue) {
  const name = String(fileName || "").toLowerCase();
  if (name.endsWith(".enc2")) return { mode: "enc2", keySeed: `${csc}:${model}:${version}` };
  if (!name.endsWith(".enc4")) return null;
  const keySeed = logicCheck(version, logicValue);
  if (!keySeed) throw new Error("Samsung FUS did not return a usable decryption key for this firmware");
  return { mode: "enc4", keySeed };
}

function officialDownloadPath(modelPath, fileName) {
  // FUS expects this as a slash-separated path. Encoding the whole value turns
  // slashes into %2F, which Samsung's download endpoint responds to with 404.
  const path = `${String(modelPath || "")}${String(fileName || "")}`;
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) throw new Error("Samsung FUS returned an invalid firmware path");
  return path;
}

export async function resolveVpsOfficialFirmwareDownload(env, model, csc, version, options = {}) {
  const { model: normalizedModel, csc: normalizedCsc } = validateModelCsc(model, csc);
  const fusVersion = await resolveOfficialFirmwareVersion(env, normalizedModel, normalizedCsc, version, options);
  const fetchImpl = options.fetchImpl || fetch;
  const session = await createSession(fetchImpl, options.signal);
  const inform = await request(session, BINARY_INFORM_PATH, binaryInformBody(normalizedModel, normalizedCsc, fusVersion, session.nonce), fetchImpl, options.signal);
  const status = tagValue(inform, "Status");
  if (status && status !== "200" && status !== "S00") throw new Error(`Samsung FUS binary inform returned ${status}`);
  const fileName = tagValue(inform, "BINARY_NAME");
  const modelPath = tagValue(inform, "MODEL_PATH");
  const modelType = tagValue(inform, "DEVICE_MODEL_TYPE");
  const resolvedVersion = tagValue(inform, "BINARY_SW_VERSION") || tagValue(inform, "LATEST_FW_VERSION") || fusVersion;
  if (!fileName || !modelPath || !modelType) throw new Error("Samsung FUS did not return a firmware bundle");
  const downloadPath = officialDownloadPath(modelPath, fileName);
  const init = await request(session, BINARY_INIT_PATH, binaryInitBody(fileName, fusVersion, normalizedCsc, modelType, session.nonce), fetchImpl, options.signal);
  const initStatus = tagValue(init, "Status");
  if (initStatus && initStatus !== "200" && initStatus !== "S00") throw new Error(`Samsung FUS binary init returned ${initStatus}`);
  return {
    sourceUrl: `http://cloud-neofussvr.samsungmobile.com/NF_SmartDownloadBinaryForMass.do?file=${downloadPath}`,
    sourceHeaders: { authorization: cloudAuthorization(session), "user-agent": FUS_USER_AGENT, "cache-control": "no-cache" },
    fileName,
    size: Number(tagValue(inform, "BINARY_BYTE_SIZE") || 0),
    crc32: tagValue(inform, "BINARY_CRC"),
    model: normalizedModel,
    csc: normalizedCsc,
    version: resolvedVersion,
    decryption: decryption(fileName, resolvedVersion, normalizedModel, normalizedCsc, tagValue(inform, "LOGIC_VALUE_FACTORY") || tagValue(inform, "LOGIC_VALUE_HOME")),
    source: "Samsung FUS"
  };
}
