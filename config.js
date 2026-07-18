// Commit this browser configuration so Git-connected static deploys include it.
// The anon key is public by design; safety depends on RLS, authenticated-only
// policies, and disabling new user signups. Never put a service-role key here.
globalThis.TRAILSTACK_CONFIG = Object.freeze({
  SUPABASE_URL: "https://diohzvflmvsbjhepbocg.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpb2h6dmZsbXZzYmpoZXBib2NnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0MDUwODgsImV4cCI6MjA5OTk4MTA4OH0.tm15BBK2ehgOu1JGGnk7aTgAN56tZGAor9NXK5laP5E",
});
