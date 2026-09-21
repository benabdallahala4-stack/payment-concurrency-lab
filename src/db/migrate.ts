import 'dotenv/config';
import { createDatabase } from './database.js';
import { migrate } from './schema.js';

const db = createDatabase(process.env.DATABASE_URL ?? 'postgres://lab:lab@127.0.0.1:55432/payment_lab');
try {
  await migrate(db);
  console.log('Database migrations applied.');
} finally {
  await db.sequelize.close();
}
