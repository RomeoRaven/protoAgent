"""HTTP-mode safe-operator consent adapters.

The FastMCP server owns this adapter so its human approval route and model-visible
execution tool share one in-memory :class:`ops.consent.ConsentAuthority`. Grant
tokens never leave this process.
"""

from __future__ import annotations

import hmac
import threading
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse

from ops import OpContext, load_all
from ops.consent import (
    ConsentAuthority,
    ConsentError,
    ConsentGrant,
    ExecutionReceipt,
    OperationPlan,
    VerificationFailed,
    default_verification_registry,
    digest_value,
)
from ops.knowledge import IngestError, IngestSource, ingest

MAX_PENDING_PLANS = 64


@dataclass
class _PendingIngest:
    plan: OperationPlan
    grant: ConsentGrant | None = None


def _receipt_payload(receipt: ExecutionReceipt) -> dict[str, Any]:
    return {
        "operation": receipt.operation,
        "risk": receipt.risk,
        "target_id": receipt.target_id,
        "plan_digest": receipt.plan_digest,
        "expected_effect_digest": receipt.expected_effect_digest,
        "approved_by": receipt.approved_by,
        "verifier": receipt.verifier,
        "verified": receipt.verified,
        "facts": dict(receipt.facts),
        "evidence_digest": receipt.evidence_digest,
        "checked_at": receipt.checked_at.isoformat(),
    }


class SafeKnowledgeIngestAdapter:
    """Two-step, exact-input adapter for the first safe-operator write."""

    def __init__(
        self,
        *,
        knowledge_store,
        graph_config,
        auth_token: str,
        clock: Callable[[], datetime] | None = None,
        max_pending_plans: int = MAX_PENDING_PLANS,
    ) -> None:
        if isinstance(max_pending_plans, bool) or not isinstance(max_pending_plans, int) or max_pending_plans < 1:
            raise ValueError("max_pending_plans must be a positive integer")
        self._store = knowledge_store
        self._graph_config = graph_config
        self._auth_token = str(auth_token or "").strip()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._authority = ConsentAuthority(clock=self._clock)
        self._verifiers = default_verification_registry(clock=self._clock)
        self._pending: dict[str, _PendingIngest] = {}
        self._max_pending_plans = max_pending_plans
        self._lock = threading.Lock()
        instance = str(getattr(graph_config, "instance_id", "") or "default")
        store_identity = getattr(knowledge_store, "path", None)
        if store_identity is None and knowledge_store is not None:
            store_identity = f"{type(knowledge_store).__module__}.{type(knowledge_store).__qualname__}"
        target_digest = digest_value({"instance": instance, "store": str(store_identity or "unavailable")})
        self._target_id = f"agent:{target_digest[-16:]}"

    @staticmethod
    def _inputs(source: str, domain: str, title: str | None) -> tuple[IngestSource, str, str | None, dict[str, Any]]:
        src = str(source or "").strip()
        if not src:
            raise ConsentError("invalid_source", "knowledge ingest requires a URL or local path")
        dom = str(domain or "general").strip() or "general"
        heading = str(title).strip() if title is not None else None
        heading = heading or None
        shaped = (
            IngestSource.from_url(src)
            if src.lower().startswith(("http://", "https://"))
            else IngestSource.from_path(src)
        )
        inputs = {"source": asdict(shaped), "domain": dom, "title": heading}
        return shaped, dom, heading, inputs

    def _target_state(self) -> dict[str, Any]:
        stats = self._store.stats()
        return {"knowledge_stats": stats}

    async def plan_or_execute(
        self,
        *,
        source: str,
        domain: str = "general",
        title: str | None = None,
        plan_digest: str | None = None,
    ) -> dict[str, Any]:
        if self._store is None:
            return {"ok": False, "code": "store_unavailable"}
        try:
            shaped, dom, heading, inputs = self._inputs(source, domain, title)
            if not plan_digest:
                if not self._auth_token:
                    return {"ok": False, "code": "operator_auth_required"}
                plan = self._authority.plan(
                    load_all()["knowledge.ingest"],
                    target_id=self._target_id,
                    inputs=inputs,
                    target_state=self._target_state(),
                    expected_effect="add extracted chunks to the approved knowledge domain",
                )
                with self._lock:
                    for digest, pending in list(self._pending.items()):
                        expiry = pending.grant.expires_at if pending.grant is not None else pending.plan.expires_at
                        if expiry <= plan.created_at:
                            self._pending.pop(digest, None)
                    if len(self._pending) >= self._max_pending_plans:
                        return {"ok": False, "code": "too_many_pending_plans"}
                    self._pending[plan.digest] = _PendingIngest(plan=plan)
                return {
                    "ok": False,
                    "code": "approval_required",
                    "operation": plan.operation,
                    "risk": plan.risk,
                    "target_id": plan.target_id,
                    "plan_digest": plan.digest,
                    "expires_at": plan.expires_at.isoformat(),
                }

            with self._lock:
                pending = self._pending.pop(str(plan_digest), None)
            if pending is None:
                return {"ok": False, "code": "missing_approval"}
            if pending.grant is None:
                return {"ok": False, "code": "approval_required", "plan_digest": pending.plan.digest}

            admission = self._authority.consume(
                pending.grant.token,
                pending.plan,
                inputs=inputs,
                current_target_state=self._target_state(),
            )
            result = await ingest(
                shaped,
                domain=dom,
                title=heading,
                ctx=OpContext(knowledge_store=self._store, graph_config=self._graph_config),
            )
            try:
                receipt = self._verifiers.verify(
                    admission,
                    result,
                    context={
                        "chunk_exists": lambda chunk_id: bool(
                            getattr(self._store, "get_chunk", lambda _chunk_id: None)(chunk_id)
                        )
                    },
                )
            except VerificationFailed as exc:
                rollback = self._rollback(result.ids)
                return {
                    "ok": False,
                    "code": exc.code if rollback["complete"] else "rollback_incomplete",
                    "receipt": _receipt_payload(exc.receipt),
                    "rollback": rollback,
                }
            return {"ok": True, **_receipt_payload(receipt)}
        except ConsentError as exc:
            return {"ok": False, "code": exc.code}
        except IngestError as exc:
            return {"ok": False, "code": f"ingest_{exc.kind}"}
        except Exception:  # noqa: BLE001 — never expose backend/path details over MCP
            return {"ok": False, "code": "internal_error"}

    def approve(self, *, plan_digest: str, approved_by: str) -> dict[str, Any]:
        with self._lock:
            pending = self._pending.get(str(plan_digest))
            if pending is None:
                raise ConsentError("missing_plan", "operation plan not found")
            if pending.grant is not None:
                raise ConsentError("already_approved", "operation plan is already approved")
            grant = self._authority.approve(pending.plan, approved_by=approved_by)
            pending.grant = grant
        return {
            "ok": True,
            "plan_digest": pending.plan.digest,
            "expires_at": grant.expires_at.isoformat(),
        }

    def authorized(self, header: str | None) -> bool:
        if not self._auth_token:
            return False
        raw = str(header or "")
        token = raw[7:].strip() if raw[:7].lower() == "bearer " else ""
        return bool(token) and hmac.compare_digest(token, self._auth_token)

    def _rollback(self, ids: list[int]) -> dict[str, Any]:
        valid = list(
            dict.fromkeys(
                chunk_id
                for chunk_id in ids
                if isinstance(chunk_id, int) and not isinstance(chunk_id, bool) and chunk_id > 0
            )
        )
        delete = getattr(self._store, "delete_by_id", None)
        get = getattr(self._store, "get_chunk", None)
        confirmed_absent = 0
        for chunk_id in valid:
            deleted = False
            if callable(delete):
                try:
                    deleted = delete(chunk_id) is True
                except Exception:  # noqa: BLE001 — continue rollback for every reported id
                    deleted = False
            # ``KnowledgeStore.get_chunk`` returns None both for absence and for a
            # database read failure. Only a successful deletion plus a subsequent
            # absent lookup is strong enough to claim rollback completion.
            if deleted and callable(get):
                try:
                    confirmed_absent += get(chunk_id) is None
                except Exception:  # noqa: BLE001 — an unreadable postcondition is unconfirmed
                    pass
        remaining = len(valid) - confirmed_absent
        return {"attempted": len(valid), "remaining": remaining, "complete": remaining == 0}


def register_safe_operator_ingest(server, config) -> list[str]:
    """Register the consented knowledge-ingest tool and bearer-gated human route."""

    from runtime.state import STATE

    adapter = SafeKnowledgeIngestAdapter(
        knowledge_store=STATE.knowledge_store,
        graph_config=config,
        auth_token=getattr(config, "auth_token", ""),
    )

    @server.tool(name="knowledge_ingest")
    async def knowledge_ingest(
        source: str,
        domain: str = "general",
        title: str | None = None,
        plan_digest: str | None = None,
    ) -> dict:
        """Plan or execute one human-approved URL/file knowledge ingest."""

        return await adapter.plan_or_execute(
            source=source,
            domain=domain,
            title=title,
            plan_digest=plan_digest,
        )

    @server.custom_route(
        "/consent/knowledge-ingest/approve",
        methods=["POST"],
        include_in_schema=False,
    )
    async def approve_knowledge_ingest(request: Request):
        if not adapter.authorized(request.headers.get("Authorization")):
            status = 503 if not getattr(config, "auth_token", "") else 401
            return JSONResponse({"ok": False, "code": "operator_auth_required"}, status_code=status)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError
            result = adapter.approve(
                plan_digest=str(body.get("plan_digest") or ""),
                approved_by=str(body.get("approved_by") or ""),
            )
            return JSONResponse(result)
        except ConsentError as exc:
            status = 404 if exc.code == "missing_plan" else 409 if exc.code == "already_approved" else 400
            return JSONResponse({"ok": False, "code": exc.code}, status_code=status)
        except (TypeError, ValueError):
            return JSONResponse({"ok": False, "code": "invalid_request"}, status_code=400)

    return ["knowledge_ingest"]
