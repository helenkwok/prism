// The only account-creation path. No default password, no default role.
//   node src/app/server/seed-account.ts --email <e> --role admin|judge|company
//     (--password-stdin | --password-file <mode-600 file>) [--grant <projectId>]... [--name <n>]
// --grant is repeatable and allowed only with --role company. Passwords are never
// taken on the command line (argv shows in ps, shell history and runner echoes)
// and never printed. Reads PRISM_DATA_DIR and BETTER_AUTH_SECRET from the environment.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { grantProject, ensureAccessSchema } from "./access-store.ts";
import { getAuth } from "./auth.ts";
import { ensureSchema, getDb } from "./db.ts";

export type SeedRole = "admin" | "judge" | "company";
export const SEED_ROLES: readonly SeedRole[] = ["admin", "judge", "company"];

export type PasswordSource = { kind: "stdin" } | { kind: "file"; path: string };

export interface SeedArgs {
  email: string;
  role: SeedRole;
  name?: string;
  grants: string[];
  passwordSource: PasswordSource;
}

export interface SeedInput {
  email: string;
  role: SeedRole;
  password: string;
  name?: string;
  grants?: readonly string[];
}

const USAGE =
  "usage: seed-account.ts --email <email> --role admin|judge|company (--password-stdin | --password-file <path>) [--grant <projectId>]... [--name <name>]";

const VALUE_FLAGS = new Set(["--email", "--role", "--name", "--grant", "--password-file"]);

/** Throws on a missing, unknown or unsafe value; never supplies a default. */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const values = new Map<string, string[]>();
  let stdin = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--password" || flag.startsWith("--password=")) {
      throw new Error("passwords are never taken on the command line; use --password-stdin or --password-file");
    }
    if (flag === "--password-stdin") {
      stdin = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown argument ${flag}. ${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value. ${USAGE}`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
    i += 1;
  }
  const one = (flag: string) => values.get(flag)?.at(-1);
  const email = one("--email");
  const role = one("--role");
  const file = one("--password-file");
  const grants = values.get("--grant") ?? [];
  if (!email) throw new Error(`--email is required. ${USAGE}`);
  if (!SEED_ROLES.includes(role as SeedRole)) {
    throw new Error(`--role is required and must be admin, judge or company. ${USAGE}`);
  }
  if (grants.length > 0 && role !== "company") throw new Error("--grant is allowed only with --role company");
  if (stdin === (file !== undefined)) {
    throw new Error(`exactly one of --password-stdin or --password-file is required, there is no default. ${USAGE}`);
  }
  return {
    email,
    role: role as SeedRole,
    name: one("--name"),
    grants,
    passwordSource: stdin ? { kind: "stdin" } : { kind: "file", path: file as string },
  };
}

/** Refuses a file readable or writable by group or other, and an empty value. */
export function readPassword(source: PasswordSource): string {
  let raw: string;
  if (source.kind === "stdin") {
    raw = fs.readFileSync(0, "utf8");
  } else {
    const mode = fs.statSync(source.path).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(`--password-file must not grant group or other access (chmod 600); mode is ${(mode & 0o777).toString(8)}`);
    }
    raw = fs.readFileSync(source.path, "utf8");
  }
  const password = raw.replace(/\r?\n$/, "");
  if (password.length === 0) throw new Error("the password is empty");
  return password;
}

/**
 * Migrates, creates the account through the admin plugin, then records the
 * company's project grants. With no headers createUser needs no prior session,
 * which is what bootstraps the first admin.
 */
export async function seedAccount(input: SeedInput) {
  await ensureSchema();
  const db = getDb();
  await ensureAccessSchema(db);
  const result = await getAuth().api.createUser({
    body: { email: input.email, password: input.password, name: input.name ?? input.email, role: input.role },
  });
  const grants = input.grants ?? [];
  for (const projectId of grants) await grantProject(db, result.user.id, projectId);
  return { id: result.user.id, email: result.user.email, role: result.user.role, grants: grants.length };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const args = parseSeedArgs(process.argv.slice(2));
    const account = await seedAccount({ ...args, password: readPassword(args.passwordSource) });
    // Never the password.
    console.log(`Created ${account.role} account: ${account.email} (id=${account.id}, grants=${account.grants})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
