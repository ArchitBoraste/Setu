// The bcrypt cost every stored password hash is made at, and the cost of the
// dummy hash sign-in compares unknown phone numbers against.
//
// One constant, imported by every place that hashes a password (routes/auth.js,
// routes/admin.js, db/demoData.js), because the login route's timing defence
// depends on them agreeing. bcrypt's running time is set by the cost stored in
// the hash, so if accounts were hashed at one cost and the dummy at another,
// "no such phone" and "wrong password" would take measurably different times
// and tell anyone which numbers are registered. Three copies of `12` is how
// that drift starts.
//
// Changing this does not rehash anything already stored. Accounts keep the
// cost they were hashed at until their password is next set, so raising it
// re-opens the timing gap for every existing account until then.
//
// No imports, so seed scripts and unit tests can use it without .env or a pool.
export const BCRYPT_ROUNDS = 12;
