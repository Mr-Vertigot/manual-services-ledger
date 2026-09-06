import pg from "pg";
import { normalize } from "./logic.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function migrate() {
  await pool.query(`
    create table if not exists projects (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists kv (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    );
  `);
}

export async function listProjects() {
  const { rows } = await pool.query("select data from projects order by updated_at desc");
  return rows.map((r) => normalize(r.data));
}

export async function upsertProject(p) {
  await pool.query(
    `insert into projects (id, data) values ($1, $2)
     on conflict (id) do update set data = excluded.data, updated_at = now()`,
    [p.id, p]
  );
  return p;
}

export async function deleteProject(id) {
  await pool.query("delete from projects where id = $1", [id]);
}

export async function getKV(key, fallback = null) {
  const { rows } = await pool.query("select value from kv where key = $1", [key]);
  return rows[0]?.value ?? fallback;
}

export async function setKV(key, value) {
  await pool.query(
    `insert into kv (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value]
  );
  return value;
}
