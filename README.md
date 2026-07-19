# TrailStack

TrailStack is a mobile-first, offline-first travel log. Text, GPS coordinates,
costs, tags, ratings, and recordings are written to IndexedDB immediately.
Authenticated Supabase sync runs later when a connection is available.

There is no framework, package install, build step, or bundler. The browser app
is static HTML, CSS, and ES modules. It loads pinned UMD builds of `idb` 8.0.3
and `@supabase/supabase-js` 2.52.1; the service worker caches both.

## 1. Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor** and run `supabase_schema.sql`. It creates `entries`,
   indexes, table RLS, and authenticated-user policies for the table and audio
   objects.
3. Open **Storage → New bucket**. Create a bucket named exactly
   `trail-audio` and leave **Public bucket** disabled. It must be private.
4. Open **Authentication → Users → Add user** and create the one email/password
   user that will use this app.
5. Open **Authentication → Providers → Email** and disable new user sign-ups.
   The existing user continues to work. This is required because the
   authenticated-user RLS policy intentionally grants every signed-in user full
   access.
6. Open **Project Settings → API** and copy the project URL and anon/publishable
   key. Never use the service-role key in the PWA.
7. Copy `config.example.js` to `config.js`, then replace both placeholders:

   ```sh
   cp config.example.js config.js
   ```

   ```js
   globalThis.TRAILSTACK_CONFIG = Object.freeze({
     SUPABASE_URL: "https://your-project.supabase.co",
     SUPABASE_ANON_KEY: "your-anon-key",
   });
   ```

Commit `config.js` so Git-connected static deployments include it. An anon key
is designed to be present in browser code, but it is safe here only because RLS
is enabled, every policy is limited to the `authenticated` role, and new
sign-ups are disabled. The service-role key must remain laptop only.

Before committing, verify anonymous access cannot read entries. Substitute the
same URL and anon key used in `config.js`:

```sh
curl -i "$SUPABASE_URL/rest/v1/entries?select=client_id&limit=1" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

Without signing in, the response must contain `[]` or return `401`; it must
never contain a trip row. If it exposes a row, stop and fix RLS before
deployment.

On first online app open, use the sign-in panel. TrailStack calls
`supabase.auth.signInWithPassword`; Supabase persists and refreshes the session.
The logging form remains usable even before sign-in, but sync waits for a valid
session.

## 2. Run locally

Configure `config.js` before the first browser load, then serve the directory:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. Service workers, geolocation, and microphone
access require a secure context; browsers treat `localhost` as secure. A phone
must use an HTTPS deployment, not a plain LAN IP.

If the app was opened before `config.js` was configured, DevTools →
**Application → Service Workers → Unregister**, clear site data, and reload.
For any deployed shell update, increment `CACHE_NAME` in `sw.js`.

## 3. Deploy to Vercel

This is a static site. Connect the repository in Vercel, choose **Other** as the
framework, leave the build command empty, and use the project root (`.`) as the
output directory. Because the configured `config.js` is committed, every Git
deployment includes it. After deployment, verify
`https://your-deployment.vercel.app/config.js` returns JavaScript rather than a
404 page.

The Vercel CLI remains available for manual deployments:

```sh
npm install -g vercel
vercel
vercel --prod
```

It is acceptable for the anon key to be public; it is not acceptable to expose
the service-role key.

After deployment, open the site online once and wait for the page to finish
loading. That first load installs the service worker and caches the complete app
shell plus both CDN libraries.

## 4. Install on iPhone

1. Open the HTTPS deployment in Safari.
2. Tap **Share**.
3. Tap **Add to Home Screen**, then **Add**.
4. Launch TrailStack from the new home-screen icon and grant location and
   microphone permissions when prompted.

iOS may evict website/IndexedDB storage if an installed web app is not opened
for weeks or the device is under storage pressure. Open the app periodically
and let pending items sync. Safari/iOS may also re-prompt for microphone access,
especially after site-data or permission changes. Keep TrailStack in the
foreground while recording.

## 5. Required offline test

1. While online, open the app, sign in, allow GPS, and wait for **GPS fixed**.
2. Enable airplane mode.
3. Add text, record and attach a short audio note, then tap **Save entry**.
   Saving must complete immediately and show `Saved ✓ (will sync later)`.
   The Today card should show the cached GPS fix, a microphone, and `⏳`.
4. Reload while still offline and confirm the entry and audio still appear.
5. Disable airplane mode. The `online` event triggers sequential sync
   automatically; **Sync now** can trigger it manually.
6. In Supabase, confirm:
   - one idempotent row exists in `entries` for the `client_id`;
   - one private object exists in `trail-audio`;
   - `audio_path` is set and `transcript_status` is `pending`.

Save never waits for network or for a new GPS request. On every save TrailStack
starts a high-accuracy fix and attaches the most recent in-memory fix. If no fix
exists yet, it saves null coordinates and shows a `no GPS` badge.

## 6. Laptop batch transcription

The transcription tool is not part of the PWA. On the Apple Silicon Mac:

```sh
cd transcribe
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Create `transcribe/.env`:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Run:

```sh
python batch_transcribe.py
```

It processes pending rows sequentially, downloads each private audio object,
uses faster-whisper `large-v3` on CPU with `compute_type="int8"`, auto-detects
language, enables VAD, and supplies a Hinglish/Icelandic/Danish decoding prompt.
The first run downloads the large model and can take time. Successful rows are
marked `done`; errors are printed and marked `failed`. To retry a corrected
failure, change that row's `transcript_status` back to `pending` and rerun.

## Behavior notes

- IndexedDB is the trip's local source of truth; successful sync never deletes
  local entries or audio.
- Entry and audio uploads are sequential. One failure is reported visibly and
  does not stop later items; the next trigger retries pending records.
- Deleting from the Today list removes the local entry and local audio only. A
  row that already synced to Supabase is intentionally not deleted remotely.
- Supabase API, authentication, and Storage requests are network-only in the
  service worker and are never cached.
- Recordings warn at 4:30 and stop automatically at 5:00. Safari prefers
  `audio/mp4`; Chrome/Android prefer Opus in WebM. Audio is stored in IndexedDB
  as base64 (not a `Blob`/`ArrayBuffer`) because iOS Safari rejects MediaRecorder
  blobs with "Error preparing Blob/File data to be stored in object store".
  After a deploy, bump `CACHE_NAME` and on iPhone clear that site’s data once so
  the new service worker replaces a stale shell.
