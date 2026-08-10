"""Offline environment-doctor contracts (RR issue #15)."""

from __future__ import annotations

import json
import socket
from pathlib import Path


def _finding_map(report):
    return {row.id: row for row in report.findings}


def _isolate(monkeypatch, tmp_path: Path) -> Path:
    from infra.paths import reset_instance_paths

    root = tmp_path / "instance"
    monkeypatch.setenv("PROTOAGENT_HOME", str(root))
    monkeypatch.delenv("PROTOAGENT_INSTANCE", raising=False)
    monkeypatch.delenv("PROTOAGENT_BOX_ROOT", raising=False)
    monkeypatch.delenv("PROTOAGENT_HOST_CONFIG", raising=False)
    reset_instance_paths()
    return root


def _write_runtime_config(root: Path, *, plugins: list[str] | None = None) -> None:
    config = root / "config"
    config.mkdir(parents=True)
    enabled = "\n".join(f"    - {pid}" for pid in (plugins or [])) or "    []"
    (config / "langgraph-config.yaml").write_text(
        "model:\n  api_base: http://127.0.0.1:9/v1\nplugins:\n  enabled:\n" + enabled + "\n",
        encoding="utf-8",
    )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_report_dict_has_schema_v1_and_stable_finding_order():
    from ops.doctor import DoctorFinding, DoctorReport, FindingStatus, report_to_dict

    report = DoctorReport(
        environment={"os": "Linux"},
        findings=(
            DoctorFinding("z.last", FindingStatus.WARN, "last"),
            DoctorFinding("a.first", FindingStatus.PASS, "first"),
        ),
    )

    payload = report_to_dict(report)

    assert payload["schema_version"] == 1
    assert payload["profile"] == "runtime"
    assert payload["mode"] == "offline"
    assert [row["id"] for row in payload["findings"]] == ["a.first", "z.last"]
    assert "timestamp" not in payload
    assert "pid" not in payload


def test_summary_status_precedence_and_counts():
    from ops.doctor import DoctorFinding, DoctorReport, FindingStatus, report_to_dict

    report = DoctorReport(
        environment={},
        findings=(
            DoctorFinding("pass", FindingStatus.PASS, "ok"),
            DoctorFinding("warn", FindingStatus.WARN, "watch"),
            DoctorFinding("fail", FindingStatus.FAIL, "broken"),
            DoctorFinding("skip", FindingStatus.SKIPPED, "blocked"),
        ),
    )

    assert report_to_dict(report)["summary"] == {
        "status": "fail",
        "counts": {"pass": 1, "warn": 1, "fail": 1, "skipped": 1},
    }


def test_human_renderer_and_exit_code_derive_from_report():
    from ops.doctor import (
        DoctorFinding,
        DoctorReport,
        FindingStatus,
        doctor_exit_code,
        render_doctor_report,
    )

    passing = DoctorReport(environment={}, findings=(DoctorFinding("ok", FindingStatus.WARN, "advisory"),))
    failing = DoctorReport(
        environment={},
        findings=(DoctorFinding("config.parse", FindingStatus.FAIL, "config is malformed", remediation="fix YAML"),),
    )

    assert doctor_exit_code(passing) == 0
    assert doctor_exit_code(failing) == 1
    text = render_doctor_report(failing)
    assert "protoAgent doctor — runtime/offline" in text
    assert "FAIL config.parse — config is malformed" in text
    assert "remediation: fix YAML" in text
    assert "Summary: 0 pass, 0 warn, 1 fail, 0 skipped" in text


def test_clean_isolated_runtime_report_is_secret_free_and_no_write(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, doctor_exit_code, render_doctor_report, report_to_dict, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root)
    secret = "sk-DOCTOR-SECRET-never-print"
    (root / "config" / "secrets.yaml").write_text(f"model:\n  api_key: {secret}\n", encoding="utf-8")
    before = sorted((p.relative_to(root), p.read_bytes()) for p in root.rglob("*") if p.is_file())

    report = run_doctor(options=DoctorOptions(port=_free_port()))

    after = sorted((p.relative_to(root), p.read_bytes()) for p in root.rglob("*") if p.is_file())
    findings = _finding_map(report)
    rendered = json.dumps(report_to_dict(report)) + render_doctor_report(report)
    assert doctor_exit_code(report) == 0
    assert findings["config.parse"].status.value == "pass"
    assert findings["config.runtime_requirements"].status.value == "pass"
    assert findings["network.loopback_port"].status.value == "pass"
    assert before == after
    assert secret not in rendered


def test_host_layer_only_config_is_valid_without_agent_leaf(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    host_config = tmp_path / "host-config.yaml"
    host_config.write_text("model:\n  api_base: http://127.0.0.1:9/v1\n", encoding="utf-8")
    monkeypatch.setenv("PROTOAGENT_HOST_CONFIG", str(host_config))
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")

    findings = _finding_map(run_doctor(options=DoctorOptions(port=_free_port())))

    assert findings["config.parse"].status.value == "pass"
    assert findings["config.runtime_requirements"].status.value == "pass"
    assert not root.exists()


def test_malformed_host_layer_is_sanitized_and_reported_as_malformed(monkeypatch, tmp_path, caplog):
    from ops.doctor import DoctorOptions, report_to_dict, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    host_config = tmp_path / "host-config.yaml"
    sentinel = "DOCTOR-HOST-SECRET-SENTINEL"
    host_config.write_text(f"model:\n  api_key: [{sentinel}\n", encoding="utf-8")
    monkeypatch.setenv("PROTOAGENT_HOST_CONFIG", str(host_config))

    report = run_doctor(options=DoctorOptions(port=_free_port()))
    finding = _finding_map(report)["config.parse"]

    assert finding.status.value == "fail"
    assert finding.evidence["error"] in {"ParserError", "ScannerError"}
    assert finding.evidence["layer"] == "host"
    assert finding.evidence.get("reason") != "missing"
    assert sentinel not in caplog.text
    assert sentinel not in json.dumps(report_to_dict(report))
    assert not root.exists()


def test_missing_and_malformed_config_fail_without_seeding_or_leaking(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, report_to_dict, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    report = run_doctor(options=DoctorOptions(port=_free_port()))
    findings = _finding_map(report)
    assert findings["config.parse"].status.value == "fail"
    assert findings["config.runtime_requirements"].status.value == "skipped"
    assert not root.exists()

    root.mkdir()
    (root / "config").mkdir()
    secret = "sk-RAW-PARSER-SECRET"
    (root / "config" / "langgraph-config.yaml").write_text(f"model: [{secret}\n", encoding="utf-8")
    report = run_doctor(options=DoctorOptions(port=_free_port()))
    payload = json.dumps(report_to_dict(report))
    finding = _finding_map(report)["config.parse"]
    assert finding.status.value == "fail"
    assert finding.evidence["error"] in {"ParserError", "ScannerError"}
    assert secret not in payload


def test_malformed_plugin_id_lists_fail_config_without_crashing(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    config = root / "config"
    config.mkdir(parents=True)
    (config / "langgraph-config.yaml").write_text(
        "model:\n  api_base: http://127.0.0.1:9/v1\nplugins:\n  enabled:\n    - bad: value\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")

    findings = _finding_map(run_doctor(options=DoctorOptions(port=_free_port())))

    assert findings["config.parse"].status.value == "fail"
    assert findings["config.parse"].evidence["error"] == "ValueError"
    assert findings["plugins.compatibility"].status.value == "skipped"


def test_unknown_acp_runtime_fails_runtime_readiness(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    config = root / "config"
    config.mkdir(parents=True)
    (config / "langgraph-config.yaml").write_text("agent_runtime: acp:no-such-agent\n", encoding="utf-8")

    finding = _finding_map(run_doctor(options=DoctorOptions(port=_free_port())))["config.runtime_requirements"]

    assert finding.status.value == "fail"
    assert finding.evidence == {"reason": "missing_acp_adapter"}


def test_occupied_port_is_an_attributable_failure(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root)
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = int(listener.getsockname()[1])
        finding = _finding_map(run_doctor(options=DoctorOptions(port=port)))["network.loopback_port"]
    assert finding.status.value == "fail"
    assert finding.evidence == {"host": "127.0.0.1", "port": port, "reason": "occupied"}


def test_plugin_compatibility_does_not_import_entrypoint(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root, plugins=["future-plugin"])
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    plugin = root / "plugins" / "future-plugin"
    plugin.mkdir(parents=True)
    marker = root / "PLUGIN_WAS_IMPORTED"
    (plugin / "protoagent.plugin.yaml").write_text(
        "id: future-plugin\n"
        "name: Future Plugin\n"
        "version: 1.0.0\n"
        "entrypoint: plugin.py\n"
        "min_protoagent_version: 999.0.0\n"
        "requires_env: [DOCTOR_REQUIRED_ENV]\n",
        encoding="utf-8",
    )
    (plugin / "plugin.py").write_text(
        "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('imported')\n",
        encoding="utf-8",
    )

    report = run_doctor(options=DoctorOptions(port=_free_port()))
    finding = _finding_map(report)["plugins.compatibility"]

    assert finding.status.value == "fail"
    assert "future-plugin" in finding.evidence["plugins"]
    assert not marker.exists()


def test_malformed_manifest_logging_does_not_echo_source_lines(monkeypatch, tmp_path, caplog):
    from ops.doctor import DoctorOptions, report_to_dict, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root, plugins=["broken"])
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    plugin = root / "plugins" / "broken"
    plugin.mkdir(parents=True)
    sentinel = "DOCTOR-MANIFEST-SECRET-SENTINEL"
    (plugin / "protoagent.plugin.yaml").write_text(
        f"id: broken\nname: Broken\napi_token: [{sentinel}\n",
        encoding="utf-8",
    )

    report = run_doctor(options=DoctorOptions(port=_free_port()))

    assert _finding_map(report)["plugins.manifests"].status.value == "fail"
    assert sentinel not in caplog.text
    assert sentinel not in json.dumps(report_to_dict(report))


def test_malformed_plugin_lock_fails_closed(monkeypatch, tmp_path):
    from infra.paths import instance_paths
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root)
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    lock = instance_paths().plugins_lock
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("{not-json", encoding="utf-8")

    finding = _finding_map(run_doctor(options=DoctorOptions(port=_free_port())))["plugins.lock"]

    assert finding.status.value == "fail"
    assert finding.evidence == {"reason": "lock_unreadable"}


def test_structurally_malformed_plugin_lock_fails_closed(monkeypatch, tmp_path):
    from infra.paths import instance_paths
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root)
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    lock = instance_paths().plugins_lock
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text('{"plugins": "not-a-list"}\n', encoding="utf-8")

    finding = _finding_map(run_doctor(options=DoctorOptions(port=_free_port())))["plugins.lock"]

    assert finding.status.value == "fail"
    assert finding.evidence == {"reason": "lock_unreadable"}


def test_whitespace_plugin_lock_id_fails_closed(monkeypatch, tmp_path):
    from infra.paths import instance_paths
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root)
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    lock = instance_paths().plugins_lock
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text('{"plugins": [{"id": "   "}]}\n', encoding="utf-8")

    finding = _finding_map(run_doctor(options=DoctorOptions(port=_free_port())))["plugins.lock"]

    assert finding.status.value == "fail"
    assert finding.evidence == {"reason": "lock_unreadable"}


def test_plugin_compatibility_detects_missing_entrypoint_without_import(monkeypatch, tmp_path):
    from ops.doctor import DoctorOptions, run_doctor

    root = _isolate(monkeypatch, tmp_path)
    _write_runtime_config(root, plugins=["missing-entry"])
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    plugin = root / "plugins" / "missing-entry"
    plugin.mkdir(parents=True)
    (plugin / "protoagent.plugin.yaml").write_text(
        "id: missing-entry\nname: Missing Entry\nversion: 1.0.0\nentrypoint: absent.py\n",
        encoding="utf-8",
    )

    finding = _finding_map(run_doctor(options=DoctorOptions(port=_free_port())))["plugins.compatibility"]

    assert finding.status.value == "fail"
    assert finding.evidence["plugins"]["missing-entry"] == ["missing_entrypoint"]


def test_doctor_cli_renders_json_and_maps_exit(monkeypatch, capsys):
    from ops.doctor import DoctorFinding, DoctorReport, FindingStatus
    from server import doctor_cli

    report = DoctorReport(
        environment={"os": "Linux"},
        findings=(DoctorFinding("config.parse", FindingStatus.FAIL, "broken"),),
    )
    monkeypatch.setattr(doctor_cli, "run_doctor", lambda **kwargs: report)

    assert doctor_cli.run_doctor_cli(["--json", "--port", "17870"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == 1
    assert payload["summary"]["status"] == "fail"


def test_doctor_cli_rejects_invalid_port():
    import pytest

    from server.doctor_cli import run_doctor_cli

    with pytest.raises(SystemExit) as exc:
        run_doctor_cli(["--port", "0"])
    assert exc.value.code == 2
