// The only account-creation path. No default password, no default role.
//   node src/app/server/seed-account.ts --email <e> --role admin --password <p> [--name <n>]
// Reads PRISM_DATA_DIR and BETTER_AUTH_SECRET from the environment.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getAuth } from "./auth.ts";
import { ensureSchema } from "./db.ts";

export type SeedRole = "admin";

export interface SeedInput {
  email: string;
  role: SeedRole;
  password: string;
  name?: string;
}

const USAGE =
  "usage: seed-account.ts --email <email> --role admin --password <password> [--name <name>]";

/** Throws on a missing or unknown value; never supplies a default. */
export function parseSeedArgs(argv: readonly string[]): SeedInput {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const email = get("--email");
  const role = get("--role");
  const password = get("--password");
  const name = get("--name");
  if (!email) throw new Error(`--email is required. ${USAGE}`);
  if (role !== "admin") throw new Error(`--role is required and must be admin. ${USAGE}`);
  if (!password) throw new Error(`--password is required, there is no default. ${USAGE}`);
  return { email, role, password, name };
}

/**
 * Migrates, then creates the account through the admin plugin. With no headers
 * the call needs no prior session, which is what bootstraps the first admin.
 */
export async function seedAccount(input: SeedInput) {
  await ensureSchema();
  const result = await getAuth().api.createUser({
    body: { email: input.email, password: input.password, name: input.name ?? input.email, role: input.role },
  });
  return { id: result.user.id, email: result.user.email, role: result.user.role };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const account = await seedAccount(parseSeedArgs(process.argv.slice(2)));
    // Never the password.
    console.log(`Created ${account.role} account: ${account.email} (id=${account.id})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
