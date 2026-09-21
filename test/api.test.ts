import request from 'supertest';
import { afterAll, expect, test } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/database.js';

const db = createDatabase('postgres://unused:unused@127.0.0.1:1/unused');
afterAll(async () => { await db.sequelize.close(); });

test('rejects a payment without an idempotency key before accessing the database', async () => {
  const response = await request(createApp(db)).post('/payments').send({});
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_INPUT');
});

test.each(['', ' ', 'x'.repeat(129), 'has spaces'])('rejects invalid key %s before accessing the database', async key => {
  const response = await request(createApp(db)).post('/payments').set('Idempotency-Key', key).send({});
  expect(response.status).toBe(400);
});

test.each([{ name: '' }, { name: 'A', balance: -1 }, { name: 'A', balance: 1.5 }, { name: 'A', balance: 2147483648 }, { name: 'A', admin: true }])('rejects invalid account data %j', async body => {
  expect((await request(createApp(db)).post('/accounts').send(body)).status).toBe(400);
});

test('malformed JSON returns a structured 400', async () => {
  const response = await request(createApp(db)).post('/accounts').set('Content-Type', 'application/json').send('{');
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_INPUT');
});

test('oversized requests return 413', async () => {
  const response = await request(createApp(db)).post('/accounts').send({ name: 'a'.repeat(17000) });
  expect(response.status).toBe(413);
});
