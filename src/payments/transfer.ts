import { randomUUID } from 'node:crypto';
import { Transaction, UniqueConstraintError } from 'sequelize';
import type { Database } from '../db/database.js';
import { AppError } from '../errors.js';
import { MAX_MONEY, type PaymentInput } from '../validation.js';

type Payment = InstanceType<Database['Payment']>;
function replay(payment: Payment, input: PaymentInput) {
  if (payment.senderId !== input.senderId || payment.receiverId !== input.receiverId || payment.amount !== input.amount) {
    throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different payment request.');
  }
  return { payment, replayed: true };
}

export async function transfer(db: Database, input: PaymentInput, key: string) {
  try {
    return await db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async transaction => {
      await db.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
      const existing = await db.Payment.findOne({ where: { idempotencyKey: key }, transaction });
      if (existing) return replay(existing, input);

      // Two sequential SELECT ... FOR UPDATE statements; never Promise.all here.
      // Every transfer acquires the same pair of locks in the same order.
      const accounts = new Map<string, InstanceType<Database['Account']>>();
      for (const id of [input.senderId, input.receiverId].sort()) {
        const account = await db.Account.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'An account does not exist.');
        accounts.set(id, account);
      }

      // A duplicate may have committed while we waited for the account locks.
      // Recheck before checking funds, even if the first payment exhausted them.
      const committed = await db.Payment.findOne({ where: { idempotencyKey: key }, transaction });
      if (committed) return replay(committed, input);
      const sender = accounts.get(input.senderId)!;
      const receiver = accounts.get(input.receiverId)!;
      if (sender.balance < input.amount) {
        throw new AppError(422, 'INSUFFICIENT_FUNDS', 'The sender has insufficient funds.');
      }
      if (receiver.balance > MAX_MONEY - input.amount) {
        throw new AppError(422, 'BALANCE_LIMIT', 'The receiver balance would exceed the demo limit.');
      }
      await sender.update({ balance: sender.balance - input.amount }, { transaction });
      await receiver.update({ balance: receiver.balance + input.amount }, { transaction });
      const payment = await db.Payment.create({
        id: randomUUID(), ...input, idempotencyKey: key, status: 'COMPLETED',
      }, { transaction });
      // Future outbox insertion belongs here, in this same transaction.
      return { payment, replayed: false };
    });
  } catch (error) {
    // Disjoint account pairs can race on the same key. PostgreSQL uniqueness
    // chooses the winner; this transaction has already rolled back both balances.
    if (error instanceof UniqueConstraintError &&
        (error.parent as Error & { constraint?: string }).constraint === 'payments_idempotency_key_unique') {
      const winner = await db.Payment.findOne({ where: { idempotencyKey: key } });
      if (winner) return replay(winner, input);
    }
    throw error;
  }
}
