import { SQL } from "bun";

const databaseUrl =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const parsedDatabaseUrl = new URL(databaseUrl);

if (process.env.PICKFORGE_ALLOW_LOCAL_DB_TESTS !== "1") {
  throw new Error("set PICKFORGE_ALLOW_LOCAL_DB_TESTS=1 for the disposable local database");
}

if (
  !["127.0.0.1", "localhost", "[::1]"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "54322" ||
  parsedDatabaseUrl.pathname !== "/postgres" ||
  parsedDatabaseUrl.username !== "postgres"
) {
  throw new Error("concurrency test requires the disposable local Supabase database");
}

const sql = new SQL(databaseUrl, { max: 32 });
const runId = crypto.randomUUID();
const emailPrefix = `welcome-concurrency-${runId}-`;
let initialCampaignState:
  | { enabled: boolean; issuedCount: number }
  | undefined;

function assertEqual(actual: number, expected: number, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

try {
  const [initialCampaign] = await sql`
    select enabled, issued_count
    from welcome_credits_private.campaigns
    where campaign_key = 'launch_welcome_first_50'
  `;
  initialCampaignState = {
    enabled: Boolean(initialCampaign.enabled),
    issuedCount: Number(initialCampaign.issued_count),
  };
  assertEqual(
    Number(initialCampaignState.enabled),
    1,
    "initial campaign enabled state",
  );
  assertEqual(initialCampaignState.issuedCount, 0, "initial campaign count");

  const users = Array.from({ length: 100 }, (_, index) => ({
    id: crypto.randomUUID(),
    email: `${emailPrefix}${index}@example.invalid`,
  }));

  const insertResults = await Promise.allSettled(
    users.map(
      ({ id, email }) => sql`
        insert into auth.users (
          id,
          aud,
          role,
          email,
          raw_app_meta_data,
          raw_user_meta_data,
          is_anonymous,
          created_at,
          updated_at
        )
        values (
          ${id},
          'authenticated',
          'authenticated',
          ${email},
          '{}'::jsonb,
          '{}'::jsonb,
          false,
          now(),
          now()
        )
      `,
    ),
  );
  const failedInserts = insertResults.filter(({ status }) => status === "rejected");

  assertEqual(failedInserts.length, 0, "failed concurrent inserts");

  const [campaign] = await sql`
    select issued_count
    from welcome_credits_private.campaigns
    where campaign_key = 'launch_welcome_first_50'
  `;
  const [grants] = await sql`
    select
      count(*)::integer as grant_count,
      count(distinct credit_ledger.user_id)::integer as recipient_count,
      sum(amount_cents)::integer as total_amount,
      min(amount_cents)::integer as minimum_amount,
      max(amount_cents)::integer as maximum_amount,
      count(*) filter (
        where kind = 'grant'
          and metadata = '{"campaign":"launch_welcome_first_50"}'::jsonb
      )::integer as valid_grant_count
    from public.credit_ledger
    join auth.users on auth.users.id = credit_ledger.user_id
    where auth.users.email like ${`${emailPrefix}%`}
      and credit_ledger.idempotency_key = 'welcome:first-50:v1'
  `;
  const [createdUsers] = await sql`
    select count(*)::integer as user_count
    from auth.users
    where email like ${`${emailPrefix}%`}
  `;

  assertEqual(Number(campaign.issued_count), 50, "campaign lifetime count");
  assertEqual(Number(createdUsers.user_count), 100, "created user count");
  assertEqual(Number(grants.grant_count), 50, "grant row count");
  assertEqual(Number(grants.recipient_count), 50, "unique recipient count");
  assertEqual(Number(grants.total_amount), 5_000, "total grant amount");
  assertEqual(Number(grants.minimum_amount), 100, "minimum grant amount");
  assertEqual(Number(grants.maximum_amount), 100, "maximum grant amount");
  assertEqual(Number(grants.valid_grant_count), 50, "valid grant rows");

  const [deleted] = await sql`
    delete from auth.users
    where id = (
      select credit_ledger.user_id
      from public.credit_ledger
      join auth.users on auth.users.id = credit_ledger.user_id
      where auth.users.email like ${`${emailPrefix}%`}
        and credit_ledger.idempotency_key = 'welcome:first-50:v1'
      limit 1
    )
    returning id
  `;
  const replacementId = crypto.randomUUID();

  await sql`
    insert into auth.users (
      id,
      aud,
      role,
      email,
      raw_app_meta_data,
      raw_user_meta_data,
      is_anonymous,
      created_at,
      updated_at
    )
    values (
      ${replacementId},
      'authenticated',
      'authenticated',
      ${`${emailPrefix}replacement@example.invalid`},
      '{}'::jsonb,
      '{}'::jsonb,
      false,
      now(),
      now()
    )
  `;

  const [afterDeletion] = await sql`
    select
      (
        select issued_count
        from welcome_credits_private.campaigns
        where campaign_key = 'launch_welcome_first_50'
      )::integer as issued_count,
      (
        select count(*)
        from public.credit_ledger
        where user_id = ${replacementId}
          and idempotency_key = 'welcome:first-50:v1'
      )::integer as replacement_grants
  `;

  if (!deleted) {
    throw new Error("expected one granted account to be deleted");
  }
  assertEqual(
    Number(afterDeletion.issued_count),
    50,
    "lifetime count after account deletion",
  );
  assertEqual(
    Number(afterDeletion.replacement_grants),
    0,
    "replacement account grants",
  );

  console.log("100 concurrent signups produced exactly 50 welcome grants");
} finally {
  await sql`
    delete from auth.users
    where email like ${`${emailPrefix}%`}
  `;
  if (initialCampaignState) {
    await sql`
      update welcome_credits_private.campaigns
      set enabled = ${initialCampaignState.enabled},
          issued_count = ${initialCampaignState.issuedCount}
      where campaign_key = 'launch_welcome_first_50'
    `;
  }
  await sql.close();
}
