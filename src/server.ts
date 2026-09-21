import 'dotenv/config';
import { createDatabase } from './db/database.js';
import { createApp } from './app.js';

const db = createDatabase(process.env.DATABASE_URL ?? 'postgres://lab:lab@127.0.0.1:55432/payment_lab');
await db.sequelize.authenticate();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const server = createApp(db).listen(port, host, () => console.log(`Payment lab listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => { void db.sequelize.close(); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
