"""Per-run operation consent primitives for the future safe-operator profile.

The module owns planning and admission only. It exposes no tool or HTTP route and
never invokes an operation. A human-facing adapter may issue a grant; an execution
adapter may only consume it for the exact operation, target, inputs, target state,
and expected effect that were approved.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
import threading
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Iterable, Mapping

from ops import OPERATION_RISKS, OpSpec

MAX_CONSENT_TTL_SECONDS = 15 * 60
_SAFE_IDENTIFIER = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}\Z")


class ConsentError(Exception):
    """A fail-closed consent refusal with a stable, secret-free code."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _canonical(value: Any) -> Any:
    """Return a deterministic JSON-safe shape without retaining caller data."""

    if is_dataclass(value) and not isinstance(value, type):
        return _canonical(asdict(value))
    if isinstance(value, bytes):
        return {
            "$bytes_sha256": hashlib.sha256(value).hexdigest(),
            "$bytes_length": len(value),
        }
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise ConsentError("unsupported_value", "consent values require string mapping keys")
        return {key: _canonical(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ConsentError("unsupported_value", "consent values require finite numbers")
        return value
    raise ConsentError("unsupported_value", f"unsupported consent value type: {type(value).__name__}")


def digest_value(value: Any) -> str:
    """A stable digest for exact-input/state/effect binding."""

    encoded = json.dumps(
        _canonical(value),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _now_utc(clock: Callable[[], datetime]) -> datetime:
    now = clock()
    if now.tzinfo is None:
        raise ConsentError("invalid_clock", "consent clock must return a timezone-aware datetime")
    return now.astimezone(UTC)


def _ttl(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_CONSENT_TTL_SECONDS:
        raise ConsentError(
            "invalid_ttl",
            f"consent ttl must be an integer from 1 to {MAX_CONSENT_TTL_SECONDS} seconds",
        )
    return value


def _identifier(value: Any, *, code: str, label: str) -> str:
    identifier = str(value).strip()
    if not _SAFE_IDENTIFIER.fullmatch(identifier):
        raise ConsentError(code, f"{label} must be a safe identifier")
    return identifier


@dataclass(frozen=True)
class OperationPlan:
    operation: str
    risk: str
    target_id: str
    inputs_digest: str
    target_state_digest: str
    expected_effect: str
    expected_effect_digest: str
    created_at: datetime
    expires_at: datetime
    digest: str


@dataclass(frozen=True)
class ConsentGrant:
    token: str = field(repr=False)
    plan_digest: str
    approved_by: str
    approved_at: datetime
    expires_at: datetime


@dataclass(frozen=True)
class Admission:
    operation: str
    risk: str
    target_id: str
    plan_digest: str
    expected_effect_digest: str
    approved_by: str
    approved_at: datetime
    admitted_at: datetime


@dataclass
class _GrantRecord:
    plan_digest: str
    approved_by: str
    approved_at: datetime
    expires_at: datetime
    used: bool = False


def _plan_payload(plan: OperationPlan) -> dict[str, Any]:
    return {
        "operation": plan.operation,
        "risk": plan.risk,
        "target_id": plan.target_id,
        "inputs_digest": plan.inputs_digest,
        "target_state_digest": plan.target_state_digest,
        "expected_effect": plan.expected_effect,
        "expected_effect_digest": plan.expected_effect_digest,
        "created_at": plan.created_at.isoformat(),
        "expires_at": plan.expires_at.isoformat(),
    }


def _plan_digest(plan: OperationPlan) -> str:
    return digest_value(_plan_payload(plan))


class ConsentAuthority:
    """Issue and atomically consume per-run capability grants.

    Grants live only in this object. Process restart revokes them all, which is the
    intended per-run safety posture. Raw capability tokens are returned once and only
    their SHA-256 digests are retained internally.
    """

    def __init__(
        self,
        *,
        allowed_risks: Iterable[str] = ("reversible",),
        clock: Callable[[], datetime] | None = None,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        risks = frozenset(str(risk).strip().lower() for risk in allowed_risks)
        if not risks or not risks <= OPERATION_RISKS or "read" in risks:
            raise ConsentError("invalid_policy", "consent policy must name one or more non-read operation risks")
        self._allowed_risks = risks
        self._clock = clock or (lambda: datetime.now(UTC))
        self._token_factory = token_factory or (lambda: secrets.token_urlsafe(32))
        self._grants: dict[str, _GrantRecord] = {}
        self._lock = threading.Lock()

    def plan(
        self,
        spec: OpSpec,
        *,
        target_id: str,
        inputs: Any,
        target_state: Any,
        expected_effect: str,
        ttl_seconds: int = 300,
    ) -> OperationPlan:
        from ops import load_all

        now = _now_utc(self._clock)
        ttl = _ttl(ttl_seconds)
        target = _identifier(target_id, code="invalid_target", label="operation target")
        effect = str(expected_effect).strip()
        registered = load_all().get(spec.name)
        if registered is None:
            raise ConsentError("unknown_operation", f"operation {spec.name!r} is not registered")
        if registered != spec:
            raise ConsentError(
                "operation_metadata_mismatch",
                f"operation {spec.name!r} metadata does not match the registry",
            )
        if spec.risk not in self._allowed_risks:
            raise ConsentError("risk_not_allowed", f"operation risk {spec.risk!r} is not allowed by this authority")
        if not effect:
            raise ConsentError("invalid_effect", "operation consent requires an expected effect")
        plan = OperationPlan(
            operation=spec.name,
            risk=spec.risk,
            target_id=target,
            inputs_digest=digest_value(inputs),
            target_state_digest=digest_value(target_state),
            expected_effect=effect,
            expected_effect_digest=digest_value(effect),
            created_at=now,
            expires_at=now + timedelta(seconds=ttl),
            digest="",
        )
        return OperationPlan(**{**plan.__dict__, "digest": _plan_digest(plan)})

    def approve(
        self,
        plan: OperationPlan,
        *,
        approved_by: str,
        ttl_seconds: int = 120,
    ) -> ConsentGrant:
        now = _now_utc(self._clock)
        ttl = _ttl(ttl_seconds)
        approver = _identifier(approved_by, code="invalid_approver", label="approving operator")
        self._validate_plan(plan)
        if plan.risk not in self._allowed_risks:
            raise ConsentError("risk_not_allowed", f"operation risk {plan.risk!r} is not allowed by this authority")
        if now >= plan.expires_at:
            raise ConsentError("expired_plan", "operation plan has expired")
        expires_at = min(plan.expires_at, now + timedelta(seconds=ttl))
        with self._lock:
            while True:
                token = str(self._token_factory())
                if not token:
                    raise ConsentError("invalid_token", "consent token factory returned an empty token")
                token_digest = digest_value(token)
                if token_digest not in self._grants:
                    break
            self._grants[token_digest] = _GrantRecord(
                plan_digest=plan.digest,
                approved_by=approver,
                approved_at=now,
                expires_at=expires_at,
            )
        return ConsentGrant(
            token=token,
            plan_digest=plan.digest,
            approved_by=approver,
            approved_at=now,
            expires_at=expires_at,
        )

    def consume(
        self,
        token: str,
        plan: OperationPlan,
        *,
        inputs: Any,
        current_target_state: Any,
    ) -> Admission:
        now = _now_utc(self._clock)
        token_digest = digest_value(str(token))
        with self._lock:
            record = self._grants.get(token_digest)
            if record is None:
                raise ConsentError("missing_approval", "approval not found")
            if record.used:
                raise ConsentError("replayed_approval", "approval was already used")

            def refuse(code: str, detail: str) -> None:
                record.used = True
                raise ConsentError(code, detail)

            if now >= record.expires_at:
                refuse("expired_approval", "approval has expired")
            try:
                self._validate_plan(plan)
            except ConsentError as exc:
                refuse(exc.code, exc.detail)
            if now >= plan.expires_at:
                refuse("expired_plan", "operation plan has expired")
            if record.plan_digest != plan.digest:
                refuse("changed_plan", "approval does not match this operation plan")
            if digest_value(inputs) != plan.inputs_digest:
                refuse("changed_inputs", "operation inputs changed after approval")
            if digest_value(current_target_state) != plan.target_state_digest:
                refuse("stale_target", "target state changed after planning")
            record.used = True
            return Admission(
                operation=plan.operation,
                risk=plan.risk,
                target_id=plan.target_id,
                plan_digest=plan.digest,
                expected_effect_digest=plan.expected_effect_digest,
                approved_by=record.approved_by,
                approved_at=record.approved_at,
                admitted_at=now,
            )

    @staticmethod
    def _validate_plan(plan: OperationPlan) -> None:
        from ops import load_all

        if _plan_digest(plan) != plan.digest:
            raise ConsentError("changed_plan", "operation plan changed after it was created")
        registered = load_all().get(plan.operation)
        if registered is None:
            raise ConsentError("unknown_operation", f"operation {plan.operation!r} is not registered")
        if registered.risk != plan.risk:
            raise ConsentError(
                "operation_metadata_mismatch",
                f"operation {plan.operation!r} metadata does not match the registry",
            )
        if _identifier(plan.target_id, code="invalid_target", label="operation target") != plan.target_id:
            raise ConsentError("changed_plan", "operation target changed after planning")
        if not plan.expected_effect or digest_value(plan.expected_effect) != plan.expected_effect_digest:
            raise ConsentError("changed_plan", "expected effect changed after planning")
        if plan.created_at.tzinfo is None or plan.expires_at.tzinfo is None:
            raise ConsentError("changed_plan", "operation plan timestamps must be timezone-aware")
        duration = (plan.expires_at - plan.created_at).total_seconds()
        if not 0 < duration <= MAX_CONSENT_TTL_SECONDS:
            raise ConsentError("changed_plan", "operation plan lifetime is outside the consent limit")


@dataclass(frozen=True)
class VerificationResult:
    """Private verifier output; only safe scalar facts and an evidence digest escape."""

    passed: bool
    facts: Mapping[str, int | bool]
    evidence: Any


@dataclass(frozen=True)
class ExecutionReceipt:
    operation: str
    risk: str
    target_id: str
    plan_digest: str
    expected_effect_digest: str
    approved_by: str
    verifier: str
    verified: bool
    facts: Mapping[str, int | bool]
    evidence_digest: str
    checked_at: datetime


class VerificationFailed(ConsentError):
    """A failed operation-specific postcondition with a secret-free receipt."""

    def __init__(self, receipt: ExecutionReceipt):
        super().__init__("verification_failed", "operation postcondition verification failed")
        self.receipt = receipt


Verifier = Callable[[Admission, Any, Mapping[str, Any]], VerificationResult]


class VerificationRegistry:
    """Dispatch postcondition checks by operation name; no generic pass/fail bypass."""

    def __init__(self, *, clock: Callable[[], datetime] | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(UTC))
        self._verifiers: dict[str, tuple[str, Verifier]] = {}

    def register(self, operation: str, verifier_name: str, verifier: Verifier) -> None:
        op_name = str(operation).strip()
        check_name = str(verifier_name).strip()
        if not op_name or not check_name or not callable(verifier):
            raise ConsentError("invalid_verifier", "postcondition verifier requires names and a callable")
        candidate = (check_name, verifier)
        if op_name in self._verifiers and self._verifiers[op_name] != candidate:
            raise ConsentError("duplicate_verifier", f"operation {op_name!r} already has a postcondition verifier")
        self._verifiers[op_name] = candidate

    def verify(
        self,
        admission: Admission,
        result: Any,
        *,
        context: Mapping[str, Any],
    ) -> ExecutionReceipt:
        registered = self._verifiers.get(admission.operation)
        if registered is None:
            raise ConsentError("missing_verifier", f"operation {admission.operation!r} has no postcondition verifier")
        verifier_name, verifier = registered
        try:
            outcome = verifier(admission, result, context)
        except Exception as exc:  # noqa: BLE001 — fail closed without returning exception detail
            outcome = VerificationResult(
                passed=False,
                facts={"check_error": True},
                evidence={"error_type": type(exc).__name__},
            )
        facts = _safe_facts(outcome.facts)
        receipt = ExecutionReceipt(
            operation=admission.operation,
            risk=admission.risk,
            target_id=admission.target_id,
            plan_digest=admission.plan_digest,
            expected_effect_digest=admission.expected_effect_digest,
            approved_by=admission.approved_by,
            verifier=verifier_name,
            verified=bool(outcome.passed),
            facts=facts,
            evidence_digest=digest_value(outcome.evidence),
            checked_at=_now_utc(self._clock),
        )
        if not receipt.verified:
            raise VerificationFailed(receipt)
        return receipt


def _safe_facts(facts: Mapping[str, int | bool]) -> dict[str, int | bool]:
    safe: dict[str, int | bool] = {}
    for key in sorted(facts):
        value = facts[key]
        if not key or not key.replace("_", "").isalnum() or not key[0].isalpha():
            raise ConsentError("unsafe_evidence", "receipt fact names must be alphanumeric snake_case")
        if isinstance(value, bool):
            safe[key] = value
        elif isinstance(value, int):
            safe[key] = value
        else:
            raise ConsentError("unsafe_evidence", "receipt facts may contain only integers and booleans")
    return safe


def _verify_knowledge_ingest(
    _admission: Admission,
    result: Any,
    context: Mapping[str, Any],
) -> VerificationResult:
    raw_ids = getattr(result, "ids", None)
    reported_chunks = getattr(result, "chunks", None)
    ids = list(raw_ids) if isinstance(raw_ids, (list, tuple)) else []
    valid_ids = [item for item in ids if isinstance(item, int) and not isinstance(item, bool) and item > 0]
    unique_ids = len(set(valid_ids))
    exists = context.get("chunk_exists")
    stored_chunks = 0
    check_error = False
    if callable(exists):
        try:
            stored_chunks = sum(1 for chunk_id in valid_ids if bool(exists(chunk_id)))
        except Exception:  # noqa: BLE001 — evidence records only that the check failed
            check_error = True
    else:
        check_error = True
    coherent = (
        isinstance(reported_chunks, int)
        and not isinstance(reported_chunks, bool)
        and reported_chunks > 0
        and len(ids) == len(valid_ids) == unique_ids == reported_chunks
    )
    passed = coherent and not check_error and stored_chunks == reported_chunks
    facts: dict[str, int | bool] = {
        "reported_chunks": reported_chunks if isinstance(reported_chunks, int) else 0,
        "stored_chunks": stored_chunks,
        "unique_ids": unique_ids,
    }
    if check_error:
        facts["check_error"] = True
    return VerificationResult(
        passed=passed,
        facts=facts,
        evidence={
            "reported_ids": valid_ids,
            "reported_chunks": reported_chunks,
            "stored_chunks": stored_chunks,
            "check_error": check_error,
        },
    )


def default_verification_registry(
    *,
    clock: Callable[[], datetime] | None = None,
) -> VerificationRegistry:
    registry = VerificationRegistry(clock=clock)
    registry.register("knowledge.ingest", "knowledge_chunks_exist", _verify_knowledge_ingest)
    return registry
