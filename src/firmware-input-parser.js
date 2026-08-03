import { parseModelQuery, resolveDeviceAlias } from "./utils.js";

function normalizeInput(value) {
  return String(value || "")
    .trim()
    .replace(/[,/:]+/g, " ")
    .replace(/\s+/g, " ");
}

function sourceFormat(raw) {
  if (raw.includes(":")) return "model_colon_csc";
  if (raw.includes("/")) return "model_slash_csc";
  if (/^SM-/i.test(raw)) return "full_model_space_csc";
  if (/^[A-Z]\d/i.test(raw)) return "short_prefixed_model_space_csc";
  return "short_model_space_csc";
}

export function parseFirmwareInput(text, defaultCsc = "CHC") {
  const raw = String(text || "").trim();
  const normalized = normalizeInput(raw);
  if (!normalized) return { matched: false, reason: "empty" };

  const parts = normalized.split(" ");
  const trailingCsc = parts.length > 1 && /^[A-Z0-9]{3}$/i.test(parts.at(-1));
  const modelText = trailingCsc ? parts.slice(0, -1).join(" ") : normalized;
  const resemblesModel = /\d/.test(modelText) || Boolean(resolveDeviceAlias(modelText));

  if (!trailingCsc) {
    return {
      matched: false,
      reason: resemblesModel ? "missing_csc" : "unrecognized"
    };
  }

  try {
    const target = parseModelQuery(normalized, defaultCsc);
    return {
      matched: true,
      model: target.model,
      csc: target.csc,
      sourceFormat: sourceFormat(raw)
    };
  } catch (error) {
    return {
      matched: false,
      reason: "invalid_target",
      error: String(error?.message || error)
    };
  }
}

export function firmwareInputHelp(lang = "zh", reason = "unrecognized", details = {}) {
  if (reason === "csc_mismatch") {
    const current = `${details.model || "MODEL"} ${details.csc || "CSC"}`;
    const suggested = details.suggestedInput || `${details.model || "MODEL"} ${details.suggestedCsc || "CSC"}`;
    if (lang === "en") {
      return [
        "This model and CSC combination is a known mismatch.",
        "",
        `Entered: ${current}`,
        `Suggested: ${suggested}`,
        details.noteEn ? `Note: ${details.noteEn}` : "",
        "",
        `Send directly: ${suggested}`
      ].filter(Boolean).join("\n");
    }
    return [
      "检测到这个型号与 CSC 组合通常不匹配。",
      "",
      `你输入：${current}`,
      `建议使用：${suggested}`,
      details.noteZh ? `说明：${details.noteZh}` : "",
      "",
      `直接发送：${suggested}`
    ].filter(Boolean).join("\n");
  }

  if (lang === "en") {
    const headline = reason === "missing_csc"
      ? "A CSC is required for an exact firmware query."
      : "The device model could not be recognized.";
    return [
      headline,
      "",
      "Send a model and CSC, for example:",
      "Phone: SM-S9480 TGY",
      "Tablet: tab11u wifi CHN",
      "Watch: watch8 44 CHC"
    ].join("\n");
  }
  const headline = reason === "missing_csc"
    ? "精确固件查询需要同时输入 CSC。"
    : "无法识别设备型号。";
  return [
    headline,
    "",
    "请按以下格式输入：",
    "手机：SM-S9480 TGY",
    "平板：tab11u wifi CHN",
    "手表：watch8 44 CHC"
  ].join("\n");
}
