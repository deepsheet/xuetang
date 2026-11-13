"use strict";

const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const security = require("./security");

const sessionTouchCache = new Map();

function serializeUser(row) {
  return {
    id: Number(row.id),
    number: row.number,
    name: row.display_name,
    role: row.role,
    numberType: row.number_type,
    status: row.status,
    mustChangePassword: security.booleanValue(row.must_change_password),
    lastLoginAt: security.toIso(row.last_login_at),
    createdAt: security.toIso(row.created_at)
  };
}

function cookieOptions(req) {
  const secure = config.session.secureCookie || req.secure ||
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: config.session.ttlHours * 60 * 60 * 1000
  };
}

async function createSession(accountId, req, res) {
  const token = security.randomToken();
  const tokenHash = security.hashToken(token);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.session.ttlHours * 60 * 60 * 1000);

  await db.execute(
    "DELETE FROM xt_sessions WHERE expires_at < UTC_TIMESTAMP(3) OR (revoked_at IS NOT NULL AND revoked_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY))"
  );
  await db.execute(
    "INSERT INTO xt_sessions (id, account_id, token_hash, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      sessionId,
      accountId,
      tokenHash,
      (req.ip || req.socket.remoteAddress || "").slice(0, 45),
      String(req.headers["user-agent"] || "").slice(0, 255),
      expiresAt
    ]
  );

  res.cookie(config.session.cookieName, token, cookieOptions(req));
  return { id: sessionId, token, tokenHash, expiresAt };
}

function clearSessionCookie(req, res) {
  res.clearCookie(config.session.cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.session.secureCookie || req.secure,
    path: "/"
  });
}

async function revokeCurrentSession(req, res) {
  if (req.sessionId) {
    await db.execute(
      "UPDATE xt_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL",
      [req.sessionId]
    );
  }
  clearSessionCookie(req, res);
}

async function revokeOtherSessions(accountId, currentSessionId) {
  await db.execute(
    "UPDATE xt_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND id <> ? AND revoked_at IS NULL",
    [accountId, currentSessionId || ""]
  );
}

async function attachUser(req, res, next) {
  try {
    const cookies = security.parseCookies(req.headers.cookie);
    const token = cookies[config.session.cookieName];
    if (!token) {
      return next();
    }

    const tokenHash = security.hashToken(token);
    const rows = await db.query(
      "SELECT s.id AS session_id, s.last_seen_at, a.* " +
      "FROM xt_sessions s JOIN xt_accounts a ON a.id = s.account_id " +
      "WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) " +
      "LIMIT 1",
      [tokenHash]
    );

    if (!rows.length) {
      clearSessionCookie(req, res);
      return next();
    }

    const row = rows[0];
    if (row.status !== "active") {
      await db.execute("UPDATE xt_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?", [row.session_id]);
      clearSessionCookie(req, res);
      return next();
    }

    req.user = serializeUser(row);
    req.sessionId = row.session_id;

    const lastTouch = sessionTouchCache.get(row.session_id) || 0;
    if (Date.now() - lastTouch > 5 * 60 * 1000) {
      sessionTouchCache.set(row.session_id, Date.now());
      db.execute("UPDATE xt_sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?", [row.session_id])
        .catch(function () { /* non-critical */ });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "请先登录", code: "UNAUTHORIZED" });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "请先登录", code: "UNAUTHORIZED" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "没有管理员权限", code: "FORBIDDEN" });
  }
  return next();
}

function requireApprentice(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "请先登录", code: "UNAUTHORIZED" });
  }
  if (req.user.role !== "apprentice") {
    return res.status(403).json({ error: "该操作仅限学徒账号", code: "FORBIDDEN" });
  }
  return next();
}

function requirePasswordChanged(req, res, next) {
  if (req.user && req.user.mustChangePassword) {
    return res.status(403).json({
      error: "首次登录需要先修改密码",
      code: "PASSWORD_CHANGE_REQUIRED"
    });
  }
  return next();
}

function pageAuth(requiredRole) {
  return function (req, res, next) {
    if (!req.user) {
      return res.redirect("/login");
    }
    if (requiredRole === "admin" && req.user.role !== "admin") {
      return res.redirect("/");
    }
    if (requiredRole === "apprentice" && req.user.role === "admin") {
      return res.redirect("/admin");
    }
    if (req.user.mustChangePassword && req.path !== "/login") {
      return res.redirect("/login?change=1");
    }
    return next();
  };
}

async function recordAudit(actorAccountId, action, targetType, targetId, detail, req) {
  try {
    await db.execute(
      "INSERT INTO xt_audit_logs (actor_account_id, action, target_type, target_id, detail, ip_address) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
      [
        actorAccountId || null,
        String(action).slice(0, 64),
        String(targetType || "").slice(0, 32),
        targetId || null,
        detail ? JSON.stringify(detail) : null,
        String((req && (req.ip || req.socket.remoteAddress)) || "").slice(0, 45)
      ]
    );
  } catch (error) {
    console.error("audit log failed:", error.message);
  }
}

async function allocateNumber(connection, numberType, year) {
  const prefix = numberType === "staff" ? "T" : "S";
  await connection.query(
    "INSERT IGNORE INTO xt_number_sequences (sequence_year, number_type, next_value) VALUES (?, ?, 1)",
    [year, numberType]
  );
  const [rows] = await connection.query(
    "SELECT next_value FROM xt_number_sequences WHERE sequence_year = ? AND number_type = ? FOR UPDATE",
    [year, numberType]
  );
  if (!rows.length) {
    throw new security.ApiError(500, "无法分配编号", "NUMBER_SEQUENCE_MISSING");
  }
  const sequence = Number(rows[0].next_value);
  await connection.query(
    "UPDATE xt_number_sequences SET next_value = next_value + 1 WHERE sequence_year = ? AND number_type = ?",
    [year, numberType]
  );
  return prefix + year + "-" + String(sequence).padStart(4, "0");
}

async function createAccount(options) {
  const displayName = security.cleanText(options.displayName, 50);
  const role = options.role === "admin" ? "admin" : "apprentice";
  const password = options.password;
  const numberType = role === "admin" ? "staff" : "student";
  const year = new Date().getFullYear();
  const passwordHash = await security.hashPassword(password);

  return db.withTransaction(async function (connection) {
    const number = await allocateNumber(connection, numberType, year);
    const [result] = await connection.query(
      "INSERT INTO xt_accounts (number, number_type, display_name, role, password_hash, must_change_password) " +
      "VALUES (?, ?, ?, ?, ?, 1)",
      [number, numberType, displayName, role, passwordHash]
    );
    const [rows] = await connection.query("SELECT * FROM xt_accounts WHERE id = ?", [result.insertId]);
    return { account: serializeUser(rows[0]), number, role };
  });
}

async function setupFirstAdmin(options) {
  const displayName = security.cleanText(options.displayName, 50);
  const password = options.password;
  const passwordHash = await security.hashPassword(password);
  const year = new Date().getFullYear();
  const connection = await db.pool.getConnection();

  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('app_first_admin_setup', 5) AS locked");
    if (!lockRows[0] || Number(lockRows[0].locked) !== 1) {
      throw new security.ApiError(503, "初始化繁忙，请稍后重试", "SETUP_BUSY");
    }

    try {
      const [existing] = await connection.query("SELECT COUNT(*) AS count FROM xt_accounts");
      if (Number(existing[0].count) > 0) {
        throw new security.ApiError(409, "系统已经完成初始化", "ALREADY_SETUP");
      }

      await connection.beginTransaction();
      const number = await allocateNumber(connection, "staff", year);
      const [result] = await connection.query(
        "INSERT INTO xt_accounts (number, number_type, display_name, role, password_hash, must_change_password, password_changed_at) " +
        "VALUES (?, 'staff', ?, 'admin', ?, 0, UTC_TIMESTAMP(3))",
        [number, displayName, passwordHash]
      );
      const [rows] = await connection.query("SELECT * FROM xt_accounts WHERE id = ?", [result.insertId]);
      await connection.commit();
      return serializeUser(rows[0]);
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        /* ignore */
      }
      throw error;
    } finally {
      await connection.query("SELECT RELEASE_LOCK('app_first_admin_setup')");
    }
  } finally {
    connection.release();
  }
}

async function recordLoginAttempt(loginNumber, ip, success, req) {
  try {
    await db.execute(
      "INSERT INTO xt_login_attempts (login_number, ip_address, user_agent, success) VALUES (?, ?, ?, ?)",
      [
        String(loginNumber || "").slice(0, 20),
        String(ip || "").slice(0, 45),
        String((req && req.headers["user-agent"]) || "").slice(0, 255),
        success ? 1 : 0
      ]
    );
  } catch (error) {
    console.error("login attempt log failed:", error.message);
  }
}

async function login(numberInput, password, req, res) {
  const rawInput = String(numberInput == null ? "" : numberInput).trim();
  // 姓名登录：姓名 + 真实密码，或姓名 + J（快捷，忽略大小写）；同名账号取创建时间最早的一个。
  if (rawInput) {
    const nameRows = await db.query(
      "SELECT * FROM xt_accounts WHERE display_name = ? ORDER BY created_at ASC, id ASC LIMIT 1",
      [rawInput]
    );
    const nameAccount = nameRows[0];
    if (nameAccount) {
      if (nameAccount.status !== "active") {
        throw new security.ApiError(403, "账号已被停用，请联系管理员", "ACCOUNT_DISABLED");
      }
      const shortcut = String(password).toUpperCase() === "J";
      let valid = shortcut;
      if (!valid) {
        if (nameAccount.locked_until && new Date(nameAccount.locked_until).getTime() > Date.now()) {
          throw new security.ApiError(423, "账号暂时锁定，请稍后再试", "ACCOUNT_LOCKED");
        }
        valid = await security.verifyPassword(password, nameAccount.password_hash);
      }
      if (!valid) {
        const failed = Number(nameAccount.failed_login_count) + 1;
        if (failed >= 5) {
          await db.execute(
            "UPDATE xt_accounts SET failed_login_count = ?, locked_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE) WHERE id = ?",
            [failed, nameAccount.id]
          );
        } else {
          await db.execute("UPDATE xt_accounts SET failed_login_count = ? WHERE id = ?", [failed, nameAccount.id]);
        }
        throw new security.ApiError(401, "姓名或密码不正确", "INVALID_CREDENTIALS");
      }
      await db.execute(
        "UPDATE xt_accounts SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [nameAccount.id]
      );
      await createSession(nameAccount.id, req, res);
      await recordAudit(nameAccount.id, "auth.login", "account", nameAccount.id, { mode: shortcut ? "name-shortcut" : "name-password" }, req);
      return serializeUser({
        ...nameAccount,
        failed_login_count: 0,
        locked_until: null,
        last_login_at: new Date()
      });
    }
  }

  const number = security.normalizeNumber(numberInput);
  // 学号/工号列为 ascii 排序规则，非 ASCII 输入会触发 MySQL 排序规则冲突（500），此处先按凭据错误拒绝。
  if (!/^[\x00-\x7F]*$/.test(number)) {
    throw new security.ApiError(401, "学号/工号或密码不正确", "INVALID_CREDENTIALS");
  }
  const ip = req.ip || req.socket.remoteAddress || "";

  const recent = await db.query(
    "SELECT COUNT(*) AS count FROM xt_login_attempts " +
    "WHERE success = 0 AND attempted_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE) " +
    "AND (login_number = ? OR ip_address = ?)",
    [number, ip]
  );
  if (Number(recent[0].count) >= 12) {
    throw new security.ApiError(429, "登录尝试过于频繁，请 15 分钟后再试", "TOO_MANY_ATTEMPTS");
  }

  const rows = await db.query(
    "SELECT * FROM xt_accounts WHERE number = ? LIMIT 1",
    [number]
  );
  const account = rows[0];

  if (!account) {
    await recordLoginAttempt(number, ip, false, req);
    throw new security.ApiError(401, "学号/工号或密码不正确", "INVALID_CREDENTIALS");
  }

  if (account.status !== "active") {
    await recordLoginAttempt(number, ip, false, req);
    throw new security.ApiError(403, "账号已被停用，请联系管理员", "ACCOUNT_DISABLED");
  }

  if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
    await recordLoginAttempt(number, ip, false, req);
    throw new security.ApiError(423, "账号暂时锁定，请稍后再试", "ACCOUNT_LOCKED");
  }

  const valid = await security.verifyPassword(password, account.password_hash);
  if (!valid) {
    await recordLoginAttempt(number, ip, false, req);
    const failed = Number(account.failed_login_count) + 1;
    if (failed >= 5) {
      await db.execute(
        "UPDATE xt_accounts SET failed_login_count = ?, locked_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE) WHERE id = ?",
        [failed, account.id]
      );
    } else {
      await db.execute("UPDATE xt_accounts SET failed_login_count = ? WHERE id = ?", [failed, account.id]);
    }
    throw new security.ApiError(401, "学号/工号或密码不正确", "INVALID_CREDENTIALS");
  }

  await db.execute(
    "UPDATE xt_accounts SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [account.id]
  );
  await recordLoginAttempt(number, ip, true, req);
  await createSession(account.id, req, res);

  return serializeUser({
    ...account,
    failed_login_count: 0,
    locked_until: null,
    last_login_at: new Date()
  });
}

async function changePassword(user, currentPassword, newPassword, req) {
  const rows = await db.query("SELECT password_hash FROM xt_accounts WHERE id = ? LIMIT 1", [user.id]);
  if (!rows.length) {
    throw new security.ApiError(404, "账号不存在", "ACCOUNT_NOT_FOUND");
  }
  const valid = await security.verifyPassword(currentPassword, rows[0].password_hash);
  if (!valid) {
    throw new security.ApiError(400, "当前密码不正确", "CURRENT_PASSWORD_INVALID");
  }
  const message = security.validatePassword(newPassword);
  if (message) {
    throw new security.ApiError(400, message, "WEAK_PASSWORD");
  }

  const hash = await security.hashPassword(newPassword);
  await db.execute(
    "UPDATE xt_accounts SET password_hash = ?, must_change_password = 0, password_changed_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [hash, user.id]
  );
  await revokeOtherSessions(user.id, req.sessionId);
  await recordAudit(user.id, "password.change", "account", user.id, null, req);
}

async function resetPassword(accountId, req) {
  const rows = await db.query("SELECT id, number, display_name, role FROM xt_accounts WHERE id = ? LIMIT 1", [accountId]);
  if (!rows.length) {
    throw new security.ApiError(404, "账号不存在", "ACCOUNT_NOT_FOUND");
  }
  const tempPassword = security.generateTempPassword(10);
  const hash = await security.hashPassword(tempPassword);
  await db.execute(
    "UPDATE xt_accounts SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?",
    [hash, accountId]
  );
  await db.execute("UPDATE xt_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND revoked_at IS NULL", [accountId]);
  await recordAudit(req.user.id, "account.password_reset", "account", accountId, { number: rows[0].number }, req);
  return { tempPassword, account: rows[0] };
}

async function setAccountStatus(accountId, status, req) {
  if (!["active", "disabled"].includes(status)) {
    throw new security.ApiError(400, "无效的账号状态", "INVALID_STATUS");
  }
  if (Number(accountId) === Number(req.user.id) && status === "disabled") {
    throw new security.ApiError(400, "不能停用当前登录账号", "CANNOT_DISABLE_SELF");
  }
  const rows = await db.query("SELECT id, number, display_name FROM xt_accounts WHERE id = ? LIMIT 1", [accountId]);
  if (!rows.length) {
    throw new security.ApiError(404, "账号不存在", "ACCOUNT_NOT_FOUND");
  }
  await db.execute("UPDATE xt_accounts SET status = ? WHERE id = ?", [status, accountId]);
  if (status === "disabled") {
    await db.execute("UPDATE xt_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND revoked_at IS NULL", [accountId]);
  }
  await recordAudit(req.user.id, "account." + status, "account", accountId, { number: rows[0].number }, req);
  return { account: rows[0], status };
}

module.exports = {
  serializeUser,
  attachUser,
  requireAuth,
  requireAdmin,
  requireApprentice,
  requirePasswordChanged,
  pageAuth,
  createSession,
  revokeCurrentSession,
  revokeOtherSessions,
  recordAudit,
  allocateNumber,
  createAccount,
  setupFirstAdmin,
  recordLoginAttempt,
  login,
  changePassword,
  resetPassword,
  setAccountStatus,
  clearSessionCookie
};
