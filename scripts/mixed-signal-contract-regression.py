#!/usr/bin/env python3
"""Regression for mixed-signal boundary contract validation paths.

The end-to-end HDL flow regression covers the happy path and a single
threshold-vector violation. This suite exercises the structural and
numeric validators in ``verify_mixed_signal_contract`` directly, so
regressions in the schema, boundary-id, required-field, supply-domain,
threshold, and sampling-mode checks are caught without requiring
Icarus or Yosys on the machine.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = ROOT / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from hdl_flow import verify_mixed_signal_contract  # noqa: E402

SCHEMA = "actoviq.mixed-signal-contract.v1"


def _valid_boundary(identifier: str = "b1") -> dict:
    return {
        "id": identifier,
        "analog_net": "a",
        "digital_signal": "d",
        "direction": "analog_to_digital",
        "supply_domain": {"vss": 0.0, "vdd": 1.8},
        "threshold": {"low_max": 0.5, "high_min": 1.3},
        "sampling": {"mode": "edge", "edge": "rising"},
        "conversion_model": "adc_ready.vams",
        "vectors": [],
    }


def _write_contract(path: Path, boundaries: list[dict], schema: str = SCHEMA) -> None:
    path.write_text(
        json.dumps({"schema": schema, "boundaries": boundaries}, indent=2),
        encoding="utf-8",
    )


def _expect_raises(callable_, message_fragment: str) -> None:
    try:
        callable_()
    except ValueError as error:
        if message_fragment not in str(error):
            raise AssertionError(
                f"expected error containing {message_fragment!r}, got: {error}"
            ) from error
        return
    raise AssertionError(f"expected ValueError containing {message_fragment!r}")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="actoviq-mixed-signal-") as temporary:
        root = Path(temporary)
        index = 0

        def next_run_root() -> Path:
            nonlocal index
            index += 1
            return root / f"run-{index}"

        # Schema mismatch is rejected.
        contract = root / "wrong-schema.json"
        _write_contract(contract, [_valid_boundary()], schema="actoviq.mixed-signal-contract.v0")
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "mixed-signal contract must use",
        )

        # Empty boundaries array is rejected.
        contract = root / "no-boundaries.json"
        _write_contract(contract, [])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "requires boundaries",
        )

        # Duplicate boundary ids are rejected.
        contract = root / "duplicate-ids.json"
        _write_contract(contract, [_valid_boundary("b1"), _valid_boundary("b1")])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "non-empty and unique",
        )

        # Empty boundary id is rejected.
        contract = root / "empty-id.json"
        _write_contract(contract, [_valid_boundary("")])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "non-empty and unique",
        )

        # Missing required fields are rejected.
        for field in ("analog_net", "digital_signal", "direction", "conversion_model"):
            contract = root / f"missing-{field}.json"
            boundary = _valid_boundary()
            boundary.pop(field)
            _write_contract(contract, [boundary])
            _expect_raises(
                lambda: verify_mixed_signal_contract(contract, next_run_root()),
                f"requires {field}",
            )

        # Non-numeric supply_domain is rejected.
        contract = root / "supply-non-numeric.json"
        boundary = _valid_boundary()
        boundary["supply_domain"] = {"vss": "0", "vdd": "1.8"}
        _write_contract(contract, [boundary])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "numeric supply_domain",
        )

        # supply_domain vdd <= vss is rejected.
        contract = root / "vdd-le-vss.json"
        boundary = _valid_boundary()
        boundary["supply_domain"] = {"vss": 1.0, "vdd": 1.0}
        _write_contract(contract, [boundary])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "vdd > vss",
        )

        # Non-numeric threshold is rejected.
        contract = root / "threshold-non-numeric.json"
        boundary = _valid_boundary()
        boundary["threshold"] = {"low_max": "0.5", "high_min": "1.3"}
        _write_contract(contract, [boundary])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "numeric low_max/high_min",
        )

        # threshold low_max >= high_min is rejected.
        contract = root / "threshold-inverted.json"
        boundary = _valid_boundary()
        boundary["threshold"] = {"low_max": 1.0, "high_min": 1.0}
        _write_contract(contract, [boundary])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "low_max < high_min",
        )

        # Invalid sampling mode is rejected.
        contract = root / "bad-sampling.json"
        boundary = _valid_boundary()
        boundary["sampling"] = {"mode": "glitch"}
        _write_contract(contract, [boundary])
        _expect_raises(
            lambda: verify_mixed_signal_contract(contract, next_run_root()),
            "explicit sampling mode",
        )

        # Valid contract with both domains passing: interface verified, ams not.
        contract = root / "valid.json"
        _write_contract(contract, [_valid_boundary()])
        passed = verify_mixed_signal_contract(
            contract,
            next_run_root(),
            {"status": "passed"},
            {"status": "passed"},
        )
        assert passed["metadata"]["domain_verified"]
        assert passed["metadata"]["interface_verified"]
        assert not passed["metadata"]["ams_verified"]

        # Valid contract but one domain failing: neither domain nor interface verified.
        contract = root / "domain-fail.json"
        _write_contract(contract, [_valid_boundary()])
        failed_domain = verify_mixed_signal_contract(
            contract,
            next_run_root(),
            {"status": "passed"},
            {"status": "failed"},
        )
        assert not failed_domain["metadata"]["domain_verified"]
        assert not failed_domain["metadata"]["interface_verified"]
        assert not failed_domain["metadata"]["ams_verified"]

    print(json.dumps({"ok": True, "suite": "mixed-signal-contract-regression"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
