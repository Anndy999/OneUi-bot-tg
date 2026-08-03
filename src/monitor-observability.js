function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function classifyError(message) {
  const value = String(message || "");
  if (/(?:HTTP 403|HTTP 404|exact CSC|no matching CSC|no usable firmware|未找到|没有公开固件)/i.test(value)) {
    return "configuration";
  }
  if (/(?:HTTP 52\d|HTTP 5\d\d|timeout|timed out|network|fetch failed|nonce|circuit)/i.test(value)) {
    return "upstream";
  }
  return "transient";
}

export function classifySamsungSourceHealth(runtime = {}, now = Date.now()) {
  const failureCount = Math.max(0, Number(runtime.failureCount || 0));
  const lastError = String(runtime.lastError || "").trim();
  const retryAt = timestamp(runtime.nextAttemptAt);
  const lastSuccessAt = timestamp(runtime.lastSuccessAt);
  if (!failureCount) {
    return {
      state: "healthy",
      errorKind: "",
      score: 100,
      failureCount: 0,
      retryAt,
      lastSuccessAt
    };
  }

  const errorKind = classifyError(lastError);
  const state = errorKind === "configuration"
    ? "configuration"
    : failureCount >= 3
      ? "attention"
      : "retrying";
  const basePenalty = errorKind === "configuration" ? 55 : errorKind === "upstream" ? 18 : 25;
  return {
    state,
    errorKind,
    score: Math.max(0, 100 - basePenalty - (failureCount - 1) * 12),
    failureCount,
    retryAt,
    lastSuccessAt,
    retrying: retryAt > now
  };
}

export function summarizeSamsungSourceHealth(entries = [], now = Date.now()) {
  const summary = {
    healthy: 0,
    retrying: 0,
    attention: 0,
    configuration: 0,
    averageScore: 100
  };
  const health = entries.map((entry) => classifySamsungSourceHealth(entry?.runtime || entry || {}, now));
  if (!health.length) return summary;
  let total = 0;
  for (const item of health) {
    summary[item.state] += 1;
    total += item.score;
  }
  summary.averageScore = Math.round(total / health.length);
  return summary;
}

export function formatSamsungSourceHealth(health, lang = "zh") {
  const en = lang === "en";
  const labels = en
    ? {
      healthy: "Healthy",
      retrying: "Retrying Samsung",
      attention: "Needs attention",
      configuration: "Check model / CSC"
    }
    : {
      healthy: "正常",
      retrying: "三星源重试中",
      attention: "需要关注",
      configuration: "请检查机型 / CSC"
    };
  return labels[health?.state] || labels.healthy;
}
