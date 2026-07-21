'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLoginFailureRateLimit } = require('../lib/login-rate-limit');

function attempt(limiter, { email, ip = '192.0.2.10', status = 200 }) {
  const req = { body: { email }, ip };
  const res = new EventEmitter();
  res.statusCode = status;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => ({ status: res.statusCode, body });
  let allowed = false;
  const result = limiter(req, res, () => { allowed = true; });
  if (allowed) res.emit('finish');
  return { allowed, status: res.statusCode, result };
}

test('successful coworkers on one NAT address do not consume the login failure budget', () => {
  const limiter = createLoginFailureRateLimit({
    getClientIp: (req) => req.ip,
    maxAccountFailures: 3,
    maxIpFailures: 5,
  });

  for (let index = 0; index < 20; index += 1) {
    const result = attempt(limiter, { email: `instructor${index}@example.test`, status: 200 });
    assert.equal(result.allowed, true);
  }
});

test('repeated failures for one account are blocked without affecting a successful coworker', () => {
  const limiter = createLoginFailureRateLimit({
    getClientIp: (req) => req.ip,
    maxAccountFailures: 3,
    maxIpFailures: 10,
  });

  for (let index = 0; index < 3; index += 1) {
    assert.equal(attempt(limiter, { email: 'target@example.test', status: 401 }).allowed, true);
  }
  const blocked = attempt(limiter, { email: 'target@example.test', status: 401 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, 429);
  assert.equal(attempt(limiter, { email: 'coworker@example.test', status: 200 }).allowed, true);
});

test('aggregate failed attempts remain bounded across many account names', () => {
  const limiter = createLoginFailureRateLimit({
    getClientIp: (req) => req.ip,
    maxAccountFailures: 10,
    maxIpFailures: 3,
  });

  for (let index = 0; index < 3; index += 1) {
    assert.equal(attempt(limiter, { email: `guess${index}@example.test`, status: 401 }).allowed, true);
  }
  const blocked = attempt(limiter, { email: 'guess3@example.test', status: 401 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, 429);
});
