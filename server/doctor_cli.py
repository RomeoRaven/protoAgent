"""Thin CLI projection for the read-only environment Doctor."""

from __future__ import annotations

import argparse
import json

from ops.doctor import DoctorOptions, doctor_exit_code, render_doctor_report, report_to_dict, run_doctor


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be from 1 through 65535")
    return port


def run_doctor_cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="protoagent doctor",
        description="Check offline runtime readiness without changing this instance.",
    )
    parser.add_argument("--json", action="store_true", help="emit stable schema-v1 JSON")
    parser.add_argument("--port", type=_port, default=7870, help="loopback server port to test (default: 7870)")
    args = parser.parse_args(argv)

    report = run_doctor(options=DoctorOptions(port=args.port))
    print(json.dumps(report_to_dict(report), indent=2) if args.json else render_doctor_report(report))
    return doctor_exit_code(report)
