// Seed the org chart: resolves each e-mail to a Slack user ID (users.lookupByEmail), then inserts into `people`.
// Usage: node --env-file=.env.local scripts/seed-people.ts people.json
//   people.json = [{ "name": "Hugo Leroy", "role": "it", "email": "hugo@example.com" }, ...]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const ROLES = ["reporter", "it", "business_owner", "dpo", "lawyer", "management", "communications"];
const rows = JSON.parse(readFileSync(process.argv[2], "utf8")) as { name: string; role: string; email: string }[];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  for (const r of rows) {
    if (!ROLES.includes(r.role)) throw new Error(`unknown role ${r.role} for ${r.email}`);
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(r.email)}`, {
      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const json = (await res.json()) as { ok: boolean; error?: string; user?: { id: string } };
    const slack_user_id = json.user?.id ?? null;
    const { error } = await db.from("people").insert({ name: r.name, role: r.role, email: r.email, slack_user_id });
    console.log(r.email, r.role, slack_user_id ?? `not in Slack (${json.error})`, error ? `insert failed: ${error.message}` : "inserted");
  }
}
main();
