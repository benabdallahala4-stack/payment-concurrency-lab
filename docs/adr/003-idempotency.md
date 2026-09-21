# ADR 003: Database-backed payment idempotency

**Status:** Accepted

**Date:** 2026-09-21

## Context

Clients may retry because of duplicate submissions, timeouts, or a response lost after commit. Application-level existence checks can race across concurrent requests and application instances.

## Decision

Require `Idempotency-Key` on each payment and enforce a named PostgreSQL UNIQUE constraint on `payments.idempotency_key`. A stored payment contains the canonical sender, receiver, and amount, so matching can compare all three directly without hashing.

Check for an existing payment before acquiring account locks, then check again after acquiring them. The second check handles a duplicate that committed while this request was waiting; it must precede the funds check because the original payment may have spent all available funds.

Insert the payment in the same transaction as both balance updates. Requests using a key across disjoint account pairs can race despite row locking. Catch only the named idempotency uniqueness violation after Sequelize rolls back, then read the winner outside the aborted transaction. Return `200` for an identical request or `409` for a changed payload. The original returns `201`.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Unique payment key — chosen | Atomic with balances, minimal schema | Caches successful payments only |
| Dedicated request table | Can store in-progress and failed outcomes | More lifecycle states and recovery rules |
| Redis key/lock | Fast shared lookup | Separate consistency and durability boundary |
| Lookup without uniqueness | Minimal code | Duplicate requests can both commit |

## Consequences

Keys are globally scoped in this single-tenant demo and retained with payment records indefinitely. Add authenticated tenant scoping before multi-tenant use. Failed requests roll back and do not claim a key; the same key can later be evaluated against new state or another valid request. This intentionally differs from APIs that retain and replay every error.

Clients must keep the same key and payload after an uncertain response. A key represents a logical payment, not an individual HTTP attempt. HTTP status may change from `201` to `200` on replay while the payment record remains identical. There is no claim of exactly-once network delivery.
