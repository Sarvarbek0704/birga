import { PostgresDocStore } from "./postgres.js";
import { DocumentsRepo } from "./documents.js";
import { seed } from "./seed.js";

/**
 * Seed the demo dataset into Postgres. Requires DATABASE_URL; uses the same
 * SESSION_SECRET the server signs tokens with (so the printed demo tokens work).
 *
 *   DATABASE_URL=postgres://birga:birga@localhost:5432/birga \
 *   SESSION_SECRET=... pnpm --filter @birga/server seed
 */
async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("[seed] DATABASE_URL is required (start Postgres with `pnpm db:up`).");
    process.exit(1);
  }
  const secret = process.env["SESSION_SECRET"] ?? "dev-insecure-secret";

  const store = await PostgresDocStore.connect(databaseUrl);
  const repo = new DocumentsRepo(store.queryable);

  const result = await seed(store, repo, secret);
  await store.close();

  console.log(`\n[seed] ${result.documents} documents ready.\n`);
  console.log("Demo accounts (open the app and click one, or paste the token):");
  for (const a of result.accounts) {
    console.log(`  • ${a.name.padEnd(16)} — ${a.note}`);
  }
  console.log(
    "\nTip: run the server with DEMO_ACCOUNTS=1 to expose one-click demo login,\n" +
      "and ENFORCE_PERMISSIONS=1 to see viewers become read-only live.\n",
  );
}

void main();
