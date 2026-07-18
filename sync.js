import {
  getEntry,
  getPending,
  markSynced,
  patchEntry,
} from "./db.js";

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
      const syncedAt = new Date().toISOString();
      const { sync_state: _localState, ...remoteEntry } = entry;
      const { error } = await supabaseClient
        .from("entries")
        .upsert(
          { ...remoteEntry, synced_at: syncedAt },
          { onConflict: "client_id" },
        );

      if (error) throw error;
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
      const localEntry = await getEntry(audio.client_id);
      if (!localEntry || localEntry.sync_state !== "synced") continue;

      const extension = extensionForMime(audio.mime);
      const path = `${audio.client_id}.${extension}`;
      const { error: uploadError } = await supabaseClient.storage
        .from("trail-audio")
        .upload(path, audio.blob, {
          contentType: audio.mime,
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

  emit(
    "sync-complete",
    summary.failed
      ? `Sync finished with ${summary.failed} issue${summary.failed === 1 ? "" : "s"}.`
      : `Sync complete: ${summary.entries} entr${summary.entries === 1 ? "y" : "ies"}, ${summary.audio} audio.`,
    summary.failed ? "error" : "success",
  );

  return summary;
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
