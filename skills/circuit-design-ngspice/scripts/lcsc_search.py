#!/usr/bin/env python3
"""LCSC part search, lookup, and component binding helpers."""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

LCSC_API_BASE = "https://ips.lcsc.com"
LCSC_SEARCH_PATH = "/rest/wmscenter/normal/component/search"
LCSC_ID_RE = re.compile(r"^C[1-9][0-9]*$", re.IGNORECASE)
CACHE_MAX_AGE_SECONDS = 24 * 60 * 60

# Non-production demo catalog for offline tests when use_fallback=True.
MOCK_CATALOG: list[dict[str, Any]] = [
    {
        "lcsc_id": "C25804",
        "mpn": "0603B104K500NT",
        "manufacturer": "FH",
        "description": "100nF 50V X7R 0603",
        "category": "Capacitors",
        "jlc_basic": True,
        "footprint_hint": "0603",
        "datasheet_url": "https://www.lcsc.com/product-detail/C25804.html",
    },
    {
        "lcsc_id": "C21190",
        "mpn": "0603WAF1001T5E",
        "manufacturer": "UNI-ROYAL",
        "description": "1kΩ 1% 0603",
        "category": "Resistors",
        "jlc_basic": True,
        "footprint_hint": "0603",
        "datasheet_url": "https://www.lcsc.com/product-detail/C21190.html",
    },
    {
        "lcsc_id": "C8734",
        "mpn": "LM358DR",
        "manufacturer": "UMW",
        "description": "Dual op-amp SOIC-8",
        "category": "Amplifiers",
        "jlc_basic": True,
        "footprint_hint": "SOIC-8",
        "datasheet_url": "https://www.lcsc.com/product-detail/C8734.html",
    },
]


def default_cache_dir() -> Path:
    return Path.home() / ".actoviq" / "circuit-design-ngspice" / "parts-cache"


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _cache_key(prefix: str, payload: dict[str, Any]) -> str:
    digest = hashlib.sha256(_canonical_json({"prefix": prefix, **payload})).hexdigest()
    return digest[:32]


def _read_cache(cache_dir: Path, key: str) -> dict[str, Any] | None:
    path = cache_dir / f"{key}.json"
    if not path.is_file():
        return None
    try:
        if time.time() - path.stat().st_mtime > CACHE_MAX_AGE_SECONDS:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache(cache_dir: Path, key: str, value: dict[str, Any]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{key}.json"
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _lcsc_signature(api_key: str, api_secret: str, nonce: str, timestamp: str) -> str:
    payload = f"key={api_key}&nonce={nonce}&timestamp={timestamp}{api_secret}"
    return hashlib.md5(payload.encode("utf-8")).hexdigest()


def _mock_search(query: str, limit: int) -> dict[str, Any]:
    tokens = [token for token in re.split(r"\s+", query.strip().casefold()) if token]
    if not tokens:
        return {"ok": False, "error": "query is required"}

    def matches(part: dict[str, Any]) -> bool:
        haystack = " ".join(
            str(part.get(key, ""))
            for key in ("lcsc_id", "mpn", "manufacturer", "description", "category", "footprint_hint")
        ).casefold()
        return all(token in haystack for token in tokens)

    matches_list = [part for part in MOCK_CATALOG if matches(part)]
    return {
        "ok": True,
        "source": "mock_fallback",
        "warning": "Non-production demo catalog; do not use for production BOM binding.",
        "query": query,
        "count": min(limit, len(matches_list)),
        "parts": matches_list[:limit],
    }


def _mock_get(lcsc_id: str) -> dict[str, Any]:
    for part in MOCK_CATALOG:
        if part["lcsc_id"].casefold() == lcsc_id.strip().casefold():
            return {"ok": True, "source": "mock_fallback", "part": part}
    return {"ok": False, "error": f"mock catalog has no part {lcsc_id}"}


def _http_json(url: str, *, headers: dict[str, str] | None = None, timeout: float = 20.0) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("LCSC API returned a non-object payload")
    return data


def _normalize_part(raw: dict[str, Any]) -> dict[str, Any]:
    lcsc_id = str(raw.get("lcsc_id") or raw.get("productCode") or raw.get("number") or raw.get("id") or "").strip()
    mpn = str(raw.get("mpn") or raw.get("productModel") or raw.get("model") or "").strip()
    manufacturer = str(raw.get("manufacturer") or raw.get("brandNameEn") or raw.get("brand") or "").strip()
    description = str(raw.get("description") or raw.get("productIntroEn") or raw.get("title") or mpn).strip()
    footprint_hint = str(raw.get("footprint_hint") or raw.get("package") or raw.get("encapsulation") or "").strip()
    datasheet_url = str(raw.get("datasheet_url") or raw.get("pdfUrl") or raw.get("datasheet") or "").strip()
    jlc_basic = bool(raw.get("jlc_basic") if "jlc_basic" in raw else raw.get("isBasic", False))
    return {
        "lcsc_id": lcsc_id,
        "mpn": mpn,
        "manufacturer": manufacturer,
        "description": description,
        "jlc_basic": jlc_basic,
        "footprint_hint": footprint_hint,
        "datasheet_url": datasheet_url,
    }


def search_parts(
    query: str,
    *,
    api_key: str = "",
    api_secret: str = "",
    use_fallback: bool = False,
    cache_dir: str | Path | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    text = str(query or "").strip()
    if not text:
        return {"ok": False, "error": "query is required"}
    has_credentials = bool(api_key and api_secret)
    if not has_credentials and not use_fallback:
        return {
            "ok": False,
            "error": "LCSC credentials are required; pass api_key/api_secret or set use_fallback=True for demo catalog.",
        }
    cache_root = Path(cache_dir).expanduser() if cache_dir else default_cache_dir()
    source = "lcsc_openapi" if has_credentials else "mock_fallback"
    credential_scope = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:12] if has_credentials else "demo"
    cache_payload = {"query": text, "limit": int(limit), "source": source, "credential_scope": credential_scope}
    cached = _read_cache(cache_root, _cache_key("search", cache_payload))
    if cached is not None:
        return cached

    if not has_credentials:
        result = _mock_search(text, limit)
        _write_cache(cache_root, _cache_key("search", cache_payload), result)
        return result

    nonce = hashlib.sha256(f"{time.time_ns()}:{text}".encode("utf-8")).hexdigest()[:16]
    timestamp = str(int(time.time()))
    signature = _lcsc_signature(api_key, api_secret, nonce, timestamp)
    params = {
        "keyword": text,
        "pageSize": str(max(1, min(limit, 50))),
        "currentPage": "1",
        "key": api_key,
        "nonce": nonce,
        "timestamp": timestamp,
        "signature": signature,
    }
    url = f"{LCSC_API_BASE}{LCSC_SEARCH_PATH}?{urllib.parse.urlencode(params)}"
    try:
        payload = _http_json(url)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
        if use_fallback:
            result = _mock_search(text, limit)
            result["warning"] = f"LCSC API failed ({error}); returned mock fallback catalog."
            return result
        return {"ok": False, "error": f"LCSC search failed: {error}"}

    rows = payload.get("result") or payload.get("data") or payload.get("list") or []
    if isinstance(rows, dict):
        rows = rows.get("list") or rows.get("records") or []
    parts = [_normalize_part(row) for row in rows if isinstance(row, dict)]
    parts = [part for part in parts if part["lcsc_id"]][:limit]
    result = {"ok": True, "source": "lcsc_openapi", "query": text, "count": len(parts), "parts": parts}
    _write_cache(cache_root, _cache_key("search", cache_payload), result)
    return result


def get_part(
    lcsc_id: str,
    *,
    api_key: str = "",
    api_secret: str = "",
    use_fallback: bool = False,
    cache_dir: str | Path | None = None,
) -> dict[str, Any]:
    part_id = str(lcsc_id or "").strip().upper()
    if not LCSC_ID_RE.fullmatch(part_id):
        return {"ok": False, "error": "lcsc_id must be a canonical LCSC C-number such as C21190"}
    has_credentials = bool(api_key and api_secret)
    if not has_credentials and not use_fallback:
        return {
            "ok": False,
            "error": "LCSC credentials are required; pass api_key/api_secret or set use_fallback=True for demo catalog.",
        }
    cache_root = Path(cache_dir).expanduser() if cache_dir else default_cache_dir()
    source = "lcsc_openapi" if has_credentials else "mock_fallback"
    credential_scope = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:12] if has_credentials else "demo"
    cache_payload = {"lcsc_id": part_id, "source": source, "credential_scope": credential_scope}
    cached = _read_cache(cache_root, _cache_key("get", cache_payload))
    if cached is not None:
        return cached

    if not has_credentials:
        result = _mock_get(part_id)
        if result.get("ok"):
            _write_cache(cache_root, _cache_key("get", cache_payload), result)
        return result

    search = search_parts(
        part_id,
        api_key=api_key,
        api_secret=api_secret,
        use_fallback=use_fallback,
        cache_dir=cache_root,
        limit=5,
    )
    if not search.get("ok"):
        return search
    for candidate in search.get("parts", []):
        if candidate.get("lcsc_id", "").casefold() == part_id.casefold():
            result = {"ok": True, "source": search.get("source", "lcsc_openapi"), "part": candidate}
            _write_cache(cache_root, _cache_key("get", cache_payload), result)
            return result
    if use_fallback:
        result = _mock_get(part_id)
        if result.get("ok"):
            _write_cache(cache_root, _cache_key("get", cache_payload), result)
        return result
    return {"ok": False, "error": f"LCSC part not found: {part_id}"}


def bind_part_to_component(component: dict[str, Any], part: dict[str, Any]) -> dict[str, Any]:
    lcsc_id = str(part.get("lcsc_id", "")).strip().upper()
    if not LCSC_ID_RE.fullmatch(lcsc_id):
        raise ValueError("part.lcsc_id must be a canonical LCSC C-number such as C21190")
    eda = dict(component.get("eda") or {})
    eda["lcsc_id"] = lcsc_id
    if part.get("mpn"):
        eda["mpn"] = str(part["mpn"])
    if part.get("manufacturer"):
        eda["manufacturer"] = str(part["manufacturer"])
    if part.get("datasheet_url"):
        eda["datasheet_url"] = str(part["datasheet_url"])
    if "jlc_basic" in part:
        eda["jlc_basic"] = bool(part["jlc_basic"])
    if part.get("footprint_hint"):
        eda["footprint_hint"] = str(part["footprint_hint"])
    component["eda"] = eda
    return component
