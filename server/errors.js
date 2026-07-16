/*
 * Lives here rather than in index.js because db.js needs it too, and db.js
 * cannot import from index.js — index.js imports db.js.
 *
 * Node 20+ enables autoSelectFamily by default: when a hostname resolves to
 * several addresses (IPv6 and IPv4) and ALL of them fail, it throws an
 * AggregateError whose .message is EMPTY and whose real causes are hidden in
 * .errors. Railway's private network is IPv6-only, so a failure there arrives
 * in exactly that shape — and logging only e.message printed
 * "[boot] migration failed:" with nothing after it, over and over.
 * Never log a bare .message for a connection error.
 */
export function describeError(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code) parts.push('code=' + e.code);
  if (Array.isArray(e.errors) && e.errors.length) {
    parts.push('caused by: ' + e.errors
      .map((sub) => (sub && sub.message ? sub.message : String(sub)) + (sub && sub.code ? ' [' + sub.code + ']' : ''))
      .join(' | '));
  }
  if (!parts.length) parts.push(e.constructor ? e.constructor.name : String(e));
  return parts.join(' · ');
}
