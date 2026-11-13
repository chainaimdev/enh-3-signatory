// ================= CORS CONFIG (hosting-readiness fix) =================
// app.use(cors()) previously had zero origin restriction — any website,
// once this port is reachable off one trusted laptop, could make browser
// requests against endpoints that execute verification scripts, issue
// credentials, and run IPEX grants.
//
// CORS_ALLOWED_ORIGINS: comma-separated allow-list, e.g.
//   CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
//
// Unset (today's default): preserves the fully-open behavior so local
// dev/demo isn't broken by this change, but logs a loud warning on startup
// so it isn't silently carried into a real hosted deployment.

export function corsOptions() {
  const raw = (process.env.CORS_ALLOWED_ORIGINS || '').trim();

  if (!raw) {
    console.warn(
      '[cors] CORS_ALLOWED_ORIGINS not set - allowing ALL origins (*). ' +
      'Set a comma-separated allow-list before hosting this off your own machine.'
    );
    return { origin: true };
  }

  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`[cors] restricting to: ${allowed.join(', ')}`);

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
      callback(new Error(`[cors] origin "${origin}" is not in CORS_ALLOWED_ORIGINS`));
    },
  };
}
