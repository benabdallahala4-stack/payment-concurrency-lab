# ADR 002: READ COMMITTED with deterministic account locks

**Status:** Accepted

**Date:** 2026-09-21

## Context

Concurrent read-modify-write transfers can overspend or lose updates even when each request uses a transaction. Opposite-direction transfers can also deadlock if each locks its sender first.

## Decision

Use one managed Sequelize transaction at explicit READ COMMITTED isolation. Canonicalize account UUIDs to lowercase, sort both IDs, and acquire each row lock sequentially with `SELECT ... FOR UPDATE`. Read funds only after both locks are held. Debit, credit, and insert the completed payment in that transaction. Pass the transaction explicitly to every query.

The service waits for commit before returning HTTP success. Errors roll back the entire transaction. Configure a five-second lock timeout and ten-second statement timeout. Surface recognized transient transaction failures as `503` with a retry hint; clients reuse the same idempotency key.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Ordered row locks — chosen | Visible, easy-to-explain protection for both balances | Hot accounts serialize requests |
| Serializable isolation | Detects a broader class of anomalies | Must explain and implement serialization retries |
| Optimistic version checks | Useful with low contention | Retry loops and conflict handling obscure the initial lesson |
| Conditional atomic updates | Efficient funds check in SQL | Still needs coordinated credit, idempotency, and lock order |
| In-process mutex | Simple within one process | Does not coordinate multiple application instances |

## Consequences

Independent account pairs can proceed concurrently, while transfers touching the same account serialize. All future balance-mutating paths must respect the same ordering. No network calls belong inside this transaction. A database balance constraint alone would not prevent stale positive writes.

Integration tests verify overspending, accumulated credits, opposite-direction requests, rollback after a forced insertion failure, and an actual blocked PostgreSQL row lock. They demonstrate the tested scenarios, not a formal proof for every possible future workflow.

See [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) and [Sequelize transactions](https://sequelize.org/docs/v6/other-topics/transactions/).
