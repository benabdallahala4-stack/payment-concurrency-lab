import { z } from 'zod';

export const MAX_MONEY = 2147483647;
export const accountId = z.uuid().transform(value => value.toLowerCase());
export const accountInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  balance: z.number().int().min(0).max(MAX_MONEY).default(0),
});
export const paymentInput = z.strictObject({
  senderId: accountId,
  receiverId: accountId,
  amount: z.number().int().positive().max(MAX_MONEY),
}).refine(value => value.senderId !== value.receiverId, { message: 'Accounts must differ' });
export const idempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export type PaymentInput = z.infer<typeof paymentInput>;
