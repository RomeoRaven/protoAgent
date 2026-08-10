"""Operator MCP server (ADR 0033 slice 1) — allowlist-gated tool exposure."""

from __future__ import annotations

import json

import httpx
import pytest
from langchain_core.tools import tool

from graph.config import LangGraphConfig
from runtime.state import STATE
from server.operator_mcp import build_server, operator_tools


def _cfg(tools):
    c = LangGraphConfig()
    c.operator_mcp_tools = list(tools)
    c.goal_enabled = False
    return c


@pytest.fixture(autouse=True)
def _bare_state(monkeypatch):
    # No stores → get_all_tools returns just the keyless core tools; no plugin tools.
    for attr in ("knowledge_store", "scheduler", "inbox_store", "tasks_store"):
        monkeypatch.setattr(STATE, attr, None, raising=False)
    monkeypatch.setattr(STATE, "plugin_tools", [], raising=False)


def test_resolver_lives_in_runtime_and_is_reexported():
    """The allowlist/profile resolution moved to runtime/ (ADR 0075 D2) so operator_api can
    import it without breaking the import-layering contract; server.operator_mcp re-exports
    the same objects for existing callers."""
    import runtime.operator_mcp_tools as rt
    import server.operator_mcp as sm

    assert sm.operator_tools is rt.operator_tools
    assert sm.resolve_allow is rt.resolve_allow
    assert sm.resolve_exposed_names is rt.resolve_exposed_names


def test_allowlist_filters_to_named_tools():
    names = {t.name for t in operator_tools(_cfg(["calculator", "current_time"]))}
    assert names == {"calculator", "current_time"}


def test_empty_allowlist_exposes_nothing():
    assert operator_tools(_cfg([])) == []


def test_boot_stores_builds_skills_index(tmp_path, monkeypatch):
    """The sidecar must build STATE.skills_index, not just the other stores —
    load_skill / list_skills / save_skill read it, and a fresh sidecar process
    starts with it None. Regression: an ACP agent calling load_skill through this
    server got "Skills index is not available." despite the prompt listing skills."""
    import types

    import server.agent_init as ai
    from server.operator_mcp import _boot_stores_only

    # Stub the heavy/side-effecting store builders; let the REAL _build_skills_index run.
    monkeypatch.setattr(ai, "_build_knowledge_store", lambda c: None)
    monkeypatch.setattr(ai, "_build_scheduler", lambda c: None)
    monkeypatch.setattr(ai, "_build_inbox_store", lambda c: None)
    monkeypatch.setattr(ai, "_apply_plugin_knowledge_backend", lambda c, ks, p: ks)
    monkeypatch.setattr(
        ai,
        "_build_plugins",
        lambda config, existing_tools=None: types.SimpleNamespace(tools=[], skill_dirs=[], meta={}),
    )
    monkeypatch.setattr(STATE, "tasks_store", object(), raising=False)  # skip real TaskStore
    monkeypatch.setattr(STATE, "skills_index", None, raising=False)

    cfg = _cfg([])
    cfg.skills_db_path = str(tmp_path / "skills.db")  # don't touch the real DB
    _boot_stores_only(cfg)

    assert STATE.skills_index is not None  # the fix — was None before
    # It's a real index the curation tools can query (bundled config/skills seed).
    assert {s["name"] for s in STATE.skills_index.skill_summaries()}


def test_plugin_tools_ride_the_same_bridge(monkeypatch):
    @tool
    def my_plugin_tool(x: str) -> str:
        """A plugin-contributed tool."""
        return x

    monkeypatch.setattr(STATE, "plugin_tools", [my_plugin_tool], raising=False)
    names = {t.name for t in operator_tools(_cfg(["my_plugin_tool", "calculator"]))}
    assert names == {"my_plugin_tool", "calculator"}  # core + plugin, one allowlist


def test_build_server_exposes_allowlisted_as_mcp():
    server, exposed = build_server(_cfg(["calculator"]))
    assert exposed == ["calculator"]
    assert server is not None


def test_star_exposes_all_except_execute_code(monkeypatch):
    from langchain_core.tools import tool

    @tool
    def execute_code(code: str) -> str:
        """run code"""
        return code

    @tool
    def plugin_thing(x: str) -> str:
        """a plugin tool"""
        return x

    monkeypatch.setattr(STATE, "plugin_tools", [execute_code, plugin_thing], raising=False)
    names = {t.name for t in operator_tools(_cfg(["*"]))}
    assert "calculator" in names and "plugin_thing" in names  # core + plugin all flow
    assert "execute_code" not in names  # excluded from the wildcard


def test_star_plus_explicit_name_still_includes_it(monkeypatch):
    from langchain_core.tools import tool

    @tool
    def execute_code(code: str) -> str:
        """run code"""
        return code

    monkeypatch.setattr(STATE, "plugin_tools", [execute_code], raising=False)
    names = {t.name for t in operator_tools(_cfg(["*", "execute_code"]))}
    assert "execute_code" in names  # naming it explicitly overrides the wildcard exclusion


# ── HITL hard-exclusion (ADR 0075 D3 — a real bug: these HANG a foreign MCP client) ──


def test_hitl_tools_never_exposed_even_via_star():
    # ask_human / request_user_input are in the keyless core, so "*" would grab them —
    # but they pause the turn via a LangGraph interrupt only the lead runner resumes.
    names = {t.name for t in operator_tools(_cfg(["*"]))}
    assert "ask_human" not in names and "request_user_input" not in names


def test_hitl_tools_never_exposed_even_when_named():
    names = {t.name for t in operator_tools(_cfg(["ask_human", "request_user_input", "calculator"]))}
    assert names == {"calculator"}  # the HITL names are dropped, hard


# ── profile presets (ADR 0075 D3) ──


def _cfg_profile(profile, tools=()):
    c = _cfg(list(tools))
    c.operator_mcp_profile = profile
    return c


def test_profile_read_only_exposes_reads_not_writes():
    names = {t.name for t in operator_tools(_cfg_profile("read-only"))}
    assert "current_time" in names and "load_skill" in names  # reads/queries
    assert "web_search" in names
    # writes are absent (no memory_ingest / write_note in the read-only set)
    assert "memory_ingest" not in names and "write_note" not in names


def test_profile_full_is_wildcard(monkeypatch):
    from langchain_core.tools import tool

    @tool
    def plugin_thing(x: str) -> str:
        """a plugin tool"""
        return x

    monkeypatch.setattr(STATE, "plugin_tools", [plugin_thing], raising=False)
    names = {t.name for t in operator_tools(_cfg_profile("full"))}
    assert "plugin_thing" in names and "calculator" in names  # everything
    assert "ask_human" not in names  # …still minus the HITL hard-exclusion


def test_profile_unions_with_explicit_names():
    # read-only + an explicitly-named write tool → both
    names = {t.name for t in operator_tools(_cfg_profile("read-only", tools=["show_component"]))}
    assert "current_time" in names and "show_component" in names


def test_unknown_profile_falls_back_to_allowlist():
    names = {t.name for t in operator_tools(_cfg_profile("bogus", tools=["calculator"]))}
    assert names == {"calculator"}  # unknown profile ignored, explicit names honored


def test_safe_operator_profile_stays_closed_until_consent_admission_exists():
    names = {t.name for t in operator_tools(_cfg_profile("safe-operator"))}
    assert names == set()


def test_safe_operator_profile_cannot_be_widened_by_the_explicit_tools_allowlist():
    cfg = _cfg_profile("safe-operator")
    cfg.operator_mcp_tools = ["calculator", "current_time"]

    assert {t.name for t in operator_tools(cfg)} == set()
    _, exposed = build_server(cfg, consent_http=True)
    assert exposed == ["knowledge_ingest"]


def test_explicit_full_trust_env_selects_full_instead_of_combining_with_managed_safe(monkeypatch):
    monkeypatch.setenv("PROTOAGENT_MCP_TRUST", "full")

    _, exposed = build_server(_cfg_profile("safe-operator"), consent_http=True)

    assert "calculator" in exposed
    assert "knowledge_ingest" not in exposed  # bare fixture has no store-bound legacy ingest


def test_safe_operator_http_exposes_only_consented_ingest_and_human_approval_route():
    server, exposed = build_server(_cfg_profile("safe-operator"), consent_http=True)

    assert exposed == ["knowledge_ingest"]
    routes = {route.path for route in server.streamable_http_app().routes}
    assert "/consent/knowledge-ingest/approve" in routes


@pytest.mark.asyncio
async def test_safe_operator_ingest_requires_human_route_then_returns_verified_receipt(tmp_path, monkeypatch):
    from knowledge.store import KnowledgeStore

    source = tmp_path / "approved.md"
    source.write_text("An operator-approved knowledge document. " * 20)
    store = KnowledgeStore(tmp_path / "knowledge.sqlite")
    cfg = _cfg_profile("safe-operator")
    cfg.auth_token = "operator-secret"
    monkeypatch.setattr(STATE, "knowledge_store", store, raising=False)
    monkeypatch.setattr(STATE, "graph_config", cfg, raising=False)
    server, _ = build_server(cfg, consent_http=True)
    args = {"source": str(source), "domain": "approved", "title": "Approved document"}

    planned = json.loads((await server.call_tool("knowledge_ingest", args))[0].text)
    assert planned["ok"] is False
    assert planned["code"] == "approval_required"
    assert set(planned) == {"ok", "code", "operation", "risk", "target_id", "plan_digest", "expires_at"}
    assert str(source) not in repr(planned)

    app = server.streamable_http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        denied = await client.post(
            "/consent/knowledge-ingest/approve",
            json={"plan_digest": planned["plan_digest"], "approved_by": "local-operator"},
        )
        assert denied.status_code == 401
        approved = await client.post(
            "/consent/knowledge-ingest/approve",
            headers={"Authorization": "Bearer operator-secret"},
            json={"plan_digest": planned["plan_digest"], "approved_by": "local-operator"},
        )
        assert approved.status_code == 200
        assert approved.json()["ok"] is True

    executed = json.loads(
        (
            await server.call_tool(
                "knowledge_ingest",
                {**args, "plan_digest": planned["plan_digest"]},
            )
        )[0].text
    )
    assert executed["ok"] is True
    assert executed["verified"] is True
    assert executed["operation"] == "knowledge.ingest"
    assert executed["facts"]["stored_chunks"] > 0
    assert str(source) not in repr(executed)
    assert "operator-secret" not in repr(executed)


@pytest.mark.asyncio
async def test_safe_operator_failed_verification_rolls_back_every_reported_chunk(tmp_path):
    from knowledge.store import KnowledgeStore
    from server.operator_consent import SafeKnowledgeIngestAdapter

    source = tmp_path / "rollback.md"
    source.write_text("A postcondition rollback document. " * 20)
    inner = KnowledgeStore(tmp_path / "knowledge.sqlite")

    class FailVerificationStore:
        rollback_started = False

        def __getattr__(self, name):
            return getattr(inner, name)

        def get_chunk(self, chunk_id):
            return inner.get_chunk(chunk_id) if self.rollback_started else None

        def delete_by_id(self, chunk_id):
            self.rollback_started = True
            return inner.delete_by_id(chunk_id)

    store = FailVerificationStore()
    cfg = _cfg_profile("safe-operator")
    adapter = SafeKnowledgeIngestAdapter(
        knowledge_store=store,
        graph_config=cfg,
        auth_token="operator-secret",
    )
    args = {"source": str(source), "domain": "rollback", "title": "Rollback document"}
    planned = await adapter.plan_or_execute(**args)
    adapter.approve(plan_digest=planned["plan_digest"], approved_by="local-operator")

    failed = await adapter.plan_or_execute(**args, plan_digest=planned["plan_digest"])

    assert failed["ok"] is False
    assert failed["code"] == "verification_failed"
    assert failed["receipt"]["verified"] is False
    assert failed["rollback"]["attempted"] > 0
    assert failed["rollback"] == {
        "attempted": failed["rollback"]["attempted"],
        "remaining": 0,
        "complete": True,
    }
    assert inner.stats()["total"] == 0
    assert str(source) not in repr(failed)


def test_env_trust_full_overrides_deny_default(monkeypatch):
    monkeypatch.setenv("PROTOAGENT_MCP_TRUST", "full")
    names = {t.name for t in operator_tools(_cfg([]))}  # empty allowlist would be deny-all
    assert "calculator" in names and "current_time" in names  # env forces full
    assert "ask_human" not in names  # HITL still hard-excluded
