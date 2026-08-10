"""Exact-input, expiring operation consent and postcondition receipts (issue #3)."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest

from ops import OpSpec


_NOW = datetime(2026, 8, 9, 23, 0, tzinfo=UTC)


def test_consent_authority_does_not_accept_a_caller_controlled_token_factory():
    from ops.consent import ConsentAuthority

    with pytest.raises(TypeError):
        ConsentAuthority(token_factory=lambda: "predictable-token")


def test_token_collision_retries_are_bounded(monkeypatch):
    from ops.consent import ConsentError

    calls = 0

    def repeated_token(_size):
        nonlocal calls
        calls += 1
        if calls > 9:
            raise AssertionError("token generation did not stop")
        return "repeated-csprng-token"

    monkeypatch.setattr("ops.consent.secrets.token_urlsafe", repeated_token)
    authority = _authority()
    plan = _plan(authority)
    authority.approve(plan, approved_by="local-operator")

    with pytest.raises(ConsentError) as refusal:
        authority.approve(plan, approved_by="local-operator")
    assert refusal.value.code == "token_collision"


def _authority():
    from ops.consent import ConsentAuthority

    return ConsentAuthority(clock=lambda: _NOW)


def _plan(authority):
    from ops import load_all

    return authority.plan(
        load_all()["knowledge.ingest"],
        target_id="agent:default",
        inputs={"source": {"url": "https://example.com/private"}, "domain": "research"},
        target_state={"generation": 7, "runtime_version": "0.127.0"},
        expected_effect="add extracted chunks to the research knowledge domain",
        ttl_seconds=300,
    )


def test_exact_plan_consent_is_single_use_and_secret_free():
    from ops.consent import ConsentError

    authority = _authority()
    plan = _plan(authority)
    grant = authority.approve(plan, approved_by="local-operator", ttl_seconds=60)

    admission = authority.consume(
        grant.token,
        plan,
        inputs={"domain": "research", "source": {"url": "https://example.com/private"}},
        current_target_state={"runtime_version": "0.127.0", "generation": 7},
    )

    assert admission.operation == "knowledge.ingest"
    assert admission.target_id == "agent:default"
    assert admission.approved_by == "local-operator"
    assert admission.plan_digest == plan.digest
    assert "private" not in repr(plan)
    assert grant.token not in repr(grant)
    assert grant.token not in repr(admission)

    with pytest.raises(ConsentError, match="already used") as replay:
        authority.consume(
            grant.token,
            plan,
            inputs={"domain": "research", "source": {"url": "https://example.com/private"}},
            current_target_state={"generation": 7, "runtime_version": "0.127.0"},
        )
    assert replay.value.code == "replayed_approval"


def test_knowledge_ingest_receipt_requires_operation_specific_postcondition():
    from ops.consent import default_verification_registry
    from ops.knowledge import IngestResult

    authority = _authority()
    plan = _plan(authority)
    grant = authority.approve(plan, approved_by="local-operator")
    admission = authority.consume(
        grant.token,
        plan,
        inputs={"source": {"url": "https://example.com/private"}, "domain": "research"},
        current_target_state={"generation": 7, "runtime_version": "0.127.0"},
    )
    result = IngestResult(
        ids=[41, 42],
        chunks=2,
        chars=900,
        title="Private source title",
        source_type="html",
        source="https://example.com/private",
    )

    receipt = default_verification_registry(clock=lambda: _NOW).verify(
        admission,
        result,
        context={"chunk_exists": lambda chunk_id: chunk_id in {41, 42}},
    )

    assert receipt.verified is True
    assert receipt.operation == "knowledge.ingest"
    assert receipt.verifier == "knowledge_chunks_exist"
    assert receipt.facts == {"reported_chunks": 2, "stored_chunks": 2, "unique_ids": 2}
    assert receipt.plan_digest == plan.digest
    assert "Private source title" not in repr(receipt)
    assert "example.com/private" not in repr(receipt)
    assert "[41, 42]" not in repr(receipt)
    with pytest.raises(TypeError):
        cast(Any, receipt.facts)["leak"] = 1


@pytest.mark.parametrize(
    ("inputs", "state", "code"),
    [
        (
            {"source": {"url": "https://example.com/changed"}, "domain": "research"},
            {"generation": 7, "runtime_version": "0.127.0"},
            "changed_inputs",
        ),
        (
            {"source": {"url": "https://example.com/private"}, "domain": "research"},
            {"generation": 8, "runtime_version": "0.127.0"},
            "stale_target",
        ),
    ],
)
def test_changed_inputs_or_target_state_revoke_the_approval(inputs, state, code):
    from ops.consent import ConsentError

    authority = _authority()
    plan = _plan(authority)
    grant = authority.approve(plan, approved_by="local-operator")

    with pytest.raises(ConsentError) as refusal:
        authority.consume(grant.token, plan, inputs=inputs, current_target_state=state)
    assert refusal.value.code == code

    with pytest.raises(ConsentError) as replay:
        authority.consume(
            grant.token,
            plan,
            inputs={"source": {"url": "https://example.com/private"}, "domain": "research"},
            current_target_state={"generation": 7, "runtime_version": "0.127.0"},
        )
    assert replay.value.code == "replayed_approval"


def test_malformed_changed_inputs_still_consume_the_approval_attempt():
    from ops.consent import ConsentError

    authority = _authority()
    plan = _plan(authority)
    grant = authority.approve(plan, approved_by="local-operator")

    with pytest.raises(ConsentError) as malformed:
        authority.consume(
            grant.token,
            plan,
            inputs=object(),
            current_target_state={"generation": 7, "runtime_version": "0.127.0"},
        )
    assert malformed.value.code == "unsupported_value"

    with pytest.raises(ConsentError) as replay:
        authority.consume(
            grant.token,
            plan,
            inputs={"source": {"url": "https://example.com/private"}, "domain": "research"},
            current_target_state={"generation": 7, "runtime_version": "0.127.0"},
        )
    assert replay.value.code == "replayed_approval"


def test_expected_effect_tampering_revokes_the_approval():
    from ops.consent import ConsentError

    authority = _authority()
    plan = _plan(authority)
    grant = authority.approve(plan, approved_by="local-operator")
    changed = replace(plan, expected_effect="delete all knowledge")

    with pytest.raises(ConsentError) as refusal:
        authority.consume(
            grant.token,
            changed,
            inputs={"source": {"url": "https://example.com/private"}, "domain": "research"},
            current_target_state={"generation": 7, "runtime_version": "0.127.0"},
        )
    assert refusal.value.code == "changed_plan"


def test_expired_approval_fails_closed():
    from ops.consent import ConsentAuthority, ConsentError

    current = [_NOW]
    authority = ConsentAuthority(clock=lambda: current[0])
    plan = _plan(authority)
    grant = authority.approve(plan, approved_by="local-operator", ttl_seconds=5)
    current[0] += timedelta(seconds=5)

    with pytest.raises(ConsentError) as refusal:
        authority.consume(
            grant.token,
            plan,
            inputs={"source": {"url": "https://example.com/private"}, "domain": "research"},
            current_target_state={"generation": 7, "runtime_version": "0.127.0"},
        )
    assert refusal.value.code == "expired_approval"


@pytest.mark.parametrize("operation", ["config.get", "config.set"])
def test_safe_operator_authority_rejects_non_reversible_risk(operation):
    from ops import load_all
    from ops.consent import ConsentError

    with pytest.raises(ConsentError) as refusal:
        _authority().plan(
            load_all()[operation],
            target_id="agent:default",
            inputs={},
            target_state={"generation": 7},
            expected_effect="test effect",
        )
    assert refusal.value.code == "risk_not_allowed"


def test_plan_rejects_forged_operation_risk_metadata():
    from ops.consent import ConsentError

    forged = OpSpec(name="config.set", risk="reversible", summary="pretend this is safe")
    with pytest.raises(ConsentError) as refusal:
        _authority().plan(
            forged,
            target_id="agent:default",
            inputs={"updates": {"server.port": 9000}},
            target_state={"generation": 7},
            expected_effect="rewrite server config",
        )
    assert refusal.value.code == "operation_metadata_mismatch"


def test_approve_revalidates_deserialized_plan_against_registry():
    from ops.consent import ConsentError, digest_value

    authority = _authority()
    forged = replace(_plan(authority), operation="config.set", risk="reversible", digest="")
    payload = {
        "operation": forged.operation,
        "risk": forged.risk,
        "target_id": forged.target_id,
        "inputs_digest": forged.inputs_digest,
        "target_state_digest": forged.target_state_digest,
        "expected_effect": forged.expected_effect,
        "expected_effect_digest": forged.expected_effect_digest,
        "created_at": forged.created_at.isoformat(),
        "expires_at": forged.expires_at.isoformat(),
    }
    forged = replace(forged, digest=digest_value(payload))

    with pytest.raises(ConsentError) as refusal:
        authority.approve(forged, approved_by="local-operator")
    assert refusal.value.code == "operation_metadata_mismatch"


def test_receipt_identifiers_reject_arbitrary_or_secret_like_text():
    from ops import load_all
    from ops.consent import ConsentError

    with pytest.raises(ConsentError) as bad_target:
        _authority().plan(
            load_all()["knowledge.ingest"],
            target_id="agent:default\nBearer private-token",
            inputs={},
            target_state={"generation": 7},
            expected_effect="add knowledge",
        )
    assert bad_target.value.code == "invalid_target"

    authority = _authority()
    with pytest.raises(ConsentError) as bad_approver:
        authority.approve(_plan(authority), approved_by="Bearer private-token")
    assert bad_approver.value.code == "invalid_approver"


def test_input_digest_is_order_independent_and_bytes_sensitive():
    from ops.consent import digest_value

    left = {"b": [1, {"payload": b"alpha"}], "a": True}
    right = {"a": True, "b": [1, {"payload": b"alpha"}]}
    changed = {"a": True, "b": [1, {"payload": b"beta"}]}
    assert digest_value(left) == digest_value(right)
    assert digest_value(left) != digest_value(changed)


def test_failed_postcondition_raises_with_secret_free_failure_receipt():
    from ops.consent import VerificationFailed, default_verification_registry
    from ops.knowledge import IngestResult

    authority = _authority()
    plan = _plan(authority)
    grant = authority.approve(plan, approved_by="local-operator")
    admission = authority.consume(
        grant.token,
        plan,
        inputs={"source": {"url": "https://example.com/private"}, "domain": "research"},
        current_target_state={"generation": 7, "runtime_version": "0.127.0"},
    )
    result = IngestResult(
        ids=[51, 52],
        chunks=2,
        chars=900,
        title="Secret title",
        source_type="html",
        source="https://example.com/private",
    )

    with pytest.raises(VerificationFailed) as failed:
        default_verification_registry(clock=lambda: _NOW).verify(
            admission,
            result,
            context={"chunk_exists": lambda chunk_id: chunk_id == 51},
        )
    receipt = failed.value.receipt
    assert receipt.verified is False
    assert receipt.facts == {"reported_chunks": 2, "stored_chunks": 1, "unique_ids": 2}
    assert "Secret title" not in repr(receipt)
    assert "example.com/private" not in repr(receipt)
    assert "[51, 52]" not in repr(receipt)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("target_id", "agent:default\nBearer raw-token"),
        ("approved_by", "Bearer raw-token"),
        ("plan_digest", "not-a-digest"),
        ("expected_effect_digest", "not-a-digest"),
        ("risk", "destructive"),
    ],
)
def test_verification_rejects_unsafe_or_noncanonical_admission_metadata(field, value):
    from ops.consent import Admission, ConsentError, default_verification_registry
    from ops.knowledge import IngestResult

    admission = Admission(
        operation="knowledge.ingest",
        risk="reversible",
        target_id="agent:default",
        plan_digest=f"sha256:{'a' * 64}",
        expected_effect_digest=f"sha256:{'b' * 64}",
        approved_by="local-operator",
        approved_at=_NOW,
        admitted_at=_NOW,
    )
    admission = replace(admission, **{field: value})
    result = IngestResult(ids=[41], chunks=1, chars=20, title="safe", source_type="text", source="inline")

    with pytest.raises(ConsentError) as refusal:
        default_verification_registry(clock=lambda: _NOW).verify(
            admission,
            result,
            context={"chunk_exists": lambda chunk_id: chunk_id == 41},
        )
    assert refusal.value.code == "invalid_admission"


def test_verifier_name_must_be_a_safe_receipt_identifier():
    from ops.consent import ConsentError, VerificationRegistry, VerificationResult

    registry = VerificationRegistry(clock=lambda: _NOW)
    with pytest.raises(ConsentError) as refusal:
        registry.register(
            "knowledge.ingest",
            "Bearer raw-secret",
            lambda _admission, _result, _context: VerificationResult(True, {}, {}),
        )
    assert refusal.value.code == "invalid_verifier"


def test_operation_without_registered_postcondition_fails_closed():
    from ops.consent import Admission, ConsentError, VerificationRegistry

    admission = Admission(
        operation="config.set",
        risk="disruptive",
        target_id="agent:default",
        plan_digest=f"sha256:{'a' * 64}",
        expected_effect_digest=f"sha256:{'b' * 64}",
        approved_by="local-operator",
        approved_at=_NOW,
        admitted_at=_NOW,
    )
    with pytest.raises(ConsentError) as refusal:
        VerificationRegistry(clock=lambda: _NOW).verify(admission, object(), context={})
    assert refusal.value.code == "missing_verifier"
