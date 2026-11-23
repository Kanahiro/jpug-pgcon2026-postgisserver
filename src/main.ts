import pg from 'pg';
import { createServer } from './app.ts';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/gis',
});
const port = Number(process.env.PORT ?? 3000);

createServer(pool).listen(port, () => console.log(`http://localhost:${port}`));
