/**
 * A stand-in for a real payment provider (Stripe, Checkout.com...), so the
 * project runs offline. It behaves like one in the ways that matter here:
 * it validates the card number, declines some cards, and returns a reference.
 *
 * Test cards:
 *   4242 4242 4242 4242   always succeeds
 *   4000 0000 0000 0002   always declined
 *
 * In production the charge would be a network call. You would still keep the
 * idempotency key (and pass it to the provider) so a retried checkout never
 * charges twice.
 */
const crypto = require('crypto');
const { AppError } = require('./errors');

function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function charge({ amountCents, cardNumber }) {
  const digits = String(cardNumber).replace(/\s+/g, '');
  if (!/^\d{12,19}$/.test(digits) || !luhnValid(digits)) {
    throw new AppError(400, 'CARD_INVALID', 'That card number is not valid. Check the digits.');
  }
  if (digits === '4000000000000002') {
    throw new AppError(402, 'PAYMENT_DECLINED', 'The bank declined this card. Your seats are still held; try another card.');
  }
  return { ref: `pay_${crypto.randomBytes(8).toString('hex')}`, amountCents, last4: digits.slice(-4) };
}

function refund({ paymentRef, amountCents }) {
  return { ref: `re_${crypto.randomBytes(8).toString('hex')}`, paymentRef, amountCents };
}

module.exports = { charge, refund, luhnValid };
