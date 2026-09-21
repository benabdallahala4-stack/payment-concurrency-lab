import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { QueryTypes } from 'sequelize';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://lab:lab@127.0.0.1:5434/payment_lab_test';
if (!new URL(url).pathname.endsWith('_test')) {
  throw new Error('TEST_DATABASE_URL must name a disposable database ending in _test');
}
const db = createDatabase(url);
const app = createApp(db);
const send = (senderId: string, receiverId: string, amount: number, key = randomUUID()) =>
  request(app).post('/payments').set('Idempotency-Key', key).send({ senderId, receiverId, amount });
async function account(balance: number, name = 'Demo') {
  const response = await request(app).post('/accounts').send({ name, balance });
  expect(response.status).toBe(201);
  return response.body.id as string;
}
async function balance(id: string) {
  const response = await request(app).get(`/accounts/${id}`);
  expect(response.status).toBe(200);
  return response.body.balance as number;
}
beforeAll(async () => { await migrate(db); });
beforeEach(async () => { await db.sequelize.query('TRUNCATE payments, accounts'); });
afterAll(async () => { await db.sequelize.close(); });

describe('payments against real PostgreSQL', () => {
  test('health checks connectivity and migration reruns preserve account data', async () => {
    const id = await account(123);
    await migrate(db);
    expect(await balance(id)).toBe(123);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  test('lock timeout rolls back and the same request can be retried', async () => {
    const a = await account(100), b = await account(0), key = randomUUID();
    const blocker = await db.sequelize.transaction();
    try {
      await db.Account.findByPk(a, { transaction: blocker, lock: blocker.LOCK.UPDATE });
      const response = await send(a, b, 100, key);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('RETRYABLE_TRANSACTION');
      expect(response.headers['retry-after']).toBe('1');
      expect(await balance(a)).toBe(100);
      expect(await balance(b)).toBe(0);
      expect(await db.Payment.count()).toBe(0);
    } finally {
      await blocker.rollback();
    }
    expect((await send(a, b, 100, key)).status).toBe(201);
  });

  test('commits both balances and a retrievable completed payment', async () => {
    const a = await account(1000), b = await account(0);
    const response = await send(a, b, 300);
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('COMPLETED');
    expect(await balance(a)).toBe(700);
    expect(await balance(b)).toBe(300);
    const lookup = await request(app).get(`/payments/${response.body.id}`);
    expect(lookup.body).toEqual(response.body);
  });

  test('20 concurrent debits cannot spend more than the available balance', async () => {
    const a = await account(100000), b = await account(0);
    const responses = await Promise.all(Array.from({ length: 20 }, () => send(a, b, 10000)));
    expect(responses.filter(r => r.status === 201)).toHaveLength(10);
    expect(responses.filter(r => r.status === 422 && r.body.error.code === 'INSUFFICIENT_FUNDS')).toHaveLength(10);
    expect(await balance(a)).toBe(0);
    expect(await balance(b)).toBe(100000);
    expect(await db.Payment.count()).toBe(10);
  });

  test('concurrent credits from independent senders do not lose updates', async () => {
    const receiver = await account(0);
    const senders = await Promise.all(Array.from({ length: 20 }, () => account(100)));
    const responses = await Promise.all(senders.map(id => send(id, receiver, 100)));
    expect(responses.every(r => r.status === 201)).toBe(true);
    expect(await balance(receiver)).toBe(2000);
    expect(await Promise.all(senders.map(balance))).toEqual(Array(20).fill(0));
    expect(await db.Payment.count()).toBe(20);
  });

  test('opposite-direction transfers preserve balances without a lock-order deadlock', async () => {
    const a = await account(10000), b = await account(10000);
    const responses = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? send(a, b, 100) : send(b, a, 100)));
    expect(responses.every(r => r.status === 201)).toBe(true);
    expect(await balance(a)).toBe(10000);
    expect(await balance(b)).toBe(10000);
    expect(await db.Payment.count()).toBe(40);
  });

  test('concurrent duplicate requests debit once even when the first consumes all funds', async () => {
    const a = await account(100), b = await account(0), key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () => send(a, b, 100, key)));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(responses.filter(r => r.status === 200)).toHaveLength(19);
    expect(new Set(responses.map(r => r.body.id)).size).toBe(1);
    expect(await balance(a)).toBe(0);
    expect(await balance(b)).toBe(100);
    expect(await db.Payment.count()).toBe(1);
  });

  test('a reused key with a different payload returns conflict without moving money', async () => {
    const a = await account(500), b = await account(0), key = randomUUID();
    expect((await send(a, b, 100, key)).status).toBe(201);
    const conflict = await send(a, b, 200, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balance(a)).toBe(400);
    expect(await balance(b)).toBe(100);
  });

  test('same key on disjoint account pairs is arbitrated by database uniqueness', async () => {
    const a = await account(500), b = await account(0);
    const c = await account(500), d = await account(0), key = randomUUID();
    const responses = await Promise.all([send(a, b, 100, key), send(c, d, 100, key)]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await balance(a) + await balance(c)).toBe(900);
    expect(await balance(b) + await balance(d)).toBe(100);
    expect(await db.Payment.count()).toBe(1);
  });

  test('failed requests roll back and do not consume the idempotency key', async () => {
    const a = await account(100), b = await account(0), key = randomUUID();
    expect((await send(a, b, 200, key)).status).toBe(422);
    expect(await db.Payment.count()).toBe(0);
    expect(await balance(a)).toBe(100);
    expect(await balance(b)).toBe(0);
    expect((await send(a, b, 100, key)).status).toBe(201);
  });

  test('receiver overflow rolls back the entire payment', async () => {
    const a = await account(100), b = await account(2147483647);
    expect((await send(a, b, 1)).status).toBe(422);
    expect(await balance(a)).toBe(100);
    expect(await balance(b)).toBe(2147483647);
    expect(await db.Payment.count()).toBe(0);
  });

  test('database failure at payment insertion rolls back earlier debit and credit', async () => {
    const a = await account(100), b = await account(0);
    await db.sequelize.query(`CREATE FUNCTION reject_lab_payment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional test failure'; END $$;
      CREATE TRIGGER reject_lab_payment BEFORE INSERT ON payments
      FOR EACH ROW EXECUTE FUNCTION reject_lab_payment();`);
    try {
      expect((await send(a, b, 50)).status).toBe(500);
      expect(await balance(a)).toBe(100);
      expect(await balance(b)).toBe(0);
      expect(await db.Payment.count()).toBe(0);
    } finally {
      await db.sequelize.query('DROP TRIGGER reject_lab_payment ON payments; DROP FUNCTION reject_lab_payment()');
    }
  });

  test('a payment waits for an actual PostgreSQL row lock before reading the balance', async () => {
    const a = await account(100), b = await account(0);
    const blocker = await db.sequelize.transaction();
    let released = false;
    let pending: Promise<request.Response> | undefined;
    try {
      await db.Account.findByPk(a, { transaction: blocker, lock: blocker.LOCK.UPDATE });
      pending = send(a, b, 100).then(r => r);
      await expect.poll(async () => {
        const rows = await db.sequelize.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`,
          { type: QueryTypes.SELECT });
        return Number(rows[0]?.count);
      }, { timeout: 5000 }).toBeGreaterThan(0);
      await blocker.commit();
      released = true;
      expect((await pending).status).toBe(201);
      expect(await balance(a)).toBe(0);
    } finally {
      if (!released) await blocker.rollback();
      await pending;
    }
  });

  test('database constraints reject invalid money and duplicate keys even outside the API', async () => {
    const a = await account(100), b = await account(0), key = randomUUID();
    await expect(db.sequelize.query('UPDATE accounts SET balance = -1 WHERE id = :id', { replacements: { id: a } })).rejects.toThrow();
    const successful = await send(a, b, 10, key);
    await expect(db.Payment.create({ id: randomUUID(), senderId: a, receiverId: b, amount: 10, idempotencyKey: key, status: 'COMPLETED' })).rejects.toThrow();
    expect(successful.status).toBe(201);
    expect(await db.Payment.count()).toBe(1);
  });

  test('missing accounts and payments return 404 without debiting', async () => {
    const a = await account(100);
    expect((await send(a, randomUUID(), 10)).status).toBe(404);
    expect((await request(app).get(`/payments/${randomUUID()}`)).status).toBe(404);
    expect((await request(app).get(`/accounts/${randomUUID()}`)).status).toBe(404);
    expect(await balance(a)).toBe(100);
  });

  test.each([0, -1, 1.5, 2147483648, '100', null])('rejects invalid amount %s', async amount => {
    const a = await account(100), b = await account(0);
    const response = await request(app).post('/payments').set('Idempotency-Key', randomUUID()).send({ senderId: a, receiverId: b, amount });
    expect(response.status).toBe(400);
    expect(await db.Payment.count()).toBe(0);
  });

  test('normalizes UUID casing before self-payment validation and replay comparison', async () => {
    const a = await account(100), b = await account(0), key = randomUUID();
    expect((await send(a, a.toUpperCase(), 10)).status).toBe(400);
    const created = await send(a, b, 10, key);
    const replay = await send(a.toUpperCase(), b.toUpperCase(), 10, key);
    expect(created.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(created.body.id);
  });
});
