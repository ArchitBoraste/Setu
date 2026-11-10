// The zero of each digit block converted below: Devanagari (U+0966 to U+096F)
// and fullwidth (U+FF10 to U+FF19). Unicode encodes each block's digits in
// order, so a digit's value is its distance from that block's zero.
const DEVANAGARI_ZERO = 0x0966;
const FULLWIDTH_ZERO = 0xff10;
const CONVERTED_ZEROS = [DEVANAGARI_ZERO, FULLWIDTH_ZERO];

function toAsciiDigit(char) {
  const code = char.codePointAt(0);
  for (const zero of CONVERTED_ZEROS) {
    if (code >= zero && code <= zero + 9) return String(code - zero);
  }
  return char;
}

/**
 * The phone number as typed, in the spelling the server and the cached
 * offline row both use: Devanagari and fullwidth digits turned into ASCII
 * 0-9, and surrounding whitespace removed.
 *
 * A Marathi keyboard types Devanagari digits, and some input methods type
 * fullwidth ones. The server refuses both with a 400, because its database
 * collation would match them to the ASCII number and let one account be
 * guessed under endless spellings, each with its own rate-limit count (see
 * server/utils/loginLimiter.js). Converting here gives the worker the number
 * they meant instead of an error.
 *
 * Both sign-in paths must see this same string. Offline sign-in compares the
 * phone exactly against the one the server returned at the last online
 * sign-in, which is ASCII, so converting for one path only would let a worker
 * in online and then lock them out offline.
 *
 * Only these two scripts are converted. Any other characters, inner spaces
 * included, are left alone for the server to refuse, so a mistyped number is
 * reported rather than guessed at.
 */
export function normalisePhoneInput(raw) {
  return Array.from(raw, toAsciiDigit).join("").trim();
}
