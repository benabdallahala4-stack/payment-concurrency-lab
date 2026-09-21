# Payment Concurrency Lab

A small backend project for learning how concurrent payment requests interact with PostgreSQL transactions, row locks, and idempotency. Built with Node.js, TypeScript, Express, Sequelize, and PostgreSQL.

The central exercise: an account has **100,000 cents** and receives **20 simultaneous requests for 10,000 cents**. Exactly ten transfers succeed. The sender ends at zero, the receiver gets 100,000 cents, and exactly ten payment records exist.

This is a **local learning demo**. Account creation accepts an opening balance; there is no authentication, account ownership, external payment provider, currency conversion, or accounting ledger. Do not expose it as a real money service.

## Quick start

Prerequisites: Node.js 22.12 or newer and Docker with Compose.

```sh
npm ci
docker compose up -d --wait
npm run db:migrate
npm run dev
```

The API listens at `http://127.0.0.1:3000`. Defaults work without an `.env` file. To customize them, copy `.env.example` to `.env` (`cp` on Unix, `Copy-Item` in PowerShell).

| Setting | Default |
| --- | --- |
| `DATABASE_URL` | `postgres://lab:lab@127.0.0.1:55432/payment_lab` |
| `TEST_DATABASE_URL` | `postgres://lab:lab@127.0.0.1:5434/payment_lab_test` |
| `HOST` / `PORT` | `127.0.0.1` / `3000` |

Database credentials are intentionally local demo values. Both PostgreSQL ports bind to loopback. If a port is occupied, change its Compose mapping and the corresponding URL together. Development data uses a named volume; test data is disposable. `docker compose --profile test down` stops both databases and retains the development volume. Adding `--volumes` also deletes that volume and its data.

For compiled execution:

```sh
npm run build
npm start
```

Migrations are explicit and recorded in `schema_migrations`; startup never calls `sync({ force: true })`. Run `npm run db:migrate` before starting a fresh database. Running it again is safe.

## Architecture

```mermaid
flowchart LR
    Client[HTTP client] --> API["Express API<br/>Validation and HTTP errors"]
    API --> Transfer["Payment service<br/>Transaction boundary"]
    API --> Models["Sequelize models<br/>Account and Payment reads"]
    Transfer --> PG[(PostgreSQL)]
    Models --> PG
    Tests["Integration tests<br/>Concurrent HTTP requests"] --> API
```

```mermaid
erDiagram
    ACCOUNT ||--o{ PAYMENT : sends
    ACCOUNT ||--o{ PAYMENT : receives
    ACCOUNT {
        uuid id PK
        varchar name
        integer balance
        timestamptz created_at
        timestamptz updated_at
    }
    PAYMENT {
        uuid id PK
        uuid sender_id FK
        uuid receiver_id FK
        integer amount
        varchar idempotency_key UK
        varchar status
        timestamptz created_at
    }
```

Money is represented as integer minor units in a single implicit currency: `100` means 100 cents. Amounts and balances are capped at **2,147,483,647** (PostgreSQL `INTEGER`); there are no floating-point currency calculations. Failed transfers are rolled back, so stored payments have only `COMPLETED` status. This is deliberately not a durable failed-attempt audit log.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Database connectivity check |
| `POST` | `/accounts` | Create `{ "name": "Alice", "balance": 100000 }`; balance defaults to zero |
| `GET` | `/accounts/:id` | Fetch account and current balance |
| `POST` | `/payments` | Transfer `{ "senderId": "...", "receiverId": "...", "amount": 10000 }` |
| `GET` | `/payments/:id` | Fetch a committed payment |

Every payment requires an `Idempotency-Key` header: 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`. UUIDs work well. IDs are UUIDs and normalized to lowercase. Unknown body fields, self-transfers, fractional or non-positive amounts, and missing keys return `400`.

Example using PowerShell:

```powershell
$api = 'http://127.0.0.1:3000'
$alice = Invoke-RestMethod "$api/accounts" -Method Post -ContentType 'application/json' -Body '{"name":"Alice","balance":100000}'
$bob = Invoke-RestMethod "$api/accounts" -Method Post -ContentType 'application/json' -Body '{"name":"Bob","balance":0}'
$body = @{ senderId = $alice.id; receiverId = $bob.id; amount = 10000 } | ConvertTo-Json
Invoke-RestMethod "$api/payments" -Method Post -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = 'demo-payment-1' } -Body $body
# Repeat the last command: the same payment is returned, with no second debit.
```

Equivalent payment request with curl (replace IDs returned by account creation):

```sh
curl -i http://127.0.0.1:3000/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-payment-1' \
  -d '{"senderId":"<alice-id>","receiverId":"<bob-id>","amount":10000}'
```

New payments return `201`; replays return `200` with the identical payment record and `Idempotency-Replayed: true`. Both include a `Location` header. Reusing a committed key with a different sender, receiver, or amount returns `409 IDEMPOTENCY_CONFLICT`.

## Transaction and lock order

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Payment service
    participant DB as PostgreSQL
    C->>API: POST /payments + Idempotency-Key
    API->>DB: BEGIN at READ COMMITTED
    API->>DB: Look up committed payment by key
    alt Existing matching payment
        API->>DB: COMMIT read-only transaction
        API-->>C: 200 existing payment
    else New request
        API->>DB: SELECT lower UUID FOR UPDATE
        API->>DB: SELECT higher UUID FOR UPDATE
        API->>DB: Recheck key after waiting for locks
        Note over API,DB: If a duplicate committed, replay before checking funds
        API->>API: Check funds and receiver balance limit
        API->>DB: UPDATE sender balance
        API->>DB: UPDATE receiver balance
        API->>DB: INSERT payment with unique key
        API->>DB: COMMIT
        API-->>C: 201 committed payment
    end
    Note over API,DB: Any error rolls back the complete transaction
```

The code performs **two sequential `SELECT ... FOR UPDATE` queries**, sorting canonical UUIDs first. Alice→Bob and Bob→Alice therefore acquire the same account locks in the same order. Locks last until transaction completion. All reads and writes explicitly receive the same Sequelize transaction.

Transactions alone are insufficient: two ordinary reads can both observe the same balance. A non-negative database constraint alone is also insufficient: two stale writes might both set the balance to the same positive value while both payments are recorded. Row locking makes the second transfer wait and read the committed balance before deciding whether to spend.

The idempotency key has a **database UNIQUE constraint**, not just an application lookup. Concurrent requests using the same key on disjoint account pairs can still race. The losing transaction rolls back both balance updates; the service then reads the winner outside that failed transaction and returns a replay or conflict. Successful keys are retained indefinitely in this demo. Failed requests do not reserve a key; a later retry is evaluated again.

## Failure scenarios

| Scenario | Result |
| --- | --- |
| Sender lacks funds | `422 INSUFFICIENT_FUNDS`; no balance changes or payment |
| Receiver would exceed the integer limit | `422 BALANCE_LIMIT`; full rollback |
| Missing account/payment | `404` |
| Database failure between debit, credit, and payment insertion | Full transaction rollback; generic `500` |
| Client loses response after commit | Retry the same key and payload; committed payment is returned |
| Duplicate key with changed payload | `409`; no extra transfer |
| Lock timeout, deadlock, serialization failure, or statement timeout | `503 RETRYABLE_TRANSACTION`; `Retry-After: 1` |
| Process exits before commit | PostgreSQL rolls back the abandoned transaction |

Locks time out after five seconds; individual statements after ten seconds. No automatic transaction retry loop hides behavior from the learner. On a transient error or uncertain network outcome, retry with backoff using the **same key and payload**. Deterministic order prevents the two-account lock cycle in this service; future workflows must preserve the ordering and may introduce other deadlock sources.

## Run the tests

```sh
docker compose --profile test up -d --wait
npm run check
```

`check` runs TypeScript validation, compilation, and the real PostgreSQL integration suite. Tests send HTTP requests through the actual Express routes, use multiple database connections, and assert persisted balances and payment counts. There is no SQLite substitute or database mock.

The test suite **truncates `accounts` and `payments`** in `TEST_DATABASE_URL`. It refuses database names that do not end in `_test`. Only point it at a disposable test database. The database must already exist; the test setup applies the real migrations.

Tests cover concurrent overdraft attempts, lost-credit updates, opposing transfers, duplicate replays after funds are exhausted, conflicting keys, database constraints, integer overflow, validation, and missing resources. One test holds a real row lock and observes a blocked `FOR UPDATE` query via `pg_stat_activity`; another installs a temporary failing database trigger to prove rollback after balance updates. The GitHub Actions workflow runs the same checks with PostgreSQL 17.

## Next: transactional outbox and Kafka

The first version intentionally runs only PostgreSQL. When adding asynchronous events, insert an outbox row at the marked location in `src/payments/transfer.ts`, using the **same transaction** as the balances and payment. A separate publisher and consumer can then be added without changing the HTTP contract.

```mermaid
flowchart LR
    API[Payment transaction] --> DB[(Accounts + Payments + Outbox)]
    DB --> Publisher[Outbox publisher]
    Publisher --> Kafka[Kafka topic]
    Kafka --> Consumer[Idempotent consumer]
    Consumer --> Notification[Simulated notification]
```

This diagram is the **future design**, not implemented infrastructure. Publishing directly after commit leaves a crash window where the payment exists but its event is lost. An outbox closes that gap, but publishing and marking a row sent are still not atomic: delivery is at least once. Use stable event IDs and consumer deduplication. Add Kafka to Compose when implementing that workflow, together with publish/replay/crash tests.

## Project map and decisions

```text
src/app.ts                  HTTP routes and error mapping
src/validation.ts           Request contracts and money limits
src/payments/transfer.ts    Transaction, row locks, idempotency
src/db/database.ts          Sequelize connection and models
src/db/schema.ts            Versioned transactional schema migration
src/db/migrate.ts           Migration command
src/server.ts               Startup and shutdown
test/                       HTTP and PostgreSQL integration tests
docs/adr/                   Architecture decision records
```

- [ADR 001: PostgreSQL, Sequelize, and integer money](docs/adr/001-storage-and-money.md)
- [ADR 002: Transactions and deterministic row locking](docs/adr/002-transaction-and-locking.md)
- [ADR 003: Database-backed idempotency](docs/adr/003-idempotency.md)
- [ADR 004: Defer outbox and Kafka](docs/adr/004-defer-messaging.md)

Dependency versions are pinned in `package-lock.json`. Sequelize's transitive `uuid` dependency is overridden to `11.1.1` to address its older dependency's buffer-bounds advisory; the application generates IDs with Node's `crypto.randomUUID()`. Reassess the override when upgrading Sequelize and rerun the PostgreSQL suite.

References: [PostgreSQL row locks and deadlocks](https://www.postgresql.org/docs/17/explicit-locking.html), [Sequelize managed transactions and locks](https://sequelize.org/docs/v6/other-topics/transactions/), and [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
