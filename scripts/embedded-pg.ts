// Runs a real Postgres from node_modules (no Docker or system install needed).
// Use this OR `npm run db:up` (Docker), not both. Data lives in ./.pgdata. Ctrl+C stops it.
// TEST BUILD ONLY.
import fs from 'fs';
import path from 'path';
import EmbeddedPostgres from 'embedded-postgres';
import '../src/config';

async function main() {
  const url = new URL(process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/desk');
  const dataDir = path.join(__dirname, '..', '.pgdata');
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    port: Number(url.port || 5432),
    persistent: true,
  });

  if (fresh) await pg.initialise();
  await pg.start();
  const dbName = url.pathname.slice(1);
  if (fresh) await pg.createDatabase(dbName);
  console.log(`\nPostgres is running on port ${url.port || 5432} (database "${dbName}"). Leave this window open. Ctrl+C to stop.`);

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('Could not start embedded Postgres:', e);
  process.exit(1);
});
