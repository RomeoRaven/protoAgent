"""Security boundaries for the HTTP-mode safe-operator ingest adapter."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from graph.config import LangGraphConfig
from knowledge.store import KnowledgeStore
from server.operator_consent import SafeKnowledgeIngestAdapter


class Clock:
    def __init__(self):
        self.now = datetime(2026, 8, 9, 20, 0, tzinfo=UTC)

    def __call__(self):
        return self.now

    def advance(self, **kwargs):
        self.now += timedelta(**kwargs)


def _adapter(tmp_path, *, store=None, auth_token="operator-secret", clock=None, **kwargs):
    cfg = LangGraphConfig()
    cfg.operator_mcp_profile = "safe-operator"
    cfg.goal_enabled = False
    return SafeKnowledgeIngestAdapter(
        knowledge_store=store or KnowledgeStore(tmp_path / "knowledge.sqlite"),
        graph_config=cfg,
        auth_token=auth_token,
        clock=clock,
        **kwargs,
    )


def _source(tmp_path, name="source.md"):
    path = tmp_path / name
    path.write_text("Consent-bound operator knowledge. " * 20)
    return path


@pytest.mark.asyncio
async def test_blank_operator_auth_cannot_create_an_approvable_plan(tmp_path):
    adapter = _adapter(tmp_path, auth_token="")

    result = await adapter.plan_or_execute(source=str(_source(tmp_path)))

    assert result == {"ok": False, "code": "operator_auth_required"}


@pytest.mark.asyncio
async def test_receipt_target_identifier_distinguishes_knowledge_stores_without_exposing_paths(tmp_path):
    first = _adapter(tmp_path / "first")
    second = _adapter(tmp_path / "second")

    first_plan = await first.plan_or_execute(source=str(_source(tmp_path, "first.md")))
    second_plan = await second.plan_or_execute(source=str(_source(tmp_path, "second.md")))

    assert first_plan["target_id"] != second_plan["target_id"]
    assert str(tmp_path) not in first_plan["target_id"]
    assert str(tmp_path) not in second_plan["target_id"]


@pytest.mark.asyncio
async def test_missing_or_failing_store_fails_closed_without_exception_detail(tmp_path):
    cfg = LangGraphConfig()
    missing = SafeKnowledgeIngestAdapter(
        knowledge_store=None,
        graph_config=cfg,
        auth_token="operator-secret",
    )

    class FailingStore:
        def stats(self):
            raise OSError("secret store path /private/knowledge.sqlite")

    failing = SafeKnowledgeIngestAdapter(
        knowledge_store=FailingStore(),
        graph_config=cfg,
        auth_token="operator-secret",
    )

    assert await missing.plan_or_execute(source=str(_source(tmp_path))) == {
        "ok": False,
        "code": "store_unavailable",
    }
    failed = await failing.plan_or_execute(source=str(_source(tmp_path, "other.md")))
    assert failed == {"ok": False, "code": "internal_error"}
    assert "/private/knowledge.sqlite" not in repr(failed)


@pytest.mark.asyncio
async def test_changed_input_attempt_consumes_the_pending_approval(tmp_path):
    adapter = _adapter(tmp_path)
    source = _source(tmp_path)
    args = {"source": str(source), "domain": "approved", "title": "Exact title"}
    planned = await adapter.plan_or_execute(**args)
    adapter.approve(plan_digest=planned["plan_digest"], approved_by="local-operator")

    changed = await adapter.plan_or_execute(**{**args, "domain": "changed"}, plan_digest=planned["plan_digest"])
    retry = await adapter.plan_or_execute(**args, plan_digest=planned["plan_digest"])

    assert changed == {"ok": False, "code": "changed_inputs"}
    assert retry == {"ok": False, "code": "missing_approval"}


@pytest.mark.asyncio
async def test_stale_target_attempt_consumes_the_pending_approval(tmp_path):
    store = KnowledgeStore(tmp_path / "knowledge.sqlite")
    adapter = _adapter(tmp_path, store=store)
    source = _source(tmp_path)
    args = {"source": str(source), "domain": "approved"}
    planned = await adapter.plan_or_execute(**args)
    adapter.approve(plan_digest=planned["plan_digest"], approved_by="local-operator")
    store.add_chunk("Unrelated concurrent state change", domain="other")

    stale = await adapter.plan_or_execute(**args, plan_digest=planned["plan_digest"])
    retry = await adapter.plan_or_execute(**args, plan_digest=planned["plan_digest"])

    assert stale == {"ok": False, "code": "stale_target"}
    assert retry == {"ok": False, "code": "missing_approval"}
    assert store.stats()["total"] == 1


@pytest.mark.asyncio
async def test_pending_plan_memory_is_bounded_and_expired_entries_are_reclaimed(tmp_path):
    clock = Clock()
    adapter = _adapter(tmp_path, clock=clock, max_pending_plans=1)

    first = await adapter.plan_or_execute(source=str(_source(tmp_path, "one.md")))
    blocked = await adapter.plan_or_execute(source=str(_source(tmp_path, "two.md")))
    clock.advance(minutes=6)
    reclaimed = await adapter.plan_or_execute(source=str(_source(tmp_path, "three.md")))

    assert first["code"] == "approval_required"
    assert blocked == {"ok": False, "code": "too_many_pending_plans"}
    assert reclaimed["code"] == "approval_required"


@pytest.mark.asyncio
async def test_incomplete_postcondition_rollback_is_reported_as_rollback_incomplete(tmp_path):
    source = _source(tmp_path)
    inner = KnowledgeStore(tmp_path / "knowledge.sqlite")

    class RollbackFailureStore:
        rollback_started = False

        def __getattr__(self, name):
            return getattr(inner, name)

        def get_chunk(self, chunk_id):
            return inner.get_chunk(chunk_id) if self.rollback_started else None

        def delete_by_id(self, _chunk_id):
            self.rollback_started = True
            raise OSError("simulated rollback failure")

    adapter = _adapter(tmp_path, store=RollbackFailureStore())
    args = {"source": str(source), "domain": "rollback"}
    planned = await adapter.plan_or_execute(**args)
    adapter.approve(plan_digest=planned["plan_digest"], approved_by="local-operator")

    failed = await adapter.plan_or_execute(**args, plan_digest=planned["plan_digest"])

    assert failed["ok"] is False
    assert failed["code"] == "rollback_incomplete"
    assert failed["receipt"]["verified"] is False
    assert failed["rollback"]["complete"] is False
    assert failed["rollback"]["remaining"] > 0
    assert inner.stats()["total"] > 0
    assert str(source) not in repr(failed)


@pytest.mark.asyncio
async def test_false_delete_plus_ambiguous_none_lookup_cannot_claim_rollback_complete(tmp_path):
    source = _source(tmp_path)
    inner = KnowledgeStore(tmp_path / "knowledge.sqlite")

    class AmbiguousFailureStore:
        def __getattr__(self, name):
            return getattr(inner, name)

        def get_chunk(self, _chunk_id):
            return None  # built-in store also returns None when its database lookup fails

        def delete_by_id(self, _chunk_id):
            return False  # built-in store returns False when its database delete fails

    adapter = _adapter(tmp_path, store=AmbiguousFailureStore())
    args = {"source": str(source), "domain": "rollback"}
    planned = await adapter.plan_or_execute(**args)
    adapter.approve(plan_digest=planned["plan_digest"], approved_by="local-operator")

    failed = await adapter.plan_or_execute(**args, plan_digest=planned["plan_digest"])

    assert failed["ok"] is False
    assert failed["code"] == "rollback_incomplete"
    assert failed["rollback"]["complete"] is False
    assert failed["rollback"]["remaining"] > 0
    assert inner.stats()["total"] > 0
