const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function parseSamsungFirmwareString(value) {
  const raw = String(value || "").trim().toUpperCase().split("/")[0];
  const match = raw.match(/^([A-Z][A-Z0-9]{3,5}?)([A-Z]{3})([A-Z0-9])([A-Z])([A-Z])([A-L])([A-Z0-9]+)$/);
  if (!match) return { valid: false, raw };

  const yearCode = match[5];
  const monthCode = match[6];
  const year = 2000 + yearCode.charCodeAt(0) - 64;
  const month = monthCode.charCodeAt(0) - 64;
  const revision = Number.parseInt(match[7], 36);
  return {
    valid: true,
    raw,
    modelCode: match[1],
    model: `SM-${match[1]}`,
    regionCode: match[2],
    bootloader: match[3],
    buildTrack: match[4],
    yearCode,
    year,
    monthCode,
    month,
    monthName: MONTH_NAMES[month - 1],
    revisionCode: match[7],
    revision: Number.isFinite(revision) ? revision : null
  };
}

export function formatSamsungFirmwareDetails(details, lang = "zh") {
  if (!details?.valid) return "";
  if (lang === "en") {
    return `Bootloader ${details.bootloader} | Build ${details.year}-${String(details.month).padStart(2, "0")} | Revision ${details.revisionCode}`;
  }
  return `Bootloader ${details.bootloader} | 构建 ${details.year}-${String(details.month).padStart(2, "0")} | 修订 ${details.revisionCode}`;
}

// SmartHistory does not publish BINARY_OPEN_DATE for every product family.
// Samsung's PDA encodes a reliable year and month, but never a day.
export function inferSamsungFirmwareBuildMonth(value) {
  const record = createFirmwareVersionRecord(value);
  const candidates = record.components.length
    ? record.components
    : [String(value || "").trim()];

  for (const candidate of candidates) {
    const details = parseSamsungFirmwareString(candidate);
    if (!details.valid || !Number.isInteger(details.year) || !Number.isInteger(details.month)) continue;
    if (details.month < 1 || details.month > 12) continue;
    return {
      inferred: true,
      year: details.year,
      month: details.month,
      value: `${details.year}-${String(details.month).padStart(2, "0")}`,
      sourceVersion: details.raw,
      yearCode: details.yearCode,
      monthCode: details.monthCode
    };
  }

  return null;
}


export function createFirmwareVersionRecord(value) {
  const raw = String(value || "").trim();
  const components = raw
    .toUpperCase()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  // v2.8.1 and older synthesized PDA as a fourth component for otherwise
  // normal PDA/CSC/MODEM tuples. Remove only that exact legacy duplicate.
  if (components.length === 4 && components[3] === components[0]) components.pop();

  const canonical = components.join("/");
  return {
    schemaVersion: 1,
    raw,
    components,
    pda: components[0] || "",
    cscVersion: components[1] || "",
    modem: components[2] || "",
    extras: components.slice(3),
    canonical,
    fingerprint: canonical
  };
}

export function normalizeFirmwareVersion(value) {
  return createFirmwareVersionRecord(value).canonical;
}

export function firmwareVersionFingerprint(value) {
  if (value && typeof value === "object") {
    return createFirmwareVersionRecord(value.canonical || value.raw || value.components?.join("/") || "").fingerprint;
  }
  return createFirmwareVersionRecord(value).fingerprint;
}

export function analyzeFirmwareHistory(historyChain) {
  const chain = Array.isArray(historyChain) ? historyChain : [];
  const current = chain.at(-1);
  const previous = chain.at(-2);
  if (!current) return null;
  const currentDetails = parseSamsungFirmwareString(current.version);
  const previousDetails = previous ? parseSamsungFirmwareString(previous.version) : null;
  const hasSequences = previous && current.sequence !== null && current.sequence !== undefined &&
    previous.sequence !== null && previous.sequence !== undefined;
  const sequenceDelta = hasSequences && Number.isFinite(Number(current.sequence)) && Number.isFinite(Number(previous.sequence))
    ? Number(current.sequence) - Number(previous.sequence)
    : null;
  const bootloaderChanged = Boolean(previousDetails?.valid && currentDetails.valid &&
    previousDetails.bootloader !== currentDetails.bootloader);
  return {
    previousVersion: previous?.version || "",
    currentVersion: current.version,
    sequenceDelta,
    bootloaderChanged,
    securityPatchChanged: Boolean(previous && previous.securityPatch !== current.securityPatch),
    upgradeType: !previous ? "initial" : bootloaderChanged ? "bootloader" : "firmware"
  };
}
