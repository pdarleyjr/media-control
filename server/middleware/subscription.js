const { db } = require('../db/database');

// Billing/subscription features have been removed. This module is kept only so
// that existing importers (server.js, route files) continue to resolve. Every
// user is treated as having an unlimited, always-active plan, and all the
// former gate middlewares are now passthroughs.

// Returns a synthetic "unlimited" plan merged onto the user row. Returns null
// when the user doesn't exist so callers can still distinguish missing users.
function getUserPlan(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  return {
    ...user,
    plan_name: 'unlimited',
    plan_display_name: 'Unlimited',
    max_devices: -1,
    max_storage_mb: -1,
    remote_control: 1,
    remote_url: 1,
    priority_support: 1,
    trial_active: true,
    trial_days_left: 9999,
    subscription_status: 'active',
  };
}

function getUserDeviceCount(userId) {
  return db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(userId).count;
}

function getUserStorageMB(userId) {
  const result = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM content WHERE user_id = ?').get(userId);
  return Math.ceil(result.total / (1024 * 1024));
}

// All former gate middlewares are now no-op passthroughs.
function checkDeviceLimit(req, res, next) { next(); }
function checkStorageLimit(req, res, next) { next(); }
function checkRemoteControl(req, res, next) { next(); }
function checkRemoteUrl(req, res, next) { next(); }
function checkActiveSubscription(req, res, next) { next(); }

module.exports = {
  getUserPlan,
  getUserDeviceCount,
  getUserStorageMB,
  checkDeviceLimit,
  checkStorageLimit,
  checkRemoteControl,
  checkRemoteUrl,
  checkActiveSubscription
};
