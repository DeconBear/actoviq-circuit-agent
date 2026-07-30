#!/usr/bin/env python3
"""Produce an honest, machine-readable open-tool qualification record."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


TOOLS = {
    "ngspice": (["ngspice", "--version"],),
    "xyce": (["Xyce", "-v"], ["xyce", "-v"]),
    "openvaf": (["openvaf", "--version"],),
    "xschem": (["xschem", "--version"],),
    "klayout": (["klayout", "-v"],),
    "magic": (["magic", "--version"],),
    "netgen": (["netgen", "-version"],),
    "iverilog": (["iverilog", "-V"],),
    "yosys": (["yosys", "-V"],),
    "openroad": (["openroad", "-version"],),
}


def probe(candidates: tuple[list[str], ...]) -> dict[str, object]:
    for command in candidates:
        executable = shutil.which(command[0])
        if not executable:
            continue
        # Ubuntu's netgen-lvs wrapper opens a Tk console for "-version" and can hang.
        # Prefer a short batch quit so presence is detectable without a display.
        run_command = [executable, *command[1:]]
        run_input = None
        run_env = None
        if command[0] == "netgen" and command[1:] == ["-version"]:
            run_command = [executable, "-batch"]
            run_input = "quit\n"
            run_env = {key: value for key, value in os.environ.items() if key != "DISPLAY"}
        try:
            completed = subprocess.run(
                run_command,
                input=run_input,
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
                env=run_env,
            )
        except subprocess.TimeoutExpired as exc:
            text = "\n".join(
                part.decode("utf-8", errors="replace") if isinstance(part, (bytes, bytearray)) else (part or "")
                for part in (exc.stdout, exc.stderr)
            ).strip()
            return {
                "available": False,
                "executable": executable,
                "version": (text.splitlines()[0][:240] if text else "probe timed out"),
                "exit_code": None,
            }
        text = "\n".join((completed.stdout, completed.stderr)).strip()
        # Batch quit may return non-zero; treat a reachable executable as available
        # when netgen printed a recognizable banner.
        available = completed.returncode == 0
        if command[0] == "netgen" and not available:
            available = "Netgen" in text or "netgen" in text.lower()
        return {
            "available": available,
            "executable": executable,
            "version": text.splitlines()[0][:240] if text else "",
            "exit_code": completed.returncode,
        }
    return {"available": False, "executable": "", "version": "", "exit_code": None}


def smoke(tools: dict[str, dict[str, object]]) -> dict[str, object]:
    results: dict[str, object] = {}
    with tempfile.TemporaryDirectory(prefix="actoviq-tool-qualification-") as temporary:
        root = Path(temporary)
        if tools["ngspice"]["available"]:
            deck = root / "smoke.cir"
            deck.write_text("smoke\nV1 in 0 1\nR1 in 0 1k\n.op\n.end\n", encoding="utf-8")
            completed = subprocess.run(
                [str(tools["ngspice"]["executable"]), "-b", str(deck)],
                cwd=root,
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            results["ngspice"] = {"passed": completed.returncode == 0}
        if tools["xyce"]["available"]:
            deck = root / "xyce-smoke.cir"
            log = root / "xyce-smoke.log"
            deck.write_text("smoke\nV1 in 0 1\nR1 in 0 1k\n.op\n.end\n", encoding="utf-8")
            completed = subprocess.run(
                [str(tools["xyce"]["executable"]), "-l", str(log), str(deck)],
                cwd=root,
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            results["xyce"] = {"passed": completed.returncode == 0}
        if tools["iverilog"]["available"]:
            source = root / "smoke.v"
            output = root / "smoke.vvp"
            source.write_text("module smoke(input a, output y); assign y=a; endmodule\n", encoding="utf-8")
            completed = subprocess.run(
                [str(tools["iverilog"]["executable"]), "-g2005", "-s", "smoke", "-o", str(output), str(source)],
                cwd=root,
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            results["iverilog"] = {"passed": completed.returncode == 0 and output.is_file()}
        if tools["yosys"]["available"]:
            source = root / "smoke.v"
            if not source.is_file():
                source.write_text("module smoke(input a, output y); assign y=a; endmodule\n", encoding="utf-8")
            completed = subprocess.run(
                [str(tools["yosys"]["executable"]), "-q", "-p", f"read_verilog {source}; hierarchy -top smoke; synth"],
                cwd=root,
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            results["yosys"] = {"passed": completed.returncode == 0}
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--require", default="")
    parser.add_argument("--require-native-linux", action="store_true")
    args = parser.parse_args()
    tools = {name: probe(commands) for name, commands in TOOLS.items()}
    smoke_results = smoke(tools)
    required = [value.strip() for value in args.require.split(",") if value.strip()]
    missing = [name for name in required if not tools.get(name, {}).get("available")]
    failed_smoke = [
        name for name in required
        if name in smoke_results and not bool(smoke_results[name].get("passed"))
    ]
    release = platform.release()
    wsl = "microsoft" in release.casefold() or "wsl" in release.casefold()
    native_eligible = sys.platform.startswith("linux") and not wsl
    environment_ok = native_eligible or not args.require_native_linux
    passed = (not missing and not failed_smoke and environment_ok) if required else None
    record = {
        "schema": "actoviq.ic-tool-qualification.v1",
        "qualified_at": datetime.now(timezone.utc).isoformat(),
        "platform": sys.platform,
        "platform_release": release,
        "native_eligible": native_eligible,
        "wsl": wsl,
        "tools": tools,
        "smoke": smoke_results,
        "required": required,
        "passed": passed,
        "missing": missing,
        "failed_smoke": failed_smoke,
        "ineligible_environment": bool(args.require_native_linux and not native_eligible),
    }
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"passed": record["passed"], "output": str(target)}))
    return 0 if passed is not False else 1


if __name__ == "__main__":
    raise SystemExit(main())
