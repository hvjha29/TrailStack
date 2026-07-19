import {
  getEntry,
  getPending,
  markSynced,
  patchEntry,
} from "./db.js";

const ENTRY_COLUMNS = [
  "client_id",
  "ts",
  "lat",
  "lon",
  "gps_accuracy_m",
  "type",
  "title",
  "body",
  "rating",
  "cost_amt",
  "currency",
  "tags",
  "audio_path",
  "transcript",
  "transcript_status",
  "created_offline",
  "synced_at",
];

let client;
let activeSync;

function config() {
  return globalThis.TRAILSTACK_CONFIG ?? {};
}

export function hasSupabaseConfig() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = config();
  return Boolean(
    SUPABASE_URL &&
      SUPABASE_ANON_KEY &&
      !SUPABASE_URL.includes("YOUR_PROJECT") &&
      !SUPABASE_ANON_KEY.includes("YOUR_ANON_KEY"),
  );
}

export function getSupabase() {
  if (!hasSupabaseConfig()) {
    throw new Error("Add your Supabase URL and anon key to config.js.");
  }

  if (!globalThis.supabase?.createClient) {
    throw new Error("The Supabase client did not load. Reload once while online.");
  }

  if (!client) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = config();
    client = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  return client;
}

export async function getSession() {
  if (!hasSupabaseConfig()) return null;
  const { data, error } = await getSupabase().auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await getSupabase().auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

export function onAuthStateChange(callback) {
  if (!hasSupabaseConfig()) return () => {};
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}

export function syncAll({ reason = "automatic" } = {}) {
  if (activeSync) return activeSync;
  activeSync = runSync(reason).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync(reason) {
  const summary = { entries: 0, audio: 0, failed: 0, skipped: false };

  if (!navigator.onLine) {
    return { ...summary, skipped: true };
  }

  if (!hasSupabaseConfig()) {
    emit("configuration", "Supabase is not configured; saves remain local.", "info");
    return { ...summary, skipped: true };
  }

  let supabaseClient;
  try {
    supabaseClient = getSupabase();
    const session = await getSession();
    if (!session) {
      emit("auth-required", "Sign in once to sync saved entries.", "info");
      return { ...summary, skipped: true };
    }
  } catch (error) {
    emit("sync-error", readableError(error), "error");
    return { ...summary, failed: 1 };
  }

  emit("sync-start", `Sync started (${reason}).`, "status");

  let entries = [];
  try {
    entries = await getPending("entries");
  } catch (error) {
    summary.failed += 1;
    emit("sync-error", `Could not read pending entries: ${readableError(error)}`, "error");
  }

  for (const entry of entries) {
    try {
      await upsertEntry(supabaseClient, entry);
      await markSynced("entries", entry.client_id);
      summary.entries += 1;
    } catch (error) {
      summary.failed += 1;
      emit(
        "sync-error",
        `Entry "${entry.title || entry.type}" did not sync: ${readableError(error)}`,
        "error",
      );
    }
  }

  let audioRecords = [];
  try {
    audioRecords = await getPending("audio");
  } catch (error) {
    summary.failed += 1;
    emit("sync-error", `Could not read pending audio: ${readableError(error)}`, "error");
  }

  for (const audio of audioRecords) {
    try {
      await ensureEntrySynced(supabaseClient, audio.client_id, summary);
      await uploadAudio(supabaseClient, audio);
      summary.audio += 1;
    } catch (error) {
      summary.failed += 1;
      emit(
        "sync-error",
        `Audio did not sync: ${readableError(error)}`,
        "error",
      );
    }
  }

  let stillPending = 0;
  try {
    const [pendingEntries, pendingAudio] = await Promise.all([
      getPending("entries"),
      getPending("audio"),
    ]);
    stillPending = pendingEntries.length + pendingAudio.length;
  } catch {
    // Ignore; summary toast below still reports what we know.
  }

  if (summary.failed) {
    emit(
      "sync-complete",
      `Sync finished with ${summary.failed} issue${summary.failed === 1 ? "" : "s"}. ${stillPending} still pending.`,
      "error",
    );
  } else if (stillPending > 0) {
    emit(
      "sync-complete",
      `Synced ${summary.entries} entr${summary.entries === 1 ? "y" : "ies"}, ${summary.audio} audio. ${stillPending} still pending — tap Sync now.`,
      "info",
    );
  } else {
    emit(
      "sync-complete",
      `Sync complete: ${summary.entries} entr${summary.entries === 1 ? "y" : "ies"}, ${summary.audio} audio.`,
      "success",
    );
  }

  return summary;
}

async function ensureEntrySynced(supabaseClient, clientId, summary) {
  const localEntry = await getEntry(clientId);
  if (!localEntry) {
    throw new Error("Recording has no matching local entry. Save the entry after recording.");
  }

  if (localEntry.sync_state === "synced") return localEntry;

  await upsertEntry(supabaseClient, localEntry);
  await markSynced("entries", clientId);
  summary.entries += 1;
  return getEntry(clientId);
}

async function upsertEntry(supabaseClient, entry) {
  const syncedAt = new Date().toISOString();
  const remoteEntry = toRemoteEntry(entry, syncedAt);
  const { error } = await supabaseClient
    .from("entries")
    .upsert(remoteEntry, { onConflict: "client_id" });
  if (error) throw error;
}

async function uploadAudio(supabaseClient, audio) {
  if (!audio?.blob?.size) {
    throw new Error("Local recording blob is empty.");
  }

  const extension = extensionForMime(audio.mime);
  const path = `${audio.client_id}.${extension}`;
  const { error: uploadError } = await supabaseClient.storage
    .from("trail-audio")
    .upload(path, audio.blob, {
      contentType: audio.mime || "application/octet-stream",
      upsert: true,
    });
  if (uploadError) throw uploadError;

  const { error: updateError } = await supabaseClient
    .from("entries")
    .update({
      audio_path: path,
      transcript_status: "pending",
      synced_at: new Date().toISOString(),
    })
    .eq("client_id", audio.client_id);
  if (updateError) throw updateError;

  await patchEntry(audio.client_id, {
    audio_path: path,
    transcript_status: "pending",
  });
  await markSynced("audio", audio.client_id);
}

function toRemoteEntry(entry, syncedAt) {
  const remote = {};
  for (const key of ENTRY_COLUMNS) {
    if (key === "synced_at") {
      remote.synced_at = syncedAt;
      continue;
    }
    if (entry[key] !== undefined) remote[key] = entry[key];
  }
  if (!remote.transcript_status) remote.transcript_status = "none";
  if (!Array.isArray(remote.tags)) remote.tags = [];
  return remote;
}

function extensionForMime(mime = "") {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  return "audio";
}

function readableError(error) {
  return error?.message || String(error);
}

function emit(type, message, level) {
  globalThis.dispatchEvent(
    new CustomEvent("trailstack:sync", {
      detail: { type, message, level },
    }),
  );
}
