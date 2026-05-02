#!/usr/bin/env python3
"""Small gm/ID sizing helper for actoviq-circuit-agent."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="gm/ID lookup helper")
    parser.add_argument("--mode", required=True, choices=["id", "gm", "w", "ft", "gmro"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--l-um", type=float, required=True)
    parser.add_argument("--vds", type=float, required=True)
    parser.add_argument("--gmid", type=float, default=0.0)
    parser.add_argument("--id-a", type=float, default=0.0)
    parser.add_argument("--gm-s", type=float, default=0.0)
    parser.add_argument("--w-um", type=float, default=0.0)
    parser.add_argument("--ft-hz", type=float, default=0.0)
    parser.add_argument("--gmro", type=float, default=0.0)
    parser.add_argument("--reference-w-um", type=float, default=10.0)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    project_root = Path(__file__).resolve().parents[1]
    gm_assets = project_root.parent / "gmoverid-skill" / "gmoverid" / "assets"
    sys.path.insert(0, str(gm_assets))

    from design_gmoverid import GmIdTable  # type: ignore

    table = GmIdTable(args.model, W=args.reference_w_um, L=args.l_um, vds=args.vds)

    if args.mode == "id":
        op = table.size(gmid=args.gmid, Id=args.id_a)
    elif args.mode == "gm":
        op = table.size(gmid=args.gmid, gm=args.gm_s)
    elif args.mode == "w":
        op = table.size(gmid=args.gmid, W=args.w_um)
    elif args.mode == "ft":
        op = table.size_from_ft(
            args.ft_hz, W=args.w_um if args.w_um > 0 else args.reference_w_um
        )
    else:
        op = table.size_from_gmro(args.gmro, Id=args.id_a if args.id_a > 0 else 100e-6)

    payload = {
        "ok": True,
        "mode": args.mode,
        "result": op,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
