"""ops core (ADR 0075 D2) — the op registry + injected context."""

from __future__ import annotations

import pytest

from ops import OpContext, OpSpec, op, registry


def test_op_decorator_registers_and_stamps():
    @op(name="test.sample_op", risk="read", summary="a sample")
    async def sample():
        return 1

    assert sample.op_spec == OpSpec(name="test.sample_op", risk="read", summary="a sample")
    assert sample.op_spec.mutates is False
    assert sample.op_spec.as_dict() == {
        "name": "test.sample_op",
        "risk": "read",
        "mutates": False,
        "summary": "a sample",
    }
    assert registry()["test.sample_op"].summary == "a sample"


def test_op_duplicate_same_metadata_is_idempotent():
    @op(name="test.dup_ok", risk="reversible", summary="same")
    async def a():
        return 1

    @op(name="test.dup_ok", risk="reversible", summary="same")  # re-import / re-decorate is fine
    async def b():
        return 2

    assert registry()["test.dup_ok"].mutates is True


def test_op_duplicate_conflicting_metadata_raises():
    @op(name="test.dup_bad", risk="read", summary="v1")
    async def a():
        return 1

    with pytest.raises(ValueError):

        @op(name="test.dup_bad", risk="disruptive", summary="v2")  # same name, different metadata
        async def b():
            return 2


def test_op_rejects_unknown_risk_before_registration():
    with pytest.raises(ValueError, match="invalid risk"):
        op(name="test.invalid_risk", risk="safe-ish", summary="ambiguous")
    assert "test.invalid_risk" not in registry()


def test_op_context_from_state(monkeypatch):
    import runtime.state as rs

    monkeypatch.setattr(rs.STATE, "knowledge_store", "KS", raising=False)
    monkeypatch.setattr(rs.STATE, "graph_config", "CFG", raising=False)
    ctx = OpContext.from_state()
    assert ctx.knowledge_store == "KS" and ctx.graph_config == "CFG"
