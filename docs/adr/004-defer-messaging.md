# ADR 004: Defer transactional outbox and Kafka

**Status:** Accepted

**Date:** 2026-09-21

## Context

The first milestone teaches atomic transfers, locking, and idempotency. Adding a broker now would introduce operational and distributed delivery concerns before the local transaction is understood.

## Decision

Run only PostgreSQL in the initial Compose setup. Keep the payment transaction in a dedicated service with an explicit point for a future outbox insertion. Document the next architecture, but do not add unused Kafka services, empty consumer abstractions, or pretend event delivery is implemented.

The next milestone should atomically insert an outbox event alongside the payment. A publisher sends stable event IDs to Kafka; a consumer deduplicates those IDs before applying its side effect.

## Options considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Defer messaging — chosen | Focused first lesson and small local setup | No notifications yet |
| Publish directly after commit | Very little code | Crash between commit and publish loses events |
| Implement outbox and Kafka now | Demonstrates durable asynchronous integration | Larger scope and more failure modes |

## Consequences

The current payment API has no event-delivery guarantee because it emits no events. Future outbox work requires a migration, publisher ownership/claiming strategy, Kafka Compose configuration, a consumer, retry behavior, and crash-recovery tests.

A publisher can crash after Kafka accepts a message but before the outbox is marked sent. Expect at-least-once publication and duplicate deliveries. Consumer deduplication must be atomic with its local effect; external notifications may need their own idempotency mechanism. Avoid holding account locks while publishing.
