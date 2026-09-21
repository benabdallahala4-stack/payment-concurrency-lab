import { QueryTypes } from 'sequelize';
import type { Database } from './database.js';

// Explicit, versioned DDL keeps database constraints visible to learners.
export async function migrate(db: Database) {
  await db.sequelize.transaction(async transaction => {
    // Serializes concurrent migration runners, not payment requests.
    await db.sequelize.query('SELECT pg_advisory_xact_lock(714209)', { transaction });
    await db.sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`, { transaction });
    const applied = await db.sequelize.query('SELECT version FROM schema_migrations WHERE version = 1',
      { transaction, type: QueryTypes.SELECT });
    if (applied.length) return;
    await db.sequelize.query(`
      CREATE TABLE accounts (
        id uuid PRIMARY KEY,
        name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
        balance integer NOT NULL CONSTRAINT accounts_balance_nonnegative CHECK (balance >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE payments (
        id uuid PRIMARY KEY,
        sender_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        receiver_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        amount integer NOT NULL CONSTRAINT payments_amount_positive CHECK (amount > 0),
        idempotency_key varchar(128) NOT NULL
          CONSTRAINT payments_idempotency_key_unique UNIQUE
          CONSTRAINT payments_key_nonempty CHECK (length(trim(idempotency_key)) > 0),
        status varchar(16) NOT NULL CHECK (status = 'COMPLETED'),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payments_distinct_accounts CHECK (sender_id <> receiver_id)
      );
      INSERT INTO schema_migrations(version) VALUES (1);
    `, { transaction });
  });
}
