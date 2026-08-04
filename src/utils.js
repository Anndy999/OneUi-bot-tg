import { countryForCsc } from "./csc.js";
import {
  createFirmwareVersionRecord,
  firmwareVersionFingerprint as structuredFirmwareVersionFingerprint,
  inferSamsungFirmwareBuildMonth,
  normalizeFirmwareVersion as normalizeStructuredFirmwareVersion,
  parseSamsungFirmwareString
} from "./firmware-version.js";
import { validateModelCsc } from "./targets.js";

export function normalizeText(text) {
  return String(text || "")
    .trim()
    .replace(/[,/:]+/g, " ")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function looksLikeModelText(text) {
  const normalized = normalizeText(text);
  const parts = normalized.split(" ");
  const aliasWithCsc =
    parts.length > 1 &&
    /^[A-Z0-9]{3}$/.test(parts[parts.length - 1]) &&
    resolveDeviceAlias(parts.slice(0, -1).join(" "));
  return (/\d/.test(normalized) || resolveDeviceAlias(normalized) || aliasWithCsc) && normalized.length >= 3 && normalized.length <= 60;
}

export function parseModelQuery(text, defaultCsc = "CHC") {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error("输入为空");

  const fullAliasModel = resolveDeviceAlias(normalized);
  if (fullAliasModel) {
    const { model, csc } = validateModelCsc(normalizeModel(fullAliasModel), (defaultCsc || "CHC").toUpperCase());
    return { model, csc };
  }

  const compact = splitCompactModelCsc(normalized);
  if (compact) {
    return compact;
  }

  const parts = normalized.split(" ");
  const lastPart = parts[parts.length - 1];
  const aliasBeforeTrailingCsc = parts.length > 1 ? resolveDeviceAlias(parts.slice(0, -1).join(" ")) : "";
  const hasTrailingCsc =
    parts.length > 1 &&
    /^[A-Z0-9]{3}$/.test(lastPart) &&
    (Boolean(aliasBeforeTrailingCsc) || canNormalizeModel(parts.slice(0, -1).join(" ")));
  const csc = (hasTrailingCsc ? lastPart : defaultCsc || "CHC").toUpperCase();
  const queryPart = hasTrailingCsc ? parts.slice(0, -1).join(" ") : normalized;
  const aliasModel = aliasBeforeTrailingCsc || resolveDeviceAlias(queryPart);
  const modelPart = aliasModel || parts[0];

  if (!/^[A-Z0-9-]+$/.test(modelPart)) {
    throw new Error("型号格式不正确");
  }
  if (!/^[A-Z0-9]{3}$/.test(csc)) {
    throw new Error("CSC 格式不正确");
  }

  const target = validateModelCsc(normalizeModel(modelPart), csc);
  return { model: target.model, csc: target.csc };
}

export function normalizeModel(input) {
  const value = String(input || "").trim().toUpperCase();
  if (!value) throw new Error("型号不能为空");
  if (value.startsWith("SM-") || value.startsWith("SC-")) return value;
  if (SHORT_MODEL_ALIASES[value]) return SHORT_MODEL_ALIASES[value];
  if (/^[SAMFGRLQX][0-9][0-9A-Z]+$/.test(value)) return `SM-${value}`;
  if (/^[0-9][0-9A-Z]+$/.test(value)) {
    const family = value.startsWith("0") ? "A" : "S";
    return `SM-${family}${value}`;
  }
  throw new Error("无法识别型号");
}

function splitCompactModelCsc(input) {
  const value = String(input || "").trim().toUpperCase();
  if (value.includes(" ") || value.length < 6) return null;
  const csc = value.slice(-3);
  const modelPart = value.slice(0, -3);
  if (!/^[A-Z0-9]{3}$/.test(csc)) return null;
  if (!modelPart) return null;

  const candidates = [modelPart];
  if (modelPart.startsWith("SM-")) candidates.push(modelPart);
  if (!modelPart.startsWith("SM-") && /^[A-Z][0-9][0-9A-Z]+$/.test(modelPart)) candidates.push(`SM-${modelPart}`);
  if (/^[0-9][0-9A-Z]+$/.test(modelPart)) {
    candidates.push(`SM-${modelPart.startsWith("0") ? "A" : "S"}${modelPart}`);
  }

  for (const candidate of candidates) {
    if (canNormalizeModel(candidate)) {
      const target = validateModelCsc(normalizeModel(candidate), csc);
      return { model: target.model, csc: target.csc };
    }
  }
  return null;
}

function canNormalizeModel(input) {
  try {
    normalizeModel(input);
    return true;
  } catch {
    return false;
  }
}

export function resolveDeviceAlias(input) {
  const key = normalizeAliasKey(input);
  const ringMatch = key.match(/^(?:GALAXY )?RING\s+(?:SM-)?(?:Q)?(50[0-9]|51[45])$/);
  if (ringMatch) return `SM-Q${ringMatch[1]}`;
  return DEVICE_ALIASES[key] || "";
}

function normalizeAliasKey(input) {
  return String(input || "")
    .trim()
    .replace(/[,/]+/g, " ")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

const SHORT_MODEL_ALIASES = {
  "930": "SM-X930",
  "936C": "SM-X936C"
};

const KNOWN_FIRMWARE_CSC_CORRECTIONS = {
  "SM-X930:CHC": {
    suggestedCsc: "CHN",
    noteZh: "Galaxy Tab S11 Ultra 国行 Wi-Fi 版使用 CHN；CHC 用于其他中国蜂窝型号。",
    noteEn: "The mainland China Wi-Fi variant uses CHN; CHC is used by other China cellular variants."
  },
  "SM-X936C:CHN": {
    suggestedCsc: "CHC",
    noteZh: "Galaxy Tab S11 Ultra 国行 5G 版 SM-X936C 使用 CHC。",
    noteEn: "The mainland China 5G variant SM-X936C uses CHC."
  }
};

export function knownFirmwareCscCorrection(model, csc) {
  const key = `${String(model || "").trim().toUpperCase()}:${String(csc || "").trim().toUpperCase()}`;
  const correction = KNOWN_FIRMWARE_CSC_CORRECTIONS[key];
  return correction ? { ...correction } : null;
}

const DEVICE_ALIASES = {
  "TAB11U WIFI": "SM-X930",
  "TAB 11 ULTRA WIFI": "SM-X930",
  "TAB S11 ULTRA WIFI": "SM-X930",
  "GALAXY TAB S11 ULTRA WIFI": "SM-X930",
  "TAB11U 5G": "SM-X936C",
  "TAB 11 ULTRA 5G": "SM-X936C",
  "TAB S11 ULTRA 5G": "SM-X936C",
  "GALAXY TAB S11 ULTRA 5G": "SM-X936C",

  "WATCH8 40": "SM-L320",
  "WATCH8 40MM": "SM-L320",
  "WATCH 8 40": "SM-L320",
  "WATCH 8 40MM": "SM-L320",
  "GALAXY WATCH8 40MM": "SM-L320",
  "WATCH8 44": "SM-L330",
  "WATCH8 44MM": "SM-L330",
  "WATCH 8 44": "SM-L330",
  "WATCH 8 44MM": "SM-L330",
  "GALAXY WATCH8 44MM": "SM-L330",
  "WATCH8 44 LTE": "SM-L3350",
  "WATCH8 44MM LTE": "SM-L3350",
  "WATCH 8 44 LTE": "SM-L3350",
  "GALAXY WATCH8 44MM LTE": "SM-L3350",
  "WATCH8 CLASSIC BLUETOOTH": "SM-L500",
  "WATCH 8 CLASSIC BLUETOOTH": "SM-L500",
  "GALAXY WATCH8 CLASSIC BLUETOOTH": "SM-L500",
  "WATCH8 CLASSIC LTE": "SM-L5050",
  "WATCH 8 CLASSIC LTE": "SM-L5050",
  "GALAXY WATCH8 CLASSIC LTE": "SM-L5050",
  "WATCH ULTRA 2025": "SM-L7050",
  "GALAXY WATCH ULTRA 2025": "SM-L7050",

  "BUDS3 PRO": "SM-R630",
  "GALAXY BUDS3 PRO": "SM-R630",
  "BUDS 3 PRO": "SM-R630",
  "GALAXY BUDS 3 PRO": "SM-R630",
  "BUDS3": "SM-R530",
  "GALAXY BUDS3": "SM-R530",
  "BUDS 3": "SM-R530",
  "GALAXY BUDS 3": "SM-R530",
  "BUDS FE": "SM-R400",
  "GALAXY BUDS FE": "SM-R400",
  "BUDS2 PRO": "SM-R510",
  "GALAXY BUDS2 PRO": "SM-R510",
  "BUDS 2 PRO": "SM-R510",
  "GALAXY BUDS 2 PRO": "SM-R510",
  "BUDS2": "SM-R177",
  "GALAXY BUDS2": "SM-R177",
  "BUDS PRO": "SM-R190",
  "GALAXY BUDS PRO": "SM-R190",
  "BUDS LIVE": "SM-R180",
  "GALAXY BUDS LIVE": "SM-R180",
  "BUDS PLUS": "SM-R175",
  "BUDS+": "SM-R175",
  "GALAXY BUDS PLUS": "SM-R175",
  "GALAXY BUDS+": "SM-R175",
  "BUDS": "SM-R170",
  "GALAXY BUDS": "SM-R170",

  "WATCH ULTRA": "SM-L700",
  "GALAXY WATCH ULTRA": "SM-L700",
  "WATCH7": "SM-L300",
  "GALAXY WATCH7": "SM-L300",
  "WATCH 7": "SM-L300",
  "GALAXY WATCH 7": "SM-L300",
  "WATCH7 44": "SM-L310",
  "WATCH 7 44": "SM-L310",
  "WATCH7 44MM": "SM-L310",
  "WATCH 7 44MM": "SM-L310",
  "WATCH7 40": "SM-L300",
  "WATCH 7 40": "SM-L300",
  "WATCH7 40MM": "SM-L300",
  "WATCH 7 40MM": "SM-L300",
  "WATCH6": "SM-R930",
  "GALAXY WATCH6": "SM-R930",
  "WATCH 6": "SM-R930",
  "GALAXY WATCH 6": "SM-R930",
  "WATCH6 CLASSIC": "SM-R950",
  "GALAXY WATCH6 CLASSIC": "SM-R950",
  "WATCH 6 CLASSIC": "SM-R950",
  "GALAXY WATCH 6 CLASSIC": "SM-R950",
  "WATCH5": "SM-R900",
  "GALAXY WATCH5": "SM-R900",
  "WATCH 5": "SM-R900",
  "GALAXY WATCH 5": "SM-R900",
  "WATCH5 PRO": "SM-R920",
  "GALAXY WATCH5 PRO": "SM-R920",
  "WATCH 5 PRO": "SM-R920",
  "GALAXY WATCH 5 PRO": "SM-R920",

  "RING": "SM-Q500",
  "GALAXY RING": "SM-Q500"
};


export function normalizeFirmwareVersion(version) {
  return normalizeStructuredFirmwareVersion(version);
}

export function firmwareVersionFingerprint(version) {
  return structuredFirmwareVersionFingerprint(version);
}

export { createFirmwareVersionRecord };

export function docUrl(model, csc) {
  return `https://doc.samsungmobile.com/${model}/${csc}/doc.html`;
}

export function firmwareKey(model, csc) {
  return `firmware:last:${validateModelCsc(model, csc).key}`;
}

export function ackedUpdateKey(model, csc) {
  return `acked:update:${validateModelCsc(model, csc).key}`;
}

export function buildUserQueryCacheKey(chatId, model, csc) {
  return `query:cache:${String(chatId)}:${validateModelCsc(model, csc).key}`;
}

export function pendingUpdateKey(model, csc) {
  return `pending:update:${validateModelCsc(model, csc).key}`;
}

export function monitorRunKey(dateKey, slot) {
  return `monitor:run:${dateKey}:${slot}`;
}

export function formatBeijingTime(date = new Date(), lang = "zh") {
  const parts = beijingParts(date);
  const suffix = lang === "en" ? "Beijing Time" : "北京时间";
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${suffix}`;
}

export function beijingParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short"
  });
  const mapped = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") mapped[part.type] = part.value;
  }
  return {
    year: mapped.year,
    month: mapped.month,
    day: mapped.day,
    hour: mapped.hour === "24" ? "00" : mapped.hour,
    minute: mapped.minute,
    second: mapped.second,
    weekday: mapped.weekday
  };
}

export function beijingDateKey(date = new Date()) {
  const parts = beijingParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function beijingTimeSlot(date = new Date()) {
  const parts = beijingParts(date);
  return `${parts.hour}:${parts.minute}`;
}

export function timeToMinutes(value) {
  const normalized = normalizeClockTime(value);
  const match = normalized.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

export function normalizeClockTime(value) {
  const raw = String(value || "").trim();
  let match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  match = raw.match(/^(\d{3,4})$/);
  if (match) {
    const digits = match[1].padStart(4, "0");
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2, 4));
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  return "";
}

export function minutesToTime(minutes) {
  const safe = ((minutes % 1440) + 1440) % 1440;
  const hour = String(Math.floor(safe / 60)).padStart(2, "0");
  const minute = String(safe % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

function displayAndroidVersion(value, lang = "zh") {
  const raw = String(value || "").trim();
  if (!raw) return lang === "en" ? "Unknown" : "未知";
  const androidMatch = raw.match(/Android\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (androidMatch) return androidMatch[1];
  const plainMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)$/);
  if (plainMatch) return plainMatch[1];
  return raw;
}

export function firmwareBuildDateDisplay(result, lang = "zh") {
  const rawOfficial = String(result?.buildDate || result?.smartHistory?.openDate || "").trim();
  const official = /^(?:unknown|n\/?a|none|null|undefined|未知|无|-|0+|0000[-/]?00[-/]?00)$/i.test(rawOfficial)
    ? ""
    : rawOfficial;
  if (official) {
    return {
      value: official,
      inferred: false,
      text: official
    };
  }

  const inferred = inferSamsungFirmwareBuildMonth(result?.pda || result?.latest || "");
  if (inferred) {
    return {
      ...inferred,
      text: lang === "en"
        ? `${inferred.value} (month inferred from firmware version)`
        : `${inferred.value}（月份由版本号推算）`
    };
  }

  const fallback = lang === "en" ? "Unknown" : "未知";
  return {
    value: "",
    inferred: false,
    text: fallback
  };
}

export function formatFirmwareResult(result, options = {}) {
  const lang = options.lang || "zh";
  const elapsedMs = Number(options.elapsedMs);
  const country = result.country || countryForCsc(result.csc);
  const buildDate = firmwareBuildDateDisplay(result, lang).text;
  const cachedTime = options.cachedAt || "";
  const cacheAgeSeconds = cachedTime
    ? Math.max(0, Math.floor((Date.now() - new Date(cachedTime).getTime()) / 1000))
    : null;
  const cacheLabel = cacheAgeSeconds === null
    ? (lang === "en" ? "Live" : "实时")
    : (lang === "en" ? `Cached ${cacheAgeSeconds}s ago` : `缓存 ${cacheAgeSeconds} 秒前`);
  const latest = normalizeFirmwareVersion(result.latest) || String(result.latest || "").trim();

  if (lang === "en") {
    const lines = [
      "📱 Samsung Firmware Query",
      "",
      `${result.model} · ${result.csc}${country ? ` (${country})` : ""}`,
      "",
      "Latest official version",
      latest,
      "",
      `Android: ${displayAndroidVersion(result.android, "en")}`,
      `Build date: ${buildDate}`
    ];
    if (Number.isFinite(elapsedMs)) lines.push("", `⏱ Query latency: ${elapsedMs} ms`);
    if (result.sourceType === "version_xml") {
      lines.push("", "⚠️ Showing the latest official Samsung version.xml metadata.");
    } else if (result.fallbackUsed || options.fallbackReason || result.degraded) {
      lines.push("", "⚠️ Samsung is temporarily unavailable. This is the last exact CSC SmartHistory record and may not include a newly released build.");
    }
    lines.push(result.sourceType === "version_xml"
      ? "📡 Samsung FOTA version.xml · official metadata"
      : `📡 Samsung SmartHistory · ${cacheLabel}`);
    return lines.join("\n");
  }

  const lines = [
    "📱 三星固件查询",
    "",
    `${result.model} · ${result.csc}${country ? `（${country}）` : ""}`,
    "",
    "最新正式版本",
    latest,
    "",
    `Android：${displayAndroidVersion(result.android, "zh")}`,
    `构建日期：${buildDate}`
  ];
  if (Number.isFinite(elapsedMs)) lines.push("", `⏱ 查询耗时：${elapsedMs} ms`);
  if (result.sourceType === "version_xml") {
    lines.push("", "⚠️ 当前使用三星官方 version.xml 元数据，SmartHistory 暂无可用记录。");
  } else if (result.fallbackUsed || options.fallbackReason || result.degraded) {
    lines.push("", "⚠️ 三星服务器暂时无法连接，当前返回最后一次精确 CSC 的 SmartHistory 记录，可能尚未包含刚发布的新版本。");
  }
  lines.push(result.sourceType === "version_xml"
    ? "📡 Samsung FOTA version.xml · 官方元数据"
    : `📡 Samsung SmartHistory · ${cacheLabel}`);
  return lines.join("\n");
}

export function firmwareCacheValue(chatId, model, csc, parsed) {
  return {
    chatId: String(chatId),
    model,
    csc,
    country: parsed.country || countryForCsc(csc),
    latest: normalizeFirmwareVersion(parsed.latest),
    rawLatest: parsed.latest,
    firmwareVersion: createFirmwareVersionRecord(parsed.latest),
    versionDetails: parsed.versionDetails || parseSamsungFirmwareString(parsed.pda || parsed.latest),
    versionFingerprint: firmwareVersionFingerprint(parsed.latest),
    pda: parsed.pda,
    cscVersion: parsed.cscVersion,
    modem: parsed.modem || "N/A",
    android: parsed.android || "未知",
    buildDate: parsed.buildDate || parsed.smartHistory?.openDate || "",
    securityPatch: parsed.securityPatch || parsed.smartHistory?.securityPatch || "",
    docUrl: parsed.docUrl || docUrl(model, csc),
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    fallbackUsed: Boolean(parsed.fallbackUsed),
    fallbackReason: parsed.fallbackReason || "",
    smartHistory: parsed.smartHistory || null,
    selectedSource: "history",
    degraded: Boolean(parsed.degraded),
    fetchedAt: parsed.fetchedAt || new Date().toISOString(),
    servedAt: new Date().toISOString(),
    cachedAt: parsed.fetchedAt || new Date().toISOString()
  };
}

function formatSourceLine(source, lang = "zh") {
  const value = String(source || "");
  if (/History L1 Cache/i.test(value)) return lang === "en" ? "Source: History L1 Memory Cache" : "来源：History L1 内存缓存";
  if (/History KV Cache/i.test(value)) return lang === "en" ? "Source: History KV Cache" : "来源：History KV 权威缓存";
  if (/Stale History Cache/i.test(value)) return lang === "en" ? "Source: Stale exact History Cache (degraded)" : "来源：精确 History 旧缓存（降级）";
  if (/Global Cache/i.test(value)) return lang === "en" ? "Source: Cloudflare Global Cache" : "来源：Cloudflare 全局缓存";
  if (/SmartHistory/i.test(value)) return lang === "en" ? "Source: Samsung FUS SmartHistory" : "来源：Samsung FUS SmartHistory";
  return lang === "en" ? "Source: " + value : "来源：" + value;
}

export function formatQueryFailure(reason, lang = "zh") {
  const message = friendlyQueryFailureReason(reason, lang);
  if (lang === "en") {
    return [
      `❌ Firmware query failed`,
      "",
      message,
      "",
      "Check that the model and CSC are an exact official pair, then try:",
      "SM-S9480 TGY",
      "9480 tgy",
      "SM-S9480/TGY"
    ].join("\n");
  }
  return [
    "❌ 暂时无法查询该固件",
    "",
    message,
    "",
    "请确认型号与 CSC 是合法的精确组合，然后尝试：",
    "SM-S9480 TGY",
    "9480 tgy",
    "SM-S9480/TGY"
  ].join("\n");
}

function friendlyQueryFailureReason(reason, lang = "zh") {
  const raw = String(reason || "").trim();
  const lower = raw.toLowerCase();

  if (lower.includes("latest") || raw.includes("latest 字段为空")) {
    return lang === "en"
      ? "Samsung returned a device record, but the latest firmware field is empty. This usually means the model or CSC is not publicly available yet."
      : "三星服务器返回了该设备记录，但 latest 字段为空。通常表示这个型号或 CSC 暂时没有公开完整固件版本。";
  }

  if (raw.includes("403") || raw.includes("404") || raw.includes("公开固件记录") || lower.includes("public")) {
    return lang === "en"
      ? "This model or CSC may not have publicly available firmware records. Try another CSC such as XAA, EUX, INS, CHC, KOO, or TGY."
      : "该型号或 CSC 可能没有公开固件记录。可以尝试其它 CSC，例如 XAA、EUX、INS、CHC、KOO、TGY。";
  }

  if (lower.includes("timeout") || raw.includes("超时")) {
    return lang === "en"
      ? "Connection timed out. Please try again later."
      : "连接超时，请稍后再试。";
  }

  return raw || (lang === "en" ? "Unknown error" : "未知错误");
}

export function unauthorizedQueryText(lang = "zh") {
  if (lang === "en") {
    return [
      "You do not have permission to use firmware query.",
      "",
      "Send /apply to request whitelist access,",
      "or send /whoami and share your Chat ID with the owner."
    ].join("\n");
  }
  return [
    "你没有权限使用查询功能。",
    "",
    "你可以发送 /apply 申请白名单权限，",
    "或发送 /whoami，把 Chat ID 发给管理员开通。"
  ].join("\n");
}

export function formatMonitorNotification(item, oldLatest, parsed, now = new Date(), lang = "zh", includeAck = true, options = {}) {
  return formatUpdateNotificationCard(item, oldLatest, parsed, now, lang, includeAck, options);
}

export function formatUpdateNotificationCard(item, oldLatest, parsed, now = new Date(), lang = "zh", includeAck = true, options = {}) {
  {
  // Update notices are intentionally compact. The monitor is autonomous, so
  // no acknowledgement state, retry prompt, device nickname, Android version,
  // or build date is included here.
  const previousVersion = normalizeFirmwareVersion(oldLatest) || String(oldLatest || "").trim() || "N/A";
  const currentVersion = normalizeFirmwareVersion(parsed.latest) || String(parsed.latest || "").trim() || "N/A";
  const source = parsed.source === "Samsung FOTA version.xml"
    ? "Samsung FOTA version.xml"
    : "Samsung SmartHistory";
  const deviceLine = `${item.model} / ${item.csc}`;
  if (lang === "en") {
    return [
      "\u{1F680} Samsung firmware updated",
      "",
      deviceLine,
      "",
      "Old version",
      previousVersion,
      "",
      "New version",
      currentVersion,
      "",
      `Detected at: ${formatBeijingTime(now, "en")}`,
      "",
      `\u{1F4C4} ${source}`
    ].join("\n");
  }
  return [
    "\u{1F680} \u53d1\u73b0\u4e09\u661f\u6b63\u5f0f\u56fa\u4ef6\u66f4\u65b0",
    "",
    deviceLine,
    "",
    "\u65e7\u7248\u672c",
    previousVersion,
    "",
    "\u65b0\u7248\u672c",
    currentVersion,
    "",
    `\u53d1\u73b0\u65f6\u95f4\uff1a${formatBeijingTime(now, "zh")}`,
    "",
    `\u{1F4C4} ${source}`
  ].join("\n");
  }

  const fallbackName = `${item.model} / ${item.csc}`;
  const deviceName = String(item.name || "").trim();
  const showDeviceName = Boolean(deviceName) && deviceName !== fallbackName && deviceName !== `${item.model} ${item.csc}`;
  const country = parsed.country || countryForCsc(item.csc);
  const buildDate = firmwareBuildDateDisplay(parsed, lang).text;
  const reminderMinutes = Math.max(1, Number(options.reminderMinutes || 5));
  const previousVersion = normalizeFirmwareVersion(oldLatest) || String(oldLatest || "").trim() || (lang === "en" ? "N/A" : "未知");
  const currentVersion = normalizeFirmwareVersion(parsed.latest) || String(parsed.latest || "").trim() || (lang === "en" ? "N/A" : "未知");
  if (lang === "en") {
    const lines = [
      includeAck ? "🚨 Official Samsung firmware detected" : "🚀 Official Samsung firmware updated",
      ""
    ];
    if (showDeviceName) lines.push(deviceName);
    lines.push(
      `${item.model} · ${item.csc}${country ? ` (${country})` : ""}`,
      "",
      "Old version",
      previousVersion,
      "",
      "New version",
      currentVersion,
      "",
      `Android: ${displayAndroidVersion(parsed.android, "en")}`,
      `Build date: ${buildDate}`,
      `Detected at: ${formatBeijingTime(now, "en")}`,
      "",
      "📡 Samsung SmartHistory"
    );
    if (includeAck) {
      lines.push("⏳ Choose the next monitoring plan", `A reminder will be sent every ${reminderMinutes} minutes until a choice is made.`);
    }
    return lines.join("\n");
  }
  const lines = [
    includeAck ? "🚨 发现三星正式固件更新" : "🚀 三星正式固件已更新",
    ""
  ];
  if (showDeviceName) lines.push(deviceName);
  lines.push(
    `${item.model} · ${item.csc}${country ? `（${country}）` : ""}`,
    "",
    "旧版本",
    previousVersion,
    "",
    "新版本",
    currentVersion,
    "",
    `Android：${displayAndroidVersion(parsed.android, "zh")}`,
    `构建日期：${buildDate}`,
    `发现时间：${formatBeijingTime(now, "zh")}`,
    "",
    "📡 Samsung SmartHistory"
  );
  if (includeAck) {
    lines.push("⏳ 请选择后续监控计划", `未选择前每 ${reminderMinutes} 分钟提醒一次。`);
  }
  return lines.join("\n");
}

export function formatMonitorBaseline(item, parsed, now = new Date(), lang = "zh") {
  const fallbackName = `${item.model} / ${item.csc}`;
  const deviceName = String(item.name || "").trim();
  const showDeviceName = Boolean(deviceName) && deviceName !== fallbackName && deviceName !== `${item.model} ${item.csc}`;
  const country = parsed.country || countryForCsc(item.csc);
  const currentVersion = normalizeFirmwareVersion(parsed.latest) || String(parsed.latest || "").trim() || (lang === "en" ? "N/A" : "未知");
  if (lang === "en") {
    const lines = ["✅ Firmware monitoring baseline created", ""];
    if (showDeviceName) lines.push(deviceName);
    lines.push(
      `${item.model} · ${item.csc}${country ? ` (${country})` : ""}`,
      "",
      "Current official version",
      currentVersion,
      "",
      `Baseline time: ${formatBeijingTime(now, "en")}`,
      "Future official version changes will be reported immediately."
    );
    return lines.join("\n");
  }
  const lines = ["✅ 已建立固件监控基线", ""];
  if (showDeviceName) lines.push(deviceName);
  lines.push(
    `${item.model} · ${item.csc}${country ? `（${country}）` : ""}`,
    "",
    "当前正式版本",
    currentVersion,
    "",
    `建立时间：${formatBeijingTime(now, "zh")}`,
    "后续检测到正式版本变化时将立即通知。"
  );
  return lines.join("\n");
}

export function formatReminder(pending, count, now = new Date(), lang = "zh", options = {}) {
  return formatUpdateReminderCard(pending, count, now, lang, options);
}

export function formatUpdateReminderCard(pending, count, now = new Date(), lang = "zh", options = {}) {
  const reminderMinutes = Math.max(1, Number(options.reminderMinutes || 5));
  const fallbackName = `${pending.model} / ${pending.csc}`;
  const deviceName = String(pending.name || "").trim();
  const showDeviceName = Boolean(deviceName) && deviceName !== fallbackName && deviceName !== `${pending.model} ${pending.csc}`;
  const currentVersion = normalizeFirmwareVersion(pending.newLatest) || String(pending.newLatest || "").trim() || (lang === "en" ? "N/A" : "未知");
  if (lang === "en") {
    const lines = ["⏰ Firmware update awaiting confirmation", ""];
    if (showDeviceName) lines.push(deviceName);
    lines.push(
      `${pending.model} · ${pending.csc}`,
      "",
      "New version",
      currentVersion,
      "",
      `Reminder: ${count}`,
      `Time: ${formatBeijingTime(now, "en")}`,
      `Reminder interval: ${reminderMinutes} minutes`,
      "",
      "Choose Continue as planned or Resume later to stop reminders."
    );
    return lines.join("\n");
  }
  const lines = ["⏰ 固件更新等待确认", ""];
  if (showDeviceName) lines.push(deviceName);
  lines.push(
    `${pending.model} · ${pending.csc}`,
    "",
    "新版本",
    currentVersion,
    "",
    `提醒次数：第 ${count} 次`,
    `提醒时间：${formatBeijingTime(now, "zh")}`,
    `提醒间隔：${reminderMinutes} 分钟`,
    "",
    "请选择“按原计划继续”或“稍后恢复”，选择后停止提醒。"
  );
  return lines.join("\n");
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
