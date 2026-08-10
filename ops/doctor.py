"""Read-only offline environment diagnostics (RR issue #15).

The module owns one deep report interface.  Surface adapters render the same
secret-free result as terminal text or stable JSON; checks never repair state.
"""

from __future__ import annotations

import errno
import os
import platform
import shutil
import socket
import sys
import yaml
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from ops import op


class FindingStatus(StrEnum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class DoctorFinding:
    id: str
    status: FindingStatus
    summary: str
    evidence: dict[str, Any] = field(default_factory=dict)
    remediation: str = ""


@dataclass(frozen=True)
class DoctorOptions:
    port: int = 7870
    profile: str = "runtime"
    mode: str = "offline"


@dataclass(frozen=True)
class DoctorReport:
    environment: dict[str, Any]
    findings: tuple[DoctorFinding, ...]
    schema_version: int = 1
    profile: str = "runtime"
    mode: str = "offline"


def _report_summary(report: DoctorReport) -> dict[str, Any]:
    counts = {status.value: 0 for status in FindingStatus}
    for finding in report.findings:
        counts[finding.status.value] += 1
    if counts[FindingStatus.FAIL.value]:
        status = FindingStatus.FAIL.value
    elif counts[FindingStatus.WARN.value]:
        status = FindingStatus.WARN.value
    else:
        status = FindingStatus.PASS.value
    return {"status": status, "counts": counts}


def report_to_dict(report: DoctorReport) -> dict[str, Any]:
    """Return the stable, JSON-compatible public report shape."""
    findings = [
        {
            "id": finding.id,
            "status": finding.status.value,
            "summary": finding.summary,
            "evidence": dict(finding.evidence),
            "remediation": finding.remediation,
        }
        for finding in sorted(report.findings, key=lambda row: row.id)
    ]
    return {
        "schema_version": report.schema_version,
        "profile": report.profile,
        "mode": report.mode,
        "summary": _report_summary(report),
        "environment": dict(report.environment),
        "findings": findings,
    }


def render_doctor_report(report: DoctorReport) -> str:
    """Render the public report for a terminal without changing its semantics."""
    lines = [f"protoAgent doctor — {report.profile}/{report.mode}"]
    for finding in sorted(report.findings, key=lambda row: row.id):
        lines.append(f"{finding.status.value.upper()} {finding.id} — {finding.summary}")
        if finding.remediation:
            lines.append(f"     remediation: {finding.remediation}")
    counts = _report_summary(report)["counts"]
    lines.append(
        f"Summary: {counts['pass']} pass, {counts['warn']} warn, {counts['fail']} fail, {counts['skipped']} skipped"
    )
    return "\n".join(lines)


def doctor_exit_code(report: DoctorReport) -> int:
    """Automation contract: failures are non-zero; warnings remain advisory."""
    return 1 if any(row.status is FindingStatus.FAIL for row in report.findings) else 0


def _finding(
    finding_id: str,
    status: FindingStatus,
    summary: str,
    *,
    evidence: dict[str, Any] | None = None,
    remediation: str = "",
) -> DoctorFinding:
    return DoctorFinding(finding_id, status, summary, evidence or {}, remediation)


def _nearest_existing(path: Path) -> Path | None:
    current = path
    while not current.exists() and current != current.parent:
        current = current.parent
    return current if current.exists() else None


def _path_findings(paths) -> list[DoctorFinding]:
    rows: list[DoctorFinding] = []
    app = paths.app_root
    app_ok = app.is_dir() and os.access(app, os.R_OK)
    rows.append(
        _finding(
            "paths.app_root",
            FindingStatus.PASS if app_ok else FindingStatus.FAIL,
            "app root is readable" if app_ok else "app root is missing or unreadable",
            evidence={"path": str(app)},
            remediation="restore or reinstall the protoAgent application files" if not app_ok else "",
        )
    )
    for finding_id, target in (
        ("paths.instance_root", paths.instance_root),
        ("paths.config_parent", paths.config_yaml.parent),
    ):
        ancestor = _nearest_existing(target)
        ok = bool(ancestor and ancestor.is_dir() and os.access(ancestor, os.W_OK))
        rows.append(
            _finding(
                finding_id,
                FindingStatus.PASS if ok else FindingStatus.FAIL,
                "path is writable by this process" if ok else "path has no writable existing ancestor",
                evidence={"path": str(target), "checked": str(ancestor) if ancestor else ""},
                remediation="grant this process write access to the instance path" if not ok else "",
            )
        )
    ancestor = _nearest_existing(paths.instance_root)
    try:
        usage = shutil.disk_usage(ancestor) if ancestor else None
    except OSError:
        usage = None
    rows.append(
        _finding(
            "paths.free_space",
            FindingStatus.PASS if usage else FindingStatus.FAIL,
            "filesystem free space was read" if usage else "filesystem free space could not be read",
            evidence={"path": str(ancestor) if ancestor else "", "free_bytes": usage.free if usage else None},
            remediation="verify the instance filesystem is mounted and readable" if not usage else "",
        )
    )
    return rows


def _config_findings(config_path: Path) -> tuple[list[DoctorFinding], Any | None]:
    try:
        from graph.config import LangGraphConfig, load_config_docs_with_presence
        from graph.config_io import validate_for_headless

        merged, secrets, present = load_config_docs_with_presence(config_path)
        if not present:
            return [
                _finding(
                    "config.parse",
                    FindingStatus.FAIL,
                    "live config is missing",
                    evidence={"path": str(config_path), "reason": "missing"},
                    remediation="run setup or provide host or instance config before runtime startup",
                ),
                _finding("config.runtime_requirements", FindingStatus.SKIPPED, "config parsing did not pass"),
            ], None
        if not isinstance(merged, dict) or not isinstance(secrets, dict):
            raise TypeError("config roots must be mappings")
        plugins_doc = merged.get("plugins", {}) or {}
        if not isinstance(plugins_doc, dict):
            raise ValueError("plugins config must be a mapping")
        for field_name in ("enabled", "disabled"):
            plugin_ids = plugins_doc.get(field_name, []) or []
            if not isinstance(plugin_ids, list) or any(
                not isinstance(plugin_id, str) or not plugin_id.strip() for plugin_id in plugin_ids
            ):
                raise ValueError(f"plugins.{field_name} must be a list of nonblank plugin ids")
        config = LangGraphConfig.from_dict(merged, secrets=secrets, config_dir=config_path.parent)
    except (OSError, yaml.YAMLError, TypeError, ValueError, AttributeError) as exc:
        mark = getattr(exc, "problem_mark", None)
        evidence: dict[str, Any] = {"path": str(config_path), "error": type(exc).__name__}
        if mark is not None:
            evidence.update({"line": int(mark.line) + 1, "column": int(mark.column) + 1})
        return [
            _finding(
                "config.parse",
                FindingStatus.FAIL,
                "live config could not be parsed safely",
                evidence=evidence,
                remediation="correct the YAML structure without placing secrets in the main config",
            ),
            _finding("config.runtime_requirements", FindingStatus.SKIPPED, "config parsing did not pass"),
        ], None

    rows = [_finding("config.parse", FindingStatus.PASS, "host, agent, and secrets config parsed")]
    ok, reason = validate_for_headless(config)
    runtime_name = str(getattr(config, "agent_runtime", "native") or "native")
    if ok and runtime_name.startswith("acp:"):
        from runtime.acp_runtime import adapter_for, resolve_runtime

        _, agent = resolve_runtime(config)
        try:
            adapter_for(agent, config)
        except ValueError:
            ok, reason = False, "missing_acp_adapter"
    if ok:
        rows.append(
            _finding("config.runtime_requirements", FindingStatus.PASS, "offline runtime requirements are present")
        )
    else:
        code = (
            "missing_acp_adapter"
            if reason == "missing_acp_adapter"
            else "missing_model_api_base"
            if "api_base" in reason
            else "missing_model_api_key"
            if "api_key" in reason
            else "invalid_runtime_config"
        )
        rows.append(
            _finding(
                "config.runtime_requirements",
                FindingStatus.FAIL,
                "offline runtime requirements are incomplete",
                evidence={"reason": code},
                remediation="complete headless setup or configure the missing model requirement",
            )
        )
    return rows, config


def _port_finding(port: int) -> DoctorFinding:
    if not 1 <= port <= 65535:
        return _finding(
            "network.loopback_port",
            FindingStatus.FAIL,
            "loopback port is invalid",
            evidence={"host": "127.0.0.1", "port": port, "reason": "invalid"},
            remediation="choose a port from 1 through 65535",
        )
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", port))
    except OSError as exc:
        reason = (
            "occupied"
            if exc.errno == errno.EADDRINUSE
            else "permission_denied"
            if exc.errno == errno.EACCES
            else "unavailable"
        )
        return _finding(
            "network.loopback_port",
            FindingStatus.FAIL,
            "loopback port is unavailable at check time",
            evidence={"host": "127.0.0.1", "port": port, "reason": reason},
            remediation="choose another port or inspect the process already using it",
        )
    return _finding(
        "network.loopback_port",
        FindingStatus.PASS,
        "loopback port is available at check time",
        evidence={"host": "127.0.0.1", "port": port, "reason": "available"},
    )


def _plugin_findings(config: Any | None) -> list[DoctorFinding]:
    if config is None:
        return [
            _finding("plugins.manifests", FindingStatus.SKIPPED, "config parsing did not pass"),
            _finding("plugins.compatibility", FindingStatus.SKIPPED, "config parsing did not pass"),
            _finding("plugins.lock", FindingStatus.SKIPPED, "config parsing did not pass"),
        ]
    from graph.plugins.installer import list_installed, plugin_lock_readable
    from graph.plugins.loader import inspect_plugin_compatibility

    compatibility = inspect_plugin_compatibility(config)
    missing = [row.id for row in compatibility if "missing_manifest" in row.issues]
    incompatible = {row.id: list(row.issues) for row in compatibility if row.issues and row.id not in missing}
    rows = [
        _finding(
            "plugins.manifests",
            FindingStatus.FAIL if missing else FindingStatus.PASS,
            "enabled plugin manifests are missing" if missing else "enabled plugin manifests are present",
            evidence={"plugins": sorted(missing)},
            remediation="install or disable each missing plugin" if missing else "",
        ),
        _finding(
            "plugins.compatibility",
            FindingStatus.FAIL if incompatible else FindingStatus.PASS,
            "enabled plugins have compatibility failures"
            if incompatible
            else "enabled plugin manifests are compatible",
            evidence={"plugins": incompatible},
            remediation="satisfy the named environment requirement or use a compatible plugin version"
            if incompatible
            else "",
        ),
    ]
    if not plugin_lock_readable():
        rows.append(
            _finding(
                "plugins.lock",
                FindingStatus.FAIL,
                "plugin lock could not be read",
                evidence={"reason": "lock_unreadable"},
                remediation="inspect plugins.lock with the existing plugin tooling",
            )
        )
        return rows
    try:
        inventory = list_installed()
        missing_tracked = sorted(
            row.get("id", "") for row in inventory if row.get("tracked") and not row.get("present")
        )
        untracked = sorted(row.get("id", "") for row in inventory if row.get("present") and not row.get("tracked"))
        status = FindingStatus.FAIL if missing_tracked else FindingStatus.WARN if untracked else FindingStatus.PASS
        summary = (
            "plugin lock has tracked entries missing from disk"
            if missing_tracked
            else "untracked live plugins are present"
            if untracked
            else "plugin lock and live inventory agree"
        )
        rows.append(
            _finding(
                "plugins.lock",
                status,
                summary,
                evidence={"tracked_missing": missing_tracked, "untracked_present": untracked},
                remediation="run the existing plugin sync workflow"
                if missing_tracked
                else "review and explicitly install or remove untracked plugins"
                if untracked
                else "",
            )
        )
    except (OSError, TypeError, ValueError, KeyError):
        rows.append(
            _finding(
                "plugins.lock",
                FindingStatus.FAIL,
                "plugin inventory could not be read",
                evidence={"reason": "inventory_unavailable"},
                remediation="inspect plugins.lock with the existing plugin tooling",
            )
        )
    return rows


@op(
    name="environment.doctor",
    risk="read",
    summary="Check offline runtime readiness without changing the instance.",
)
def run_doctor(*, options: DoctorOptions | None = None) -> DoctorReport:
    """Build one secret-free, no-write offline runtime-readiness report."""
    from infra.paths import instance_paths, package_version

    opts = options or DoctorOptions()
    paths = instance_paths()
    distribution = (
        "frozen"
        if getattr(sys, "frozen", False)
        else "source"
        if (paths.app_root / "pyproject.toml").is_file()
        else "wheel"
    )
    environment = {
        "os": platform.system(),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "protoagent": package_version(),
        "distribution": distribution,
    }
    findings = [
        _finding(
            "environment.identity",
            FindingStatus.PASS,
            "runtime identity resolved",
            evidence=dict(environment),
        )
    ]
    findings.extend(_path_findings(paths))
    config_rows, config = _config_findings(paths.config_yaml)
    findings.extend(config_rows)
    findings.append(_port_finding(opts.port))
    findings.extend(_plugin_findings(config))
    return DoctorReport(
        environment=environment,
        findings=tuple(sorted(findings, key=lambda row: row.id)),
        profile=opts.profile,
        mode=opts.mode,
    )
