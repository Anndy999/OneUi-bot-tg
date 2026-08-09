#!/usr/bin/env python3
"""Samsung test-build hash resolver.

This is the server-only, non-download part extracted from the supplied
decrypter10.py reference.  It deliberately contains no Telegram, FUS,
firmware download, device identity, or user-interface code.

The reference implementation provides a verifiable MD5(version) mapping.
The supplied APK also contains a native brute-force bridge, but its native
library is not present in the APK, so its private HMAC-SHA256 routine cannot
be safely transplanted. 64-character hashes are therefore reported as
unresolved instead of being guessed.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone


BASE_URL = "https://fota-cloud-dn.ospserver.net/firmware"
USER_AGENT = "OneUI-Firmware-TestBuild-Resolver/1.0"
HEX32 = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
HEX64 = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
DEFAULT_TIMEOUT_SECONDS = 12
DEFAULT_MAX_CANDIDATES = 10_000_000
PROGRESS_PREFIX = "ONEUI_TEST_FIRMWARE_PROGRESS "
SAMSUNG_CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
SAMSUNG_YEAR_CODES = "UVWXYZ"
# HashFirm's recent public updates include T engineering builds. Keep E as
# the existing mixed AP variant below, while adding T as a normal AP/CP
# feature so the common candidate path remains bounded.
SAMSUNG_FEATURE_CODES = "UST"


def emit_progress(phase: str, candidates: int = 0, max_candidates: int = 0, matched: int = 0) -> None:
    """Emit a small machine-readable progress event on stderr only."""
    event = {
        "phase": str(phase),
        "candidates": max(0, int(candidates)),
        "maxCandidates": max(0, int(max_candidates)),
        "matched": max(0, int(matched)),
    }
    try:
        sys.stderr.write(PROGRESS_PREFIX + json.dumps(event, separators=(",", ":")) + "\n")
        sys.stderr.flush()
    except (BrokenPipeError, OSError):
        pass


class ResolverError(Exception):
    """Expected, safe-to-report resolver failure."""

    def __init__(self, message: str, code: str = "resolver_error", status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


def normalize_model(value: object) -> str:
    clean = str(value or "").strip().upper()
    return clean if clean.startswith("SM-") else f"SM-{clean}"


def normalize_csc(value: object) -> str:
    return str(value or "").strip().upper()


def hash_type(value: str) -> str | None:
    clean = str(value or "").strip().lower()
    if HEX32.fullmatch(clean):
        return "md5"
    if HEX64.fullmatch(clean):
        return "sha256"
    return None


def request_version_test_xml(model: str, csc: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> bytes:
    url = f"{BASE_URL}/{urllib.parse.quote(csc)}/{urllib.parse.quote(model)}/version.test.xml"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.1"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200) or 200)
            body = response.read(4 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        raise ResolverError(f"version.test.xml HTTP {exc.code}", "http_status", exc.code) from exc
    except urllib.error.URLError as exc:
        raise ResolverError(f"version.test.xml network error: {exc.reason}", "network_error") from exc
    except TimeoutError as exc:
        raise ResolverError("version.test.xml request timed out", "timeout") from exc
    except OSError as exc:
        raise ResolverError(f"version.test.xml network error: {exc}", "network_error") from exc
    if status < 200 or status >= 300:
        raise ResolverError(f"version.test.xml HTTP {status}", "http_status", status)
    if not body:
        raise ResolverError("version.test.xml returned an empty body", "empty_response")
    if len(body) > 4 * 1024 * 1024:
        raise ResolverError("version.test.xml response is too large", "response_too_large")
    return body


def parse_version_test_xml(content: bytes | str) -> tuple[list[dict[str, str]], str]:
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        raise ResolverError("version.test.xml is malformed", "malformed_xml") from exc

    hashes: list[dict[str, str]] = []
    seen: set[str] = set()
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1].lower() != "value":
            continue
        value = "".join(element.itertext()).strip().lower()
        kind = hash_type(value)
        if not kind:
            continue
        key = f"{kind}:{value}"
        if key not in seen:
            seen.add(key)
            hashes.append({"hash_type": kind, "hash_value": value})

    latest = ""
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1].lower() == "latest":
            candidate = "".join(element.itertext()).strip()
            if candidate:
                latest = candidate
                break
    return hashes, latest


def next_char(value: str) -> str:
    if not value:
        return value
    if value == "9":
        return "A"
    if value == "Z":
        return "Z"
    return chr(ord(value) + 1)


def previous_char(value: str) -> str:
    if not value or value in ("A", "0"):
        return value
    return chr(ord(value) - 1)


def letters_range(start: str, end: str) -> str:
    if not start or not end or ord(start) > ord(end):
        return ""
    return "".join(chr(code) for code in range(ord(start), ord(end) + 1))


def samsung_code_range(start: str, end: str) -> str:
    """Return Samsung's 0-9,A-Z code range without punctuation characters."""
    try:
        first = SAMSUNG_CODE_ALPHABET.index(start)
        last = SAMSUNG_CODE_ALPHABET.index(end)
    except ValueError:
        return ""
    return SAMSUNG_CODE_ALPHABET[first:last + 1] if first <= last else ""


def samsung_year_range(start: str, end: str) -> str:
    """Return the supported Samsung year-code range (U through Z)."""
    try:
        first = SAMSUNG_YEAR_CODES.index(start)
        last = SAMSUNG_YEAR_CODES.index(end)
    except ValueError:
        return ""
    return SAMSUNG_YEAR_CODES[first:last + 1] if first <= last else ""


def classify_build(version: str, latest_version: str) -> str:
    pda = version.split("/", 1)[0] if version else ""
    if latest_version and version == latest_version:
        return "stable-live"
    if len(pda) >= 4 and pda[-4] == "Z":
        return "beta"
    if len(pda) >= 3 and pda[-3] == "Z":
        return "beta"
    if "/" in version:
        cp = version.split("/")[-1]
        if cp and cp != pda:
            return "variant"
    return "stable"


def derive_codes(model: str, csc: str, latest_version: str):
    csc = csc.upper()
    if latest_version:
        parts = [part.strip() for part in latest_version.split("/")]
        if len(parts) >= 2 and all(parts[:2]):
            first_code = parts[0][:-6]
            second_code = parts[1][:-5]
            third_code = parts[2][:-6] if len(parts) > 2 else ""
            latest_year = parts[0][-3]
            if latest_year in SAMSUNG_YEAR_CODES:
                latest_year_index = SAMSUNG_YEAR_CODES.index(latest_year)
                start_year = SAMSUNG_YEAR_CODES[max(0, latest_year_index - 5)]
                end_year_index = min(
                    len(SAMSUNG_YEAR_CODES) - 1,
                    latest_year_index + (1 if parts[0][-2] in "JKL" else 0),
                )
                end_year = SAMSUNG_YEAR_CODES[end_year_index]
            else:
                start_year = latest_year
                end_year = latest_year
            start_bl = "0"
            end_bl = next_char(parts[0][-5])
            start_update = "A"
            end_update = next_char(parts[0][-4])
            return (first_code, second_code, third_code, start_year, end_year,
                    start_bl, end_bl, start_update, end_update)

    model_code = model.replace("SM-", "")
    suffix = "U1" if model_code.endswith("U1") else model_code[-1:]
    ap_tag, csc_tag, cp_tag = "XX", "OXM", "XX"
    if csc in ("CHC", "CHN"):
        ap_tag, csc_tag, cp_tag = "ZC", "CHC", "" if csc == "CHN" else "ZC"
    elif csc == "TGY":
        ap_tag, csc_tag, cp_tag = "ZH", "OZS", "ZC"
    elif suffix == "U":
        ap_tag, csc_tag, cp_tag = "SQ", "OYN", "SQ"
    elif suffix == "U1":
        ap_tag, csc_tag, cp_tag = "UE", "OYM", "UE"
    elif suffix == "W":
        ap_tag, csc_tag, cp_tag = "VL", "OYV", "VL"
    elif suffix == "N":
        # The APK strips the regional suffix before joining its AP/CP tag.
        # This worker keeps the suffix in model_code, so KS is the equivalent
        # tag here and produces S948NKSU... rather than S948NNKU....
        ap_tag, csc_tag, cp_tag = "KS", "OKR", "KS"
    elif suffix == "0":
        ap_tag = "ZH" if csc in ("TGY", "BRI") else "ZC"
        csc_tag = csc
        cp_tag = ap_tag
    elif csc in ("EUX", "EUY"):
        ap_tag, csc_tag, cp_tag = "XX", "OXM", "XX"
    elif csc in ("INS", "NPL", "SLK"):
        ap_tag, csc_tag, cp_tag = "XX", "ODM", "XX"
    elif csc in ("CHX", "ZTR"):
        ap_tag, csc_tag, cp_tag = "XX", "OWO", "XX"

    current_year = datetime.now(timezone.utc).year
    current_year_index = min(
        len(SAMSUNG_YEAR_CODES) - 1,
        max(0, current_year - 2021),
    )
    current_year_code = SAMSUNG_YEAR_CODES[current_year_index]
    start_year = SAMSUNG_YEAR_CODES[max(0, current_year_index - 5)]
    end_year = current_year_code
    return (model_code + ap_tag, model_code + csc_tag,
            model_code + cp_tag if cp_tag else "", start_year, end_year,
            "0", "C", "A", "Z")


def decrypt_firmware(model: str, csc: str, target_hashes: set[str], latest_version: str,
                     full_brute: bool = False, max_candidates: int = DEFAULT_MAX_CANDIDATES,
                     progress_every: int = 250_000):
    if not target_hashes:
        return {}, False, 0
    first_code, second_code, third_code, start_year, end_year, start_bl, end_bl, start_update, end_update = derive_codes(model, csc, latest_version)
    years = samsung_year_range(start_year, end_year)
    bootloaders = samsung_code_range(start_bl, end_bl)
    updates = letters_range(start_update, end_update)
    if "Z" not in updates:
        updates += "Z"
    cp_versions: list[str] = []
    decrypted: dict[str, dict[str, object]] = {}
    seen_versions: set[str] = set()
    candidates = 0
    limit_reached = False

    def register(version: str, year_char: str, month_char: str):
        nonlocal candidates, limit_reached
        if candidates >= max_candidates:
            limit_reached = True
            return
        candidates += 1
        digest = hashlib.md5(version.encode("utf-8")).hexdigest()
        if digest in target_hashes and digest not in decrypted and version not in seen_versions:
            year = ord(year_char) - ord("A") + 2001
            month = ord(month_char) - ord("A") + 1
            decrypted[digest] = {
                "version": version,
                "year": year,
                "month": month,
                "kind": classify_build(version, latest_version),
            }
            seen_versions.add(version)
        if progress_every > 0 and candidates % progress_every == 0:
            emit_progress("decrypting", candidates, max_candidates, len(decrypted))

    # Keep the historical U/S scan order so common builds resolve quickly.
    # Add T beside the first pass instead of placing it after a full U/S
    # sweep; this keeps an unresolved T build within the same bounded range.
    for flavor in "US":
        for bootloader in bootloaders:
            for update in updates:
                for year_char in years:
                    for month_char in "ABCDEFGHIJKL":
                        if limit_reached:
                            return decrypted, True, candidates
                        local_cp = cp_versions[-16:].copy()
                        if third_code:
                            for index in range(1, 4):
                                seed = third_code + flavor + bootloader + update + year_char + month_char + str(index)
                                if seed not in local_cp:
                                    local_cp.append(seed)
                        # Samsung's build-code alphabet includes zero. The
                        # previous resolver skipped it, which made valid
                        # hashes impossible to resolve in the first build of
                        # a sequence.
                        for serial in SAMSUNG_CODE_ALPHABET:
                            random_part = bootloader + update + year_char + month_char + serial
                            beta_random = bootloader + "Z" + year_char + month_char + serial
                            tcode = third_code + flavor + random_part if third_code else ""
                            beta_tcode = third_code + flavor + beta_random if third_code else ""
                            if third_code:
                                for nearby in (serial, previous_char(serial), previous_char(previous_char(serial))):
                                    cpv = third_code + flavor + bootloader + update + year_char + month_char + nearby
                                    if cpv not in local_cp:
                                        local_cp.append(cpv)
                            versions = (
                                f"{first_code}{flavor}{random_part}/{second_code}{random_part}/{tcode}",
                                f"{first_code}{flavor}{beta_random}/{second_code}{beta_random}/{beta_tcode}",
                            )
                            if flavor == "U" and "T" in SAMSUNG_FEATURE_CODES:
                                t_random = third_code + "T" + random_part if third_code else ""
                                t_beta = third_code + "T" + beta_random if third_code else ""
                                versions += (
                                    f"{first_code}T{random_part}/{second_code}{random_part}/{t_random}",
                                    f"{first_code}T{beta_random}/{second_code}{beta_random}/{t_beta}",
                                )
                            if flavor in "US":
                                # Preserve the existing engineering-AP
                                # candidate while allowing the HashFirm-style
                                # T feature to use the same AP/CP feature.
                                versions += (
                                    f"{first_code}E{random_part}/{second_code}{random_part}/{tcode}",
                                    f"{first_code}E{beta_random}/{second_code}{beta_random}/{beta_tcode}",
                                )
                            for version in versions:
                                register(version, year_char, month_char)
                            for cpv in local_cp:
                                if not cpv:
                                    continue
                                for version in (
                                    f"{first_code}{flavor}{random_part}/{second_code}{random_part}/{cpv}",
                                    f"{first_code}E{random_part}/{second_code}{random_part}/{cpv}",
                                    f"{first_code}{flavor}{beta_random}/{second_code}{beta_random}/{cpv}",
                                    f"{first_code}E{beta_random}/{second_code}{beta_random}/{cpv}",
                                ):
                                    register(version, year_char, month_char)
                            if tcode and tcode not in cp_versions and any(version.endswith("/" + tcode) for version in seen_versions):
                                cp_versions.append(tcode)
                            if not full_brute and len(decrypted) == len(target_hashes):
                                return decrypted, limit_reached, candidates
    return decrypted, limit_reached, candidates


def known_key(value: object) -> str:
    if isinstance(value, dict):
        kind = str(value.get("hash_type") or value.get("type") or "").lower()
        digest = str(value.get("hash_value") or value.get("value") or "").strip().lower()
        return f"{kind}:{digest}"
    digest = str(value or "").strip().lower()
    return f"{hash_type(digest) or ''}:{digest}"


def resolve_payload(payload: dict) -> dict:
    model = normalize_model(payload.get("model"))
    csc = normalize_csc(payload.get("csc"))
    if not re.fullmatch(r"SM-[A-Z0-9]+", model) or not re.fullmatch(r"[A-Z0-9]{3}", csc):
        raise ResolverError("invalid model or CSC", "invalid_target")
    if payload.get("testXml") is not None:
        content = str(payload.get("testXml")).encode("utf-8")
    else:
        content = request_version_test_xml(model, csc, float(payload.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS))
    hashes, xml_latest = parse_version_test_xml(content)
    latest_version = str(payload.get("latestVersion") or xml_latest or "").strip()
    known = {known_key(item) for item in (payload.get("knownHashes") or [])}
    retry_unresolved = bool(payload.get("retryUnresolved"))
    retry_keys = {known_key(item) for item in (payload.get("retryHashes") or [])}
    selected = [item for item in hashes if f"{item['hash_type']}:{item['hash_value']}" not in known or (retry_unresolved and f"{item['hash_type']}:{item['hash_value']}" in retry_keys)]
    md5_targets = {item["hash_value"] for item in selected if item["hash_type"] == "md5"}
    max_candidates = int(payload.get("maxCandidates") or DEFAULT_MAX_CANDIDATES)
    progress_every = max(10_000, min(1_000_000, int(payload.get("progressEveryCandidates") or 250_000)))
    emit_progress("decrypting", 0, max_candidates, 0)
    found, limit_reached, candidates = decrypt_firmware(
        model, csc, md5_targets, latest_version,
        full_brute=bool(payload.get("fullBrute")),
        max_candidates=max_candidates,
        progress_every=progress_every,
    )
    emit_progress("finalizing", candidates, max_candidates, len(found))
    matches = []
    for item in selected:
        key = f"{item['hash_type']}:{item['hash_value']}"
        result = found.get(item["hash_value"]) if item["hash_type"] == "md5" else None
        if result:
            parts = str(result["version"]).split("/")
            if len(parts) >= 3:
                matches.append({
                    "hash_type": item["hash_type"],
                    "hash_value": item["hash_value"],
                    "version": result["version"],
                    "pda": parts[0],
                    "csc_build": parts[1],
                    "cp": parts[2],
                    "year": result["year"],
                    "month": result["month"],
                    "kind": result["kind"],
                    "source": "Samsung version.test.xml + verified MD5(build)",
                })
        else:
            matches_hash = {f"{match['hash_type']}:{match['hash_value']}" for match in matches}
            if key not in matches_hash:
                reason = "sha256_algorithm_unavailable" if item["hash_type"] == "sha256" else "no_md5_candidate_match"
                # Keep this as a first-class result so the caller can persist
                # an unresolved hash and avoid treating it as no update.
                item = {**item, "reason": reason}
                payload.setdefault("_unresolved", []).append(item)
    return {
        "ok": True,
        "model": model,
        "csc": csc,
        "latestVersion": latest_version,
        "hashes": hashes,
        "selectedHashes": selected,
        "matches": matches,
        "unresolved": payload.pop("_unresolved", []),
        "candidateLimitReached": limit_reached,
        "source": "Samsung version.test.xml",
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ResolverError("JSON input must be an object", "invalid_input")
        result = resolve_payload(payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except ResolverError as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc), "errorCode": exc.code, "status": exc.status}, separators=(",", ":")))
        return 0
    except Exception as exc:  # pragma: no cover - defensive process boundary
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)[:240], "errorCode": "unexpected_error"}, separators=(",", ":")))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
