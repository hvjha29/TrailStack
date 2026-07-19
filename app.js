import {
  deleteAudio,
  deleteEntry,
  getAudio,
  getEntry,
  getPending,
  listEntries,
  putAudio,
  putEntry,
} from "./db.js";
import {
  getSession,
  hasSupabaseConfig,
  onAuthStateChange,
  signIn,
  signOut,
  syncAll,
} from "./sync.js";

const TYPES = {
  food: "🍽",
  stay: "🛏",
  sight: "🏔",
  transport: "🚌",
  cost: "💰",
  note: "📝",
  people: "👤",
};

const GPS_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 8000,
  maximumAge: 30000,
};

const elements = {
  form: document.querySelector("#entry-form"),
  onlineDot: document.querySelector("#online-dot"),
  onlineText: document.querySelector("#online-text"),
  pendingCount: document.querySelector("#pending-count"),
  gpsDot: document.querySelector("#gps-dot"),
  gpsText: document.querySelector("#gps-text"),
  gpsBanner: document.querySelector("#gps-banner"),
  typeButtons: [...document.querySelectorAll("[data-type]")],
  title: document.querySelector("#title"),
  body: document.querySelector("#body"),
  ratingButtons: [...document.querySelectorAll("[data-rating]")],
  costAmount: document.querySelector("#cost-amount"),
  currency: document.querySelector("#currency"),
  tags: document.querySelector("#tags"),
  micButton: document.querySelector("#mic-button"),
  micLabel: document.querySelector("#mic-label"),
  timer: document.querySelector("#recording-timer"),
  audioPreview: document.querySelector("#audio-preview"),
  audioPlayer: document.querySelector("#audio-player"),
  discardAudio: document.querySelector("#discard-audio"),
  saveButton: document.querySelector("#save-button"),
  entries: document.querySelector("#today-entries"),
  emptyEntries: document.querySelector("#empty-entries"),
  syncButton: document.querySelector("#sync-button"),
  toast: document.querySelector("#toast"),
  authPanel: document.querySelector("#auth-panel"),
  authMessage: document.querySelector("#auth-message"),
  authForm: document.querySelector("#auth-form"),
  authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"),
  authSubmit: document.querySelector("#auth-submit"),
  signOut: document.querySelector("#sign-out"),
};

let selectedType = "note";
let selectedRating = null;
let draftClientId = crypto.randomUUID();
let lastGpsFix = null;
let gpsPermissionBannerShown = false;
let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let recordingStartedAt = 0;
let recordingClientId = null;
let recordingFinalizing = false;
let recordingInterval = null;
let warningTimeout = null;
let stopTimeout = null;
let pendingAudio = null;
let previewUrl = null;
const entryAudioUrls = new Set();
let toastTimeout = null;
let removeAuthListener = () => {};

initialize();

function initialize() {
  bindEvents();
  updateNetworkStatus();
  updateGpsStatus("acquiring");
  requestGpsFix();
  void refreshEntries();
  void refreshPendingCount();
  void initializeAuth();
  registerServiceWorker();

  if (navigator.onLine) {
    void syncAndRefresh("app open");
  }
}

function bindEvents() {
  elements.typeButtons.forEach((button) => {
    button.addEventListener("click", () => selectType(button.dataset.type));
  });

  elements.ratingButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const rating = Number(button.dataset.rating);
      selectedRating = selectedRating === rating ? null : rating;
      renderRating();
    });
  });

  elements.micButton.addEventListener("click", () => {
    if (mediaRecorder?.state === "recording") {
      stopRecording();
    } else {
      void startRecording();
    }
  });

  elements.discardAudio.addEventListener("click", () => {
    void discardCurrentAudio();
  });

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEntry();
  });

  elements.syncButton.addEventListener("click", () => {
    if (!navigator.onLine) {
      showToast("You are offline. Sync will retry automatically.", "info");
      return;
    }
    showToast("Syncing now…", "info");
    void syncAndRefresh("manual");
  });

  elements.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSignIn();
  });

  elements.signOut.addEventListener("click", () => {
    void handleSignOut();
  });

  window.addEventListener("online", () => {
    updateNetworkStatus();
    showToast("Back online — syncing.", "success");
    void syncAndRefresh("back online");
  });

  window.addEventListener("offline", () => {
    updateNetworkStatus();
    showToast("Offline mode. New entries stay on this device.", "info");
  });

  window.addEventListener("trailstack:sync", (event) => {
    const { type, message, level } = event.detail;
    const syncing = type === "sync-start";
    elements.syncButton.disabled = syncing;
    elements.syncButton.textContent = syncing ? "Syncing…" : "Sync now";

    if (level !== "status") {
      showToast(message, level);
    }
  });

  window.addEventListener("beforeunload", () => {
    removeAuthListener();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    entryAudioUrls.forEach((url) => URL.revokeObjectURL(url));
    releaseMicrophone();
  });
}

async function initializeAuth() {
  if (!hasSupabaseConfig()) {
    elements.authPanel.hidden = false;
    elements.authForm.hidden = true;
    elements.signOut.hidden = true;
    elements.authMessage.textContent =
      "Local logging is ready. Add Supabase settings to config.js to enable sync.";
    return;
  }

  try {
    const session = await getSession();
    renderAuth(session);
    removeAuthListener = onAuthStateChange((nextSession) => {
      renderAuth(nextSession);
      if (nextSession && navigator.onLine) void syncAndRefresh("signed in");
    });
  } catch (error) {
    elements.authPanel.hidden = false;
    elements.authMessage.textContent = "Could not check the saved Supabase session.";
    showToast(`Authentication check failed: ${errorMessage(error)}`, "error");
  }
}

function renderAuth(session) {
  if (session) {
    elements.authPanel.hidden = false;
    elements.authForm.hidden = true;
    elements.signOut.hidden = false;
    elements.authMessage.textContent = `Sync account: ${session.user.email || "authenticated user"}`;
  } else {
    elements.authPanel.hidden = false;
    elements.authForm.hidden = false;
    elements.signOut.hidden = true;
    elements.authMessage.textContent =
      navigator.onLine
        ? "Sign in once to enable private Supabase sync."
        : "Sign in when online. Local logging still works.";
  }
}

async function handleSignIn() {
  const email = elements.authEmail.value.trim();
  const password = elements.authPassword.value;
  if (!email || !password) {
    showToast("Enter your Supabase email and password.", "error");
    return;
  }

  elements.authSubmit.disabled = true;
  elements.authSubmit.textContent = "Signing in…";
  try {
    await signIn(email, password);
    elements.authPassword.value = "";
    showToast("Signed in. Syncing local entries.", "success");
    await syncAndRefresh("signed in");
  } catch (error) {
    showToast(`Sign-in failed: ${errorMessage(error)}`, "error");
  } finally {
    elements.authSubmit.disabled = false;
    elements.authSubmit.textContent = "Sign in";
  }
}

async function handleSignOut() {
  try {
    await signOut();
    showToast("Signed out. Local logging remains available.", "info");
  } catch (error) {
    showToast(`Sign-out failed: ${errorMessage(error)}`, "error");
  }
}

function selectType(type) {
  selectedType = type;
  elements.typeButtons.forEach((button) => {
    const selected = button.dataset.type === type;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function renderRating() {
  elements.ratingButtons.forEach((button) => {
    const active = Number(button.dataset.rating) <= (selectedRating || 0);
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function saveEntry() {
  if (mediaRecorder?.state === "recording" || recordingFinalizing) {
    showToast("Stop the recording and wait for it to attach before saving.", "info");
    return;
  }

  requestGpsFix();
  const fixAtSave = lastGpsFix ? { ...lastGpsFix } : null;
  const clientId = draftClientId;
  const timestamp = new Date().toISOString();
  const amountText = elements.costAmount.value.trim();
  const tags = [
    ...new Set(
      elements.tags.value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];

  const entry = {
    client_id: clientId,
    ts: timestamp,
    lat: fixAtSave?.lat ?? null,
    lon: fixAtSave?.lon ?? null,
    gps_accuracy_m: fixAtSave?.accuracy ?? null,
    type: selectedType,
    title: elements.title.value.trim() || null,
    body: elements.body.value.trim() || null,
    rating: selectedRating,
    cost_amt: amountText ? Number(amountText) : null,
    currency: elements.currency.value,
    tags,
    audio_path: null,
    transcript: null,
    transcript_status: "none",
    created_offline: !navigator.onLine,
    synced_at: null,
    sync_state: "pending",
  };

  if (amountText && !Number.isFinite(entry.cost_amt)) {
    showToast("Enter a valid cost amount.", "error");
    return;
  }

  elements.saveButton.disabled = true;
  try {
    await putEntry(entry);
    resetFormAfterSave();
    await Promise.all([refreshEntries(), refreshPendingCount()]);

    showToast(
      navigator.onLine ? "Saved ✓" : "Saved ✓ (will sync later)",
      "success",
    );

    if (navigator.onLine) {
      void syncAndRefresh("new save");
    }
  } catch (error) {
    showToast(`Could not save locally: ${errorMessage(error)}`, "error");
  } finally {
    elements.saveButton.disabled = false;
  }
}

function resetFormAfterSave() {
  elements.form.reset();
  selectedType = "note";
  selectedRating = null;
  draftClientId = crypto.randomUUID();
  pendingAudio = null;
  clearPreviewUrl();
  elements.audioPreview.hidden = true;
  selectType("note");
  renderRating();
}

function requestGpsFix() {
  if (!navigator.geolocation) {
    updateGpsStatus("unavailable");
    return;
  }

  updateGpsStatus(lastGpsFix ? "fixed" : "acquiring");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      lastGpsFix = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
        capturedAt: position.timestamp,
      };
      updateGpsStatus("fixed");
    },
    (error) => {
      if (error.code === error.PERMISSION_DENIED) {
        updateGpsStatus("denied");
        if (!gpsPermissionBannerShown) {
          gpsPermissionBannerShown = true;
          elements.gpsBanner.hidden = false;
        }
      } else {
        updateGpsStatus(lastGpsFix ? "fixed" : "unavailable");
      }
    },
    GPS_OPTIONS,
  );
}

function updateGpsStatus(status) {
  const labels = {
    acquiring: "GPS…",
    fixed: "GPS fixed",
    denied: "GPS denied",
    unavailable: "No GPS",
  };
  elements.gpsDot.dataset.state = status;
  elements.gpsText.textContent = labels[status] || "GPS";
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    showToast("Audio recording is not supported in this browser.", "error");
    return;
  }

  elements.micButton.disabled = true;
  try {
    const preferredMime = chooseRecordingMime();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    recordingClientId = draftClientId;
    mediaRecorder = preferredMime
      ? new MediaRecorder(mediaStream, { mimeType: preferredMime })
      : new MediaRecorder(mediaStream);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", () => {
      void finishRecording();
    });
    mediaRecorder.addEventListener("error", (event) => {
      showToast(
        `Recording failed: ${errorMessage(event.error || "unknown recorder error")}`,
        "error",
      );
      recordingFinalizing = false;
      recordingClientId = null;
      releaseMicrophone();
      resetRecordingControls();
    });

    mediaRecorder.start(1000);
    recordingStartedAt = performance.now();
    elements.micButton.classList.add("recording");
    elements.micButton.setAttribute("aria-pressed", "true");
    elements.micLabel.textContent = "Stop";
    elements.timer.hidden = false;
    updateRecordingTimer();
    recordingInterval = setInterval(updateRecordingTimer, 250);
    warningTimeout = setTimeout(() => {
      showToast("30 seconds left — recording stops at 5 minutes.", "info");
    }, 270000);
    stopTimeout = setTimeout(() => {
      showToast("5-minute limit reached. Recording stopped.", "info");
      stopRecording();
    }, 300000);
  } catch (error) {
    recordingFinalizing = false;
    recordingClientId = null;
    releaseMicrophone();
    showToast(`Microphone unavailable: ${errorMessage(error)}`, "error");
  } finally {
    elements.micButton.disabled = false;
  }
}

function chooseRecordingMime() {
  const choices = ["audio/mp4", "audio/webm;codecs=opus"];
  return choices.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  recordingFinalizing = true;
  elements.micButton.disabled = true;
  mediaRecorder.stop();
}

async function finishRecording() {
  recordingFinalizing = true;
  const clientId = recordingClientId;
  const durationSeconds = Math.min(
    300,
    Math.max(0, (performance.now() - recordingStartedAt) / 1000),
  );
  const mime = mediaRecorder?.mimeType || recordedChunks[0]?.type || "audio/webm";

  try {
    if (!clientId) throw new Error("The recording draft was lost.");
    const blob = new Blob(recordedChunks, { type: mime });
    if (!blob.size) throw new Error("The recording was empty.");

    // Copy out of MediaRecorder-owned memory before IndexedDB (critical on iOS).
    const buffer = await new Response(blob).arrayBuffer();
    const detached = new Blob([buffer.slice(0)], { type: mime });

    pendingAudio = {
      client_id: clientId,
      blob: detached,
      mime,
      duration_s: Number(durationSeconds.toFixed(1)),
      sync_state: "pending",
    };
    await putAudio(pendingAudio);
    renderAudioPreview(detached);
    showToast("Recording attached to this entry.", "success");
  } catch (error) {
    pendingAudio = null;
    showToast(`Could not store recording: ${errorMessage(error)}`, "error");
  } finally {
    recordingFinalizing = false;
    recordingClientId = null;
    releaseMicrophone();
    resetRecordingControls();
  }
}

function renderAudioPreview(blob) {
  clearPreviewUrl();
  previewUrl = URL.createObjectURL(blob);
  elements.audioPlayer.src = previewUrl;
  elements.audioPreview.hidden = false;
}

async function discardCurrentAudio() {
  try {
    await deleteAudio(draftClientId);
    pendingAudio = null;
    clearPreviewUrl();
    elements.audioPlayer.removeAttribute("src");
    elements.audioPlayer.load();
    elements.audioPreview.hidden = true;
    showToast("Recording discarded.", "info");
  } catch (error) {
    showToast(`Could not discard recording: ${errorMessage(error)}`, "error");
  }
}

function resetRecordingControls() {
  clearTimeout(warningTimeout);
  clearTimeout(stopTimeout);
  clearInterval(recordingInterval);
  warningTimeout = null;
  stopTimeout = null;
  recordingInterval = null;
  elements.micButton.disabled = false;
  elements.micButton.classList.remove("recording");
  elements.micButton.setAttribute("aria-pressed", "false");
  elements.micLabel.textContent = "Record";
  elements.timer.hidden = true;
  elements.timer.textContent = "00:00";
  mediaRecorder = null;
  recordedChunks = [];
}

function releaseMicrophone() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

function updateRecordingTimer() {
  const elapsed = Math.min(300, (performance.now() - recordingStartedAt) / 1000);
  elements.timer.textContent = formatDuration(elapsed);
}

async function refreshEntries() {
  try {
    const entries = await listEntries({ day: todayKey() });
    const withAudio = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        audio: await getAudio(entry.client_id),
      })),
    );
    renderEntries(withAudio);
  } catch (error) {
    showToast(`Could not load today's entries: ${errorMessage(error)}`, "error");
  }
}

function renderEntries(records) {
  entryAudioUrls.forEach((url) => URL.revokeObjectURL(url));
  entryAudioUrls.clear();
  elements.entries.replaceChildren();
  elements.emptyEntries.hidden = records.length > 0;

  records.forEach(({ entry, audio }) => {
    const details = document.createElement("details");
    details.className = "entry-card";

    const summary = document.createElement("summary");
    const heading = document.createElement("span");
    heading.className = "entry-heading";
    const time = document.createElement("time");
    time.dateTime = entry.ts;
    time.textContent = new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(entry.ts));
    const title = document.createElement("strong");
    title.textContent = entry.title || entry.type;
    heading.append(time, document.createTextNode(` ${TYPES[entry.type]} `), title);

    const badges = document.createElement("span");
    badges.className = "entry-badges";
    if (audio) {
      const audioSynced = audio.sync_state === "synced";
      badges.append(
        makeBadge(
          audioSynced ? "🎙✓" : "🎙⏳",
          audioSynced ? "Audio synced" : "Audio pending sync",
          audioSynced ? "success" : "pending",
        ),
      );
    }
    if (entry.lat == null || entry.lon == null) {
      badges.append(makeBadge("no GPS", "No GPS fix", "warning"));
    }
    badges.append(
      makeBadge(
        entry.sync_state === "synced" ? "✓" : "⏳",
        entry.sync_state === "synced" ? "Entry synced" : "Entry pending sync",
        entry.sync_state === "synced" ? "success" : "pending",
      ),
    );
    summary.append(heading, badges);

    const expanded = document.createElement("div");
    expanded.className = "entry-details";
    if (entry.body) {
      const body = document.createElement("p");
      body.textContent = entry.body;
      expanded.append(body);
    }
    const metadata = document.createElement("p");
    metadata.className = "entry-metadata";
    metadata.textContent = entryMetadata(entry);
    expanded.append(metadata);

    if (audio) {
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "metadata";
      const audioUrl = URL.createObjectURL(audio.blob);
      entryAudioUrls.add(audioUrl);
      player.src = audioUrl;
      expanded.append(player);
    }

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger-button";
    removeButton.textContent = "Delete";
    removeButton.addEventListener("click", () => {
      void removeEntry(entry);
    });
    expanded.append(removeButton);

    details.append(summary, expanded);
    elements.entries.append(details);
  });
}

function entryMetadata(entry) {
  const parts = [];
  if (entry.rating) parts.push(`${"★".repeat(entry.rating)} rating`);
  if (entry.cost_amt != null) parts.push(`${entry.cost_amt} ${entry.currency}`);
  if (entry.tags?.length) parts.push(entry.tags.map((tag) => `#${tag}`).join(" "));
  if (entry.gps_accuracy_m != null) {
    parts.push(`GPS ±${Math.round(entry.gps_accuracy_m)}m`);
  }
  return parts.join(" · ") || "No extra details";
}

async function removeEntry(entry) {
  const confirmed = confirm(
    "Delete this entry and its local audio? A row already synced to Supabase is not removed.",
  );
  if (!confirmed) return;

  try {
    await deleteEntry(entry.client_id);
    await Promise.all([refreshEntries(), refreshPendingCount()]);
    showToast("Local entry deleted.", "success");
  } catch (error) {
    showToast(`Could not delete entry: ${errorMessage(error)}`, "error");
  }
}

function makeBadge(text, label, kind = "") {
  const badge = document.createElement("span");
  badge.className = `badge ${kind}`.trim();
  badge.textContent = text;
  badge.title = label;
  badge.setAttribute("aria-label", label);
  return badge;
}

async function refreshPendingCount() {
  try {
    const [entries, audio] = await Promise.all([
      getPending("entries"),
      getPending("audio"),
    ]);
    const attachedAudio = (
      await Promise.all(
        audio.map(async (record) => ((await getEntry(record.client_id)) ? 1 : 0)),
      )
    ).reduce((sum, value) => sum + value, 0);
    elements.pendingCount.textContent = `${entries.length + attachedAudio} pending`;
  } catch (error) {
    showToast(`Could not count pending saves: ${errorMessage(error)}`, "error");
  }
}

async function syncAndRefresh(reason) {
  try {
    await syncAll({ reason });
    await Promise.all([refreshEntries(), refreshPendingCount()]);
  } catch (error) {
    showToast(`Sync failed: ${errorMessage(error)}`, "error");
  } finally {
    elements.syncButton.disabled = false;
    elements.syncButton.textContent = "Sync now";
  }
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  elements.onlineDot.dataset.state = online ? "online" : "offline";
  elements.onlineText.textContent = online ? "Online" : "Offline";
}

function showToast(message, level = "info") {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.dataset.level = level;
  elements.toast.hidden = false;
  toastTimeout = setTimeout(() => {
    elements.toast.hidden = true;
  }, level === "error" ? 6500 : 4000);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      showToast(`Offline setup failed: ${errorMessage(error)}`, "error");
    });
  });
}

function todayKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDuration(seconds) {
  const wholeSeconds = Math.floor(seconds);
  const minutes = String(Math.floor(wholeSeconds / 60)).padStart(2, "0");
  const remainder = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function clearPreviewUrl() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function errorMessage(error) {
  return error?.message || String(error);
}
