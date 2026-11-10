import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalisePhoneInput } from "../src/lib/phone.js";

// Built from code points so the test reads the same in any editor or font.
const DEVANAGARI = (digits) =>
  [...digits].map((d) => String.fromCharCode(0x0966 + Number(d))).join("");
const FULLWIDTH = (digits) =>
  [...digits].map((d) => String.fromCharCode(0xff10 + Number(d))).join("");

describe("normalisePhoneInput", () => {
  test("leaves an ASCII number as it is", () => {
    assert.equal(normalisePhoneInput("8888888888"), "8888888888");
  });

  test("turns Devanagari digits, as a Marathi keyboard types them, into ASCII", () => {
    assert.equal(normalisePhoneInput(DEVANAGARI("8888888888")), "8888888888");
  });

  test("turns fullwidth digits into ASCII", () => {
    assert.equal(normalisePhoneInput(FULLWIDTH("7777777777")), "7777777777");
  });

  test("maps every digit 0-9 of both scripts to its own value", () => {
    assert.equal(normalisePhoneInput(DEVANAGARI("0123456789")), "0123456789");
    assert.equal(normalisePhoneInput(FULLWIDTH("0123456789")), "0123456789");
  });

  test("handles a number mixing ASCII, Devanagari and fullwidth digits", () => {
    const mixed = `98${DEVANAGARI("765")}${FULLWIDTH("432")}10`;
    assert.equal(normalisePhoneInput(mixed), "9876543210");
  });

  test("removes surrounding whitespace, including the fullwidth space some input methods add", () => {
    assert.equal(normalisePhoneInput("  8888888888\t"), "8888888888");
    const ideographicSpace = String.fromCharCode(0x3000);
    const padded = `${ideographicSpace}${FULLWIDTH("8888888888")}${ideographicSpace}`;
    assert.equal(normalisePhoneInput(padded), "8888888888");
  });

  // The server refuses these, so the worker sees an error instead of being
  // signed in as a number they did not type.
  test("leaves inner spaces and other scripts' digits for the server to refuse", () => {
    assert.equal(normalisePhoneInput("88888 88888"), "88888 88888");
    const bengaliEight = String.fromCharCode(0x09ee);
    assert.equal(normalisePhoneInput(bengaliEight.repeat(3)), bengaliEight.repeat(3));
  });

  test("keeps a leading + and the characters next to the converted ranges", () => {
    assert.equal(normalisePhoneInput("+91"), "+91");
    // U+0965 and U+0970 sit either side of the Devanagari digits;
    // U+FF0F and U+FF1A either side of the fullwidth ones.
    const neighbours = String.fromCharCode(0x0965, 0x0970, 0xff0f, 0xff1a);
    assert.equal(normalisePhoneInput(neighbours), neighbours);
  });

  test("gives the same answer when run twice", () => {
    const once = normalisePhoneInput(` ${DEVANAGARI("8888888888")} `);
    assert.equal(normalisePhoneInput(once), once);
  });

  test("an empty or whitespace-only entry stays empty, so login() still asks for a number", () => {
    assert.equal(normalisePhoneInput(""), "");
    assert.equal(normalisePhoneInput("   "), "");
  });
});
