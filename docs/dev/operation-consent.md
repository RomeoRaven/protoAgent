# Operation consent and verification core

Status: RR foundation only; no operator-MCP or HTTP execution adapter is enabled.

Owner module: `ops/consent.py`

This module is the neutral admission seam for issue #3. It does not invoke an
operation and does not expose an approval surface. Future human-facing and
execution adapters must use this sequence rather than implementing their own
consent checks:

1. Build an `OperationPlan` from the canonical registered `OpSpec`.
2. Bind the plan to one target identifier, exact inputs, target-state/version
   fingerprint, expected effect, and expiration.
3. Obtain a `ConsentGrant` from a human-only adapter.
4. Atomically consume its capability token with the unchanged plan, inputs, and
   current target state. A token is single-use even when a mismatch is attempted.
5. Invoke the admitted operation.
6. Run its registered operation-specific postcondition verifier.
7. Return the resulting secret-free `ExecutionReceipt`; treat
   `VerificationFailed.receipt` as a failed operation requiring operation-owned
   recovery or rollback.

## Safety properties

- Default policy admits only `reversible` operations. Current `read`,
  `disruptive`, and `destructive` operations cannot be planned by that authority.
- Operation name and risk are revalidated against the live operation registry
  when planning, approving, and consuming a plan. Caller-constructed risk
  downgrades fail closed.
- Inputs and target state are canonicalized and SHA-256 bound. Raw values are not
  retained in plans, grants, admissions, or receipts.
- Capability tokens use `secrets.token_urlsafe`, are returned once with hidden
  representation, and are retained only as hashes.
- Plans and grants expire in at most 15 minutes. Grants are in-memory and per-run;
  process restart revokes all of them.
- Missing, expired, replayed, mismatched, or stale approval attempts fail with
  stable `ConsentError.code` values and revoke any matching unused grant.
- Receipt identifiers use a conservative identifier grammar. Receipt facts may
  contain only integer and Boolean values; private verifier evidence leaves only
  a digest.
- There is no generic caller-supplied `verified=True` path. An operation must have
  a registered verifier.

## First operation-specific verifier

`knowledge.ingest` is the only default verifier. It requires:

- a positive, coherent, unique set of returned chunk IDs;
- a reported chunk count matching those IDs; and
- a caller-owned `chunk_exists(id)` lookup confirming every returned ID is
  present in the target store.

Missing lookup support, a lookup error, an absent ID, or incoherent result data
raises `VerificationFailed` with a secret-free failed receipt.

## Explicit non-capabilities

This foundation does not complete `safe-operator`. It adds no MCP tool, REST
route, CLI approval command, global authority, persistent consent, operation
invocation, automatic rollback, config write, plugin install, fleet control, or
upstream publication. A future adapter must keep human grant issuance separate
from model-visible execution and must own rollback for its admitted operation.
