"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMinorCRC, minorToCRC, formatMinorCRC } = require("../lib/paymentMoney");

test("CRC: decimal values convert exactly without rounding", () => {
  for (const [input, expected] of [[45000, 4500000], [45000.4, 4500040], ["0.01", 1], ["10.09", 1009], [" 0001.2 ", 120]]) {
    assert.equal(parseMinorCRC(input), expected);
    assert.equal(parseMinorCRC(formatMinorCRC(expected)), expected);
    assert.equal(parseMinorCRC(minorToCRC(expected)), expected);
  }
  assert.equal(formatMinorCRC(0), "0.00");
  assert.equal(minorToCRC(0), 0);
  assert.equal(parseMinorCRC(0, { allowZero: true }), 0);
  assert.throws(() => parseMinorCRC(0));
});

test("CRC: reject overprecision, exponents, coercion and invalid numbers", () => {
  for (const value of ["1.005", "0.001", "1e3", "1E-2", "1,000.00", "+1", "-1", "1.", "", " ",
    "NaN", "Infinity", null, undefined, {}, [], [1], true, false, NaN, Infinity, -Infinity, -1, 0.1 + 0.2]) {
    assert.throws(() => parseMinorCRC(value), `must reject ${String(value)}`);
  }
});

test("CRC: upper range is an exact safe integer, no lossy numeric output", () => {
  assert.equal(parseMinorCRC("90071992547409.91"), Number.MAX_SAFE_INTEGER);
  assert.equal(formatMinorCRC(Number.MAX_SAFE_INTEGER), "90071992547409.91");
  assert.throws(() => parseMinorCRC("90071992547409.92"));
  assert.throws(() => minorToCRC(Number.MAX_SAFE_INTEGER));
  for (const value of ["100", null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.throws(() => formatMinorCRC(value));
    assert.throws(() => minorToCRC(value));
  }
});
