#!/usr/bin/env python3
"""Dedicated command alias for the mixed-signal portion of the HDL regression."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
raise SystemExit(
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "hdl-flow-regression.py")],
        cwd=str(ROOT),
        shell=False,
        check=False,
    ).returncode
)
