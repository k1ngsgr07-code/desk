// Creates the tables (safe to run again) and stores the starting rate from .env.
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { pool } from './db';
import { computeRate } from './rates';

export async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8'));
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema_v2.sql'), 'utf8'));
  const r = computeRate(config.baseRateInr, config.spreadPercent);
  await pool.query(
    `INSERT INTO settings(key, value) VALUES ('base_rate_inr',$1), ('spread_percent',$2) ON CONFLICT DO NOTHING`,
    [r.base, r.spread],
  );
}

if (require.main === module) {
  migrate()
    .then(() => console.log('Schema is up to date.'))
    .catch((e) => {
      console.error('Migration failed:', e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
