# Operation consent and verification core

Status: neutral core plus one bounded HTTP-mode `safe-operator` adapter.

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
- Capability tokens are generated directly with `secrets.token_urlsafe`; callers
  cannot substitute a token generator. They are returned once with hidden
  representation, retained only as hashes, and collision retries are bounded.
- Plans and grants expire in at most 15 minutes. Grants are in-memory and per-run;
  process restart revokes all of them.
- A located grant is consumed before any caller-controlled plan, input, or state
  validation. Missing, expired, replayed, mismatched, malformed, or stale approval
  attempts fail with stable `ConsentError.code` values and cannot preserve that
  grant for a second attempt.
- Verification revalidates operation/risk against the live registry and requires
  safe target, approver, verifier, and SHA-256 digest metadata before constructing
  a receipt. Receipt facts may contain only integer and Boolean values, are
  immutable after construction, and private verifier evidence leaves only a
  digest.
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

## First adapter: HTTP-mode safe knowledge ingest

`server/operator_consent.py` is the first execution adapter. It is active only
when the operator MCP runs with `--http` and the configured profile is
`safe-operator`. The profile exposes exactly one managed MCP tool,
`knowledge_ingest`, and ignores `operator_mcp.tools` so an explicit legacy tool
cannot bypass the consent wrapper.

The first tool call with a URL or local path creates an expiring exact-input plan
and returns its digest without executing. A human then POSTs that digest and a
safe approver identifier to `/consent/knowledge-ingest/approve` using the
instance's configured operator bearer. The bearer-gated route and MCP tool live
in the same process and share one in-memory authority; raw capability tokens
never cross either interface. Repeating the MCP call with the unchanged inputs
and approved plan digest atomically consumes the grant, runs
`ops.knowledge.ingest`, and verifies that every reported chunk exists.

If verification fails, the adapter attempts deletion of every valid reported
chunk ID and checks the post-rollback absence. The result distinguishes complete
rollback from `rollback_incomplete`; both responses contain only safe receipt
metadata and counts/digests, never source values or grant tokens.

HTTP mode requires a non-empty `auth.token`; blank-auth instances fail closed.
Stdio mode remains zero-tool for `safe-operator` because it has no independent
human approval channel.

## Explicit remaining non-capabilities

This slice does not complete the full `safe-operator` roadmap. It adds no stdio
approval side channel, generic operation invocation, persistent consent, config
write, plugin install, fleet control, or approval route for any operation other
than `knowledge.ingest`. URLs and local files are the only admitted ingest source
shapes. Further operations require their own adapter, rollback, tests, and review.
