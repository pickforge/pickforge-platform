export type SyncFieldGroup = "appSettings" | "operatorConfig" | "keybindings" | "remoteBindings";

export type SyncErrorCode =
  | "boundary_violation"
  | "database_error"
  | "invalid_field_group"
  | "invalid_payload"
  | "invalid_updated_at"
  | "invalid_user_id";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const UNAMBIGUOUS_SYNC_TOKEN_PATTERN_SOURCE =
  "(sk_live_|sk_test_|whsec_|ghp_|gho_|xoxb-|AKIA[0-9A-Z]{16})";

export interface SyncRecord {
  fieldGroup: SyncFieldGroup;
  payload: Json;
  updatedAt: string;
}

export interface SupabaseErrorLike {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface SupabaseQueryResult<T> {
  data: T | null;
  error: SupabaseErrorLike | null;
}

export interface SupabaseQueryBuilderLike<T = unknown> extends PromiseLike<SupabaseQueryResult<T>> {
  select(columns?: string): SupabaseQueryBuilderLike<T>;
  update(values: unknown): SupabaseQueryBuilderLike<T>;
  upsert(
    values: unknown,
    options?: {
      onConflict?: string;
      ignoreDuplicates?: boolean;
    },
  ): SupabaseQueryBuilderLike<T>;
  eq(column: string, value: unknown): SupabaseQueryBuilderLike<T>;
  is(column: string, value: unknown): SupabaseQueryBuilderLike<T>;
  lt(column: string, value: unknown): SupabaseQueryBuilderLike<T>;
  order(
    column: string,
    options?: {
      ascending?: boolean;
    },
  ): SupabaseQueryBuilderLike<T>;
  maybeSingle(): PromiseLike<SupabaseQueryResult<T | null>>;
}

export interface SupabaseClientLike {
  from<T = unknown>(table: string): SupabaseQueryBuilderLike<T>;
}

export interface PushGroupOptions {
  supabase: SupabaseClientLike;
  userId: string;
  group: SyncFieldGroup;
  payload: unknown;
  updatedAt: string;
}

export type PushGroupResult =
  | {
      status: "written";
      record: SyncRecord;
    }
  | {
      status: "stale";
      record: SyncRecord | null;
    };

export interface PullAllOptions {
  supabase: SupabaseClientLike;
  userId: string;
}

export interface PullGroupOptions {
  supabase: SupabaseClientLike;
  userId: string;
  group: SyncFieldGroup;
}

export interface DeleteGroupOptions {
  supabase: SupabaseClientLike;
  userId: string;
  group: SyncFieldGroup;
  updatedAt: string;
}

export type DeleteGroupResult =
  | {
      status: "deleted";
    }
  | {
      status: "stale";
      record: SyncRecord | null;
    };

interface SettingsSyncRow {
  user_id: string;
  field_group: string;
  payload: unknown;
  updated_at: string;
  deleted_at: string | null;
}

const FIELD_GROUPS = ["appSettings", "operatorConfig", "keybindings", "remoteBindings"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const DENIED_KEY_PATTERN = /key|token|secret|password|credential/i;
const KEYBINDINGS_KEY_NAMES = new Set([
  "binding",
  "bindings",
  "key",
  "keybinding",
  "keybindings",
  "keycode",
  "keys",
]);
const ENV_SECRET_LABEL_PATTERN = /^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*$/;
const UNAMBIGUOUS_SYNC_TOKEN_PATTERN = new RegExp(UNAMBIGUOUS_SYNC_TOKEN_PATTERN_SOURCE, "i");
const SECRET_PREFIX_PATTERN = /^(sk_|whsec_|ghp_)/i;
const POSIX_ABSOLUTE_PATH_PATTERN = /^\//;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const WINDOWS_EXTENDED_PATH_PATTERN = /^\\\\\?\\/;
const EMBEDDED_POSIX_PATH_PATTERN = /(^|[\s=:'"])(\/[^/\s'"]+\/[^/\s'"]+)/g;
const EMBEDDED_WINDOWS_PATH_PATTERN = /(^|[\s=:'"])([A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\\\\\?\\)/;
const FILE_URL_LOCAL_PATH_PATTERN =
  /(^|[\s=:'"])file:\/\/(?:localhost)?\/(?:[A-Za-z]:\/|[^/\s'"]+\/[^/\s'"]+)/i;
const KEYBINDINGS_SHORTCUT_PATTERN =
  /^(?:(?:ctrl|control|shift|alt|option|cmd|command|meta|mod|super)\+)+[A-Za-z0-9][A-Za-z0-9_-]*$/i;
const SERIAL_PATTERN = /\b(?:serial|s\/n|sn)[:#\s-]*[A-Z0-9][A-Z0-9-]{5,}\b/i;
const SYNC_COLUMNS = "field_group,payload,updated_at,deleted_at";

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export function sanitizeSyncPayload(group: SyncFieldGroup, payload: unknown): Json {
  const validGroup = validateFieldGroup(group);
  const normalized = normalizePayload(payload);

  walkPayload(validGroup, normalized, []);

  return normalized;
}

export async function pushGroup({
  supabase,
  userId,
  group,
  payload,
  updatedAt,
}: PushGroupOptions): Promise<PushGroupResult> {
  const validUserId = validateUuid(userId, "userId");
  const validGroup = validateFieldGroup(group);
  const validUpdatedAt = validateUpdatedAt(updatedAt);
  const sanitizedPayload = sanitizeSyncPayload(validGroup, payload);
  const row = {
    user_id: validUserId,
    field_group: validGroup,
    payload: sanitizedPayload,
    updated_at: validUpdatedAt,
    deleted_at: null,
  };

  const written = await writeRowWithLww(supabase, row);
  if (written !== null) {
    return { status: "written", record: toSyncRecord(written) };
  }

  const server = await selectStoredGroup(supabase, validUserId, validGroup);
  if (server === null) {
    throw new SyncError("database_error", "Failed to read stale sync group");
  }

  return { status: "stale", record: server.deleted_at === null ? toSyncRecord(server) : null };
}

export async function pullAll({ supabase, userId }: PullAllOptions): Promise<SyncRecord[]> {
  const validUserId = validateUuid(userId, "userId");
  const { data, error } = await supabase
    .from<SettingsSyncRow[]>("settings_sync")
    .select(SYNC_COLUMNS)
    .eq("user_id", validUserId)
    .is("deleted_at", null)
    .order("field_group", { ascending: true });
  if (error !== null) {
    throw databaseError("Failed to pull sync groups", error);
  }

  return (data ?? []).map(toSyncRecord);
}

export async function pullGroup({
  supabase,
  userId,
  group,
}: PullGroupOptions): Promise<SyncRecord | null> {
  return selectGroup(supabase, validateUuid(userId, "userId"), validateFieldGroup(group));
}

export async function deleteGroup({
  supabase,
  userId,
  group,
  updatedAt,
}: DeleteGroupOptions): Promise<DeleteGroupResult> {
  const validUserId = validateUuid(userId, "userId");
  const validGroup = validateFieldGroup(group);
  const validUpdatedAt = validateUpdatedAt(updatedAt);

  const written = await writeRowWithLww(supabase, {
    user_id: validUserId,
    field_group: validGroup,
    payload: {},
    updated_at: validUpdatedAt,
    deleted_at: validUpdatedAt,
  });
  if (written !== null) {
    return { status: "deleted" };
  }

  const server = await selectStoredGroup(supabase, validUserId, validGroup);
  if (server === null) {
    throw new SyncError("database_error", "Failed to read stale sync group");
  }

  return { status: "stale", record: server.deleted_at === null ? toSyncRecord(server) : null };
}

async function selectGroup(
  supabase: SupabaseClientLike,
  userId: string,
  group: SyncFieldGroup,
): Promise<SyncRecord | null> {
  const { data, error } = await supabase
    .from<SettingsSyncRow>("settings_sync")
    .select(SYNC_COLUMNS)
    .eq("user_id", userId)
    .eq("field_group", group)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) {
    throw databaseError("Failed to pull sync group", error);
  }

  return data === null ? null : toSyncRecord(data);
}

async function selectStoredGroup(
  supabase: SupabaseClientLike,
  userId: string,
  group: SyncFieldGroup,
): Promise<SettingsSyncRow | null> {
  const { data, error } = await supabase
    .from<SettingsSyncRow>("settings_sync")
    .select(SYNC_COLUMNS)
    .eq("user_id", userId)
    .eq("field_group", group)
    .maybeSingle();
  if (error !== null) {
    throw databaseError("Failed to pull stored sync group", error);
  }

  return data;
}

async function writeRowWithLww(
  supabase: SupabaseClientLike,
  row: SettingsSyncRow,
): Promise<SettingsSyncRow | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const updated = await supabase
      .from<SettingsSyncRow>("settings_sync")
      .update(row)
      .eq("user_id", row.user_id)
      .eq("field_group", row.field_group)
      .lt("updated_at", row.updated_at)
      .select(SYNC_COLUMNS)
      .maybeSingle();
    if (updated.error !== null) {
      throw databaseError("Failed to update sync group", updated.error);
    }
    if (updated.data !== null) {
      return updated.data;
    }

    const inserted = await supabase
      .from<SettingsSyncRow>("settings_sync")
      .upsert(row, { onConflict: "user_id,field_group", ignoreDuplicates: true })
      .select(SYNC_COLUMNS)
      .maybeSingle();
    if (inserted.error !== null) {
      throw databaseError("Failed to insert sync group", inserted.error);
    }
    if (inserted.data !== null) {
      return inserted.data;
    }
  }

  return null;
}

function walkPayload(group: SyncFieldGroup, value: Json, path: string[]): void {
  if (typeof value === "string") {
    assertAllowedString(group, value, path.at(-1));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkPayload(group, item, path);
    }
    return;
  }

  if (isRecord(value)) {
    assertAllowedLabeledValue(value);

    for (const [key, item] of Object.entries(value)) {
      if (isDeniedPayloadKey(group, key)) {
        throw new SyncError("boundary_violation", `sync payload key is not allowed: ${key}`);
      }
      assertAllowedString(group, key, undefined);
      walkPayload(group, item, [...path, key]);
    }
  }
}

function assertAllowedString(group: SyncFieldGroup, value: string, key: string | undefined): void {
  const text = value.trim();
  const skipPathCheck = group === "remoteBindings" && key === "remoteRoot";
  const skipEntropyCheck = group === "keybindings" && KEYBINDINGS_SHORTCUT_PATTERN.test(text);
  const looksLikeWindowsPath =
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(text) ||
    WINDOWS_UNC_PATH_PATTERN.test(text) ||
    WINDOWS_EXTENDED_PATH_PATTERN.test(text) ||
    EMBEDDED_WINDOWS_PATH_PATTERN.test(text);

  if (
    (!skipPathCheck &&
      (POSIX_ABSOLUTE_PATH_PATTERN.test(text) || containsEmbeddedPosixPath(text))) ||
    FILE_URL_LOCAL_PATH_PATTERN.test(text) ||
    looksLikeWindowsPath
  ) {
    throw new SyncError("boundary_violation", "sync payload string looks like an absolute path");
  }

  if (
    UNAMBIGUOUS_SYNC_TOKEN_PATTERN.test(text) ||
    SECRET_PREFIX_PATTERN.test(text) ||
    SERIAL_PATTERN.test(text) ||
    (!skipEntropyCheck && looksLikeHighEntropyToken(text))
  ) {
    throw new SyncError("boundary_violation", "sync payload string looks sensitive");
  }
}

function isDeniedPayloadKey(group: SyncFieldGroup, key: string): boolean {
  if (group === "keybindings" && KEYBINDINGS_KEY_NAMES.has(key.toLowerCase())) {
    return false;
  }

  return DENIED_KEY_PATTERN.test(key);
}

function assertAllowedLabeledValue(value: Record<string, unknown>): void {
  const labels = readCaseInsensitiveFields(value, ["name", "key", "label"]);
  if (readCaseInsensitiveFields(value, ["value", "val"]).length === 0) {
    return;
  }

  for (const label of labels) {
    if (
      typeof label === "string" &&
      (DENIED_KEY_PATTERN.test(label) || ENV_SECRET_LABEL_PATTERN.test(label))
    ) {
      throw new SyncError("boundary_violation", "sync payload labeled value looks sensitive");
    }
  }
}

function readCaseInsensitiveFields(
  value: Record<string, unknown>,
  fieldNames: string[],
): unknown[] {
  const expected = new Set(fieldNames.map((fieldName) => fieldName.toLowerCase()));
  const values: unknown[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (expected.has(key.toLowerCase())) {
      values.push(item);
    }
  }

  return values;
}

function containsEmbeddedPosixPath(value: string): boolean {
  EMBEDDED_POSIX_PATH_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(EMBEDDED_POSIX_PATH_PATTERN)) {
    const boundaryIndex = match.index ?? 0;
    if (boundaryIndex >= 2 && value.slice(boundaryIndex - 2, boundaryIndex) === "//") {
      continue;
    }

    return true;
  }

  return false;
}

function normalizePayload(payload: unknown): Json {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(payload);
  } catch (cause) {
    throw new SyncError("boundary_violation", "sync payload must be JSON serializable", { cause });
  }

  if (serialized === undefined) {
    throw new SyncError("boundary_violation", "sync payload must be JSON serializable");
  }

  const normalized = JSON.parse(serialized) as unknown;
  if (!isJson(normalized)) {
    throw new SyncError("boundary_violation", "sync payload must normalize to JSON");
  }

  return normalized;
}

function looksLikeHighEntropyToken(value: string): boolean {
  if (value.length < 32 || /\s/.test(value)) {
    return false;
  }

  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;

  return classes >= 3 && /^[A-Za-z0-9._~+/=-]+$/.test(value);
}

function toSyncRecord(row: SettingsSyncRow): SyncRecord {
  const fieldGroup = validateFieldGroup(row.field_group);
  if (!isJson(row.payload)) {
    throw new SyncError("invalid_payload", "Supabase returned an invalid sync payload");
  }

  return {
    fieldGroup,
    payload: row.payload,
    updatedAt: validateUpdatedAt(row.updated_at),
  };
}

function validateFieldGroup(value: unknown): SyncFieldGroup {
  if (typeof value !== "string" || !FIELD_GROUPS.includes(value as SyncFieldGroup)) {
    throw new SyncError("invalid_field_group", "field group is not syncable");
  }

  return value as SyncFieldGroup;
}

function validateUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyncError("invalid_user_id", `${field} must be a uuid`);
  }

  return value;
}

function validateUpdatedAt(value: unknown): string {
  if (typeof value !== "string") {
    throw new SyncError("invalid_updated_at", "updatedAt must be an ISO timestamp");
  }

  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    throw new SyncError("invalid_updated_at", "updatedAt must be an ISO timestamp");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = (match[7] ?? "").padEnd(6, "0");
  const offset = match[8];
  if (offset === undefined) {
    throw new SyncError("invalid_updated_at", "updatedAt must be an ISO timestamp");
  }
  const millisecond = Number(fraction.slice(0, 3));
  const microsecondRemainder = Number(fraction.slice(3, 6));
  const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const localDate = new Date(localUtcMs);

  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second ||
    localDate.getUTCMilliseconds() !== millisecond
  ) {
    throw new SyncError("invalid_updated_at", "updatedAt must be an ISO timestamp");
  }

  const utcMs = localUtcMs - parseOffsetMinutes(offset) * 60_000;

  return formatCanonicalTimestamp(utcMs, microsecondRemainder);
}

function parseOffsetMinutes(offset: string): number {
  if (offset === "Z") {
    return 0;
  }

  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) {
    throw new SyncError("invalid_updated_at", "updatedAt must be an ISO timestamp");
  }

  return sign * (hours * 60 + minutes);
}

function formatCanonicalTimestamp(utcMs: number, microsecondRemainder: number): string {
  const date = new Date(utcMs);
  const fraction = `${String(date.getUTCMilliseconds()).padStart(3, "0")}${String(
    microsecondRemainder,
  ).padStart(3, "0")}`;

  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )}T${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )}.${fraction}Z`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isJson(value: unknown): value is Json {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJson);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJson);
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function databaseError(message: string, cause: SupabaseErrorLike): SyncError {
  return new SyncError("database_error", message, { cause });
}
