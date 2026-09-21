import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { Database } from './db/database.js';
import { AppError } from './errors.js';
import { accountId, accountInput, paymentInput, idempotencyKey } from './validation.js';
import { transfer } from './payments/transfer.js';

export function createApp(db: Database) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', async (_req, res) => {
    await db.sequelize.authenticate();
    res.json({ status: 'ok' });
  });
  app.post('/accounts', async (req, res) => {
    const input = accountInput.parse(req.body);
    const account = await db.Account.create({ id: randomUUID(), ...input });
    res.location(`/accounts/${account.id}`).status(201).json(account);
  });
  app.get('/accounts/:id', async (req, res) => {
    const account = await db.Account.findByPk(accountId.parse(req.params.id));
    if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    res.json(account);
  });
  app.post('/payments', async (req, res) => {
    const key = idempotencyKey.parse(req.get('Idempotency-Key'));
    const input = paymentInput.parse(req.body);
    const result = await transfer(db, input, key);
    res.set('Idempotency-Replayed', String(result.replayed));
    res.location(`/payments/${result.payment.id}`).status(result.replayed ? 200 : 201).json(result.payment);
  });
  app.get('/payments/:id', async (req, res) => {
    const payment = await db.Payment.findByPk(accountId.parse(req.params.id));
    if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    res.json(payment);
  });
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found.')));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Check request fields and Idempotency-Key.', details: error.issues } });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const failure = error as { type?: string; parent?: { code?: string } };
    if (failure.type === 'entity.parse.failed' || failure.type === 'entity.too.large') {
      res.status(failure.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid JSON or request too large.' } });
      return;
    }
    if (['55P03', '40P01', '40001', '57014'].includes(failure.parent?.code ?? '')) {
      res.set('Retry-After', '1').status(503).json({ error: { code: 'RETRYABLE_TRANSACTION', message: 'Retry with the same idempotency key and payload.' } });
      return;
    }
    console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  };
  app.use(errors);
  return app;
}
