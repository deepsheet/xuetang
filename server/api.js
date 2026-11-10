"use strict";

const express = require("express");
const db = require("./db");
const auth = require("./auth");
const security = require("./security");

const router = express.Router();

const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"];

function fail(status, message, code) {
  throw new security.ApiError(status, message, code);
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    fail(400, "无效的记录编号", "INVALID_ID");
  }
  return id;
}

function parseLocation(input) {
  if (!input) {
    return null;
  }
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    fail(400, "位置坐标无效", "INVALID_LOCATION");
  }
  const accuracy = Number(input.accuracy);
  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
    address: security.cleanText(input.address, 255)
  };
}

function locationFields(location, prefix) {
  return [
    location ? location.lat : null,
    location ? location.lng : null,
    location ? location.accuracy : null,
    location ? location.address : null
  ];
}

function serializeAttendance(row) {
  const active = row.status === "active" && !row.check_out_at;
  let duration = row.duration_seconds == null ? null : Number(row.duration_seconds);
  if (active) {
    duration = Math.max(0, Math.floor((Date.now() - new Date(row.check_in_at).getTime()) / 1000));
  }
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    number: row.number,
    name: row.display_name,
    role: row.role,
    checkInAt: security.toIso(row.check_in_at),
    checkOutAt: security.toIso(row.check_out_at),
    durationSeconds: duration,
    status: row.status,
    source: row.source,
    note: row.note || "",
    checkInLocation: {
      lat: row.check_in_lat == null ? null : Number(row.check_in_lat),
      lng: row.check_in_lng == null ? null : Number(row.check_in_lng),
      accuracy: row.check_in_accuracy == null ? null : Number(row.check_in_accuracy),
      address: row.check_in_address || ""
    },
    checkOutLocation: {
      lat: row.check_out_lat == null ? null : Number(row.check_out_lat),
      lng: row.check_out_lng == null ? null : Number(row.check_out_lng),
      accuracy: row.check_out_accuracy == null ? null : Number(row.check_out_accuracy),
      address: row.check_out_address || ""
    }
  };
}

function serializeTask(row) {
  const due = row.due_at ? new Date(row.due_at) : null;
  const overdue = Boolean(due && due.getTime() < Date.now() &&
    !["completed", "cancelled"].includes(row.status));
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || "",
    status: row.status,
    priority: row.priority,
    assignedTo: Number(row.assigned_to),
    assignedName: row.assigned_name || "",
    assignedNumber: row.assigned_number || "",
    createdBy: Number(row.created_by),
    createdByName: row.created_by_name || "",
    dueAt: security.toIso(row.due_at),
    startedAt: security.toIso(row.started_at),
    completedAt: security.toIso(row.completed_at),
    cancelledAt: security.toIso(row.cancelled_at),
    createdAt: security.toIso(row.created_at),
    overdue
  };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function rangeBounds(range) {
  const now = new Date();
  if (range === "today") {
    return { from: security.startOfSchoolDayUtc(now), to: security.startOfSchoolDayUtc(now, 1) };
  }
  if (range === "week") {
    return { from: security.startOfSchoolDayUtc(now, -6), to: security.startOfSchoolDayUtc(now, 1) };
  }
  if (range === "month") {
    return { from: security.startOfSchoolDayUtc(now, -29), to: security.startOfSchoolDayUtc(now, 1) };
  }
  return { from: null, to: null };
}

function adminDateBounds(query) {
  let from = query.from ? security.parseDateInput(String(query.from), false) : null;
  let to = query.to ? security.parseDateInput(String(query.to), true) : null;
  if (!from && !to) {
    const now = new Date();
    from = security.startOfSchoolDayUtc(now, -6);
    to = security.startOfSchoolDayUtc(now, 1);
  }
  return { from, to };
}

async function fetchAttendance(options) {
  const where = ["1 = 1"];
  const params = [];
  if (options.accountId) {
    where.push("ar.account_id = ?");
    params.push(options.accountId);
  }
  if (options.from) {
    where.push("(ar.check_in_at >= ? OR ar.status = 'active')");
    params.push(options.from);
  }
  if (options.to) {
    where.push("ar.check_in_at <= ?");
    params.push(options.to);
  }
  if (options.status && options.status !== "all") {
    where.push("ar.status = ?");
    params.push(options.status);
  }
  if (options.query) {
    where.push("(a.display_name LIKE ? OR CONVERT(a.number USING utf8mb4) COLLATE utf8mb4_0900_ai_ci LIKE ? OR ar.check_in_address LIKE ?)");
    const like = "%" + escapeLike(options.query) + "%";
    params.push(like, like, like);
  }

  const limit = Math.min(Math.max(Number(options.limit) || 300, 1), 5000);
  const rows = await db.query(
    "SELECT ar.*, a.display_name, a.number, a.role " +
    "FROM xt_attendance_records ar JOIN xt_accounts a ON a.id = ar.account_id " +
    "WHERE " + where.join(" AND ") + " " +
    "ORDER BY ar.check_in_at DESC LIMIT " + limit,
    params
  );
  return rows.map(serializeAttendance);
}

function taskSelectSql() {
  return "SELECT t.*, assigned.display_name AS assigned_name, assigned.number AS assigned_number, " +
    "creator.display_name AS created_by_name " +
    "FROM xt_tasks t " +
    "JOIN xt_accounts assigned ON assigned.id = t.assigned_to " +
    "JOIN xt_accounts creator ON creator.id = t.created_by ";
}

async function getActiveRecord(accountId) {
  const rows = await db.query(
    "SELECT ar.*, a.display_name, a.number, a.role " +
    "FROM xt_attendance_records ar JOIN xt_accounts a ON a.id = ar.account_id " +
    "WHERE ar.account_id = ? AND ar.status = 'active' AND ar.check_out_at IS NULL LIMIT 1",
    [accountId]
  );
  return rows.length ? serializeAttendance(rows[0]) : null;
}

async function getTaskCounts(accountId) {
  const rows = await db.query(
    "SELECT " +
    "SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS pending, " +
    "SUM(CASE WHEN status IN ('pending','in_progress') AND due_at IS NOT NULL AND due_at < UTC_TIMESTAMP(3) THEN 1 ELSE 0 END) AS overdue " +
    "FROM xt_tasks WHERE assigned_to = ?",
    [accountId]
  );
  return {
    pending: Number(rows[0].pending) || 0,
    overdue: Number(rows[0].overdue) || 0
  };
}

/* ---------------- public setup ---------------- */

router.get("/setup/status", async function (req, res) {
  const rows = await db.query("SELECT COUNT(*) AS count FROM xt_accounts");
  res.json({ needsSetup: Number(rows[0].count) === 0 });
});

router.post("/setup", async function (req, res) {
  const displayName = security.cleanText(req.body && req.body.displayName, 50);
  const password = String((req.body && req.body.password) || "");
  if (!displayName) {
    fail(400, "请填写管理员姓名", "NAME_REQUIRED");
  }
  const passwordError = security.validatePassword(password);
  if (passwordError) {
    fail(400, passwordError, "WEAK_PASSWORD");
  }

  const user = await auth.setupFirstAdmin({ displayName, password });
  await auth.createSession(user.id, req, res);
  await auth.recordAudit(user.id, "system.setup", "account", user.id, { number: user.number }, req);
  res.status(201).json({ user });
});

/* ---------------- auth ---------------- */

router.post("/auth/login", async function (req, res) {
  const number = String((req.body && req.body.number) || "");
  const password = String((req.body && req.body.password) || "");
  if (!number || !password) {
    fail(400, "请输入学号/工号和密码", "CREDENTIALS_REQUIRED");
  }
  const user = await auth.login(number, password, req, res);
  res.json({ user });
});

router.post("/auth/logout", auth.requireAuth, async function (req, res) {
  await auth.recordAudit(req.user.id, "auth.logout", "account", req.user.id, null, req);
  await auth.revokeCurrentSession(req, res);
  res.json({ ok: true });
});

router.get("/me", auth.requireAuth, function (req, res) {
  res.json({ user: req.user });
});

router.post("/auth/change-password", auth.requireAuth, async function (req, res) {
  const currentPassword = String((req.body && req.body.currentPassword) || "");
  const newPassword = String((req.body && req.body.newPassword) || "");
  const message = security.validatePassword(newPassword);
  if (!currentPassword) {
    fail(400, "请输入当前密码", "CURRENT_PASSWORD_REQUIRED");
  }
  if (message) {
    fail(400, message, "WEAK_PASSWORD");
  }
  await auth.changePassword(req.user, currentPassword, newPassword, req);
  const rows = await db.query("SELECT * FROM xt_accounts WHERE id = ? LIMIT 1", [req.user.id]);
  res.json({ user: auth.serializeUser(rows[0]) });
});

/* ---------------- apprentice data ---------------- */

router.get("/dashboard", auth.requireAuth, auth.requireApprentice, auth.requirePasswordChanged, async function (req, res) {
  const now = new Date();
  const start = security.startOfSchoolDayUtc(now);
  const end = security.startOfSchoolDayUtc(now, 1);
  const weekStart = security.startOfSchoolDayUtc(now, -6);

  const todayRows = await db.query(
    "SELECT " +
    "SUM(CASE WHEN status IN ('active','completed') THEN 1 ELSE 0 END) AS checkins, " +
    "SUM(CASE WHEN status = 'completed' AND check_out_at >= ? AND check_out_at < ? THEN 1 ELSE 0 END) AS checkouts, " +
    "COALESCE(SUM(CASE WHEN status = 'completed' THEN duration_seconds ELSE TIMESTAMPDIFF(SECOND, check_in_at, UTC_TIMESTAMP(3)) END), 0) AS seconds " +
    "FROM xt_attendance_records WHERE account_id = ? AND status IN ('active','completed') AND check_in_at >= ? AND check_in_at < ?",
    [start, end, req.user.id, start, end]
  );
  const weekRows = await db.query(
    "SELECT COUNT(*) AS sessions, " +
    "COALESCE(SUM(CASE WHEN status = 'completed' THEN duration_seconds ELSE TIMESTAMPDIFF(SECOND, check_in_at, UTC_TIMESTAMP(3)) END), 0) AS seconds " +
    "FROM xt_attendance_records WHERE account_id = ? AND status IN ('active','completed') AND check_in_at >= ?",
    [req.user.id, weekStart]
  );
  const activeRecord = await getActiveRecord(req.user.id);
  const taskCounts = await getTaskCounts(req.user.id);
  const tasks = await db.query(
    taskSelectSql() +
    "WHERE t.assigned_to = ? AND t.status <> 'cancelled' " +
    "ORDER BY FIELD(t.status, 'in_progress','pending','completed'), t.due_at IS NULL, t.due_at LIMIT 20",
    [req.user.id]
  );
  const dailyRows = await db.query(
    "SELECT DATE_FORMAT(DATE_ADD(check_in_at, INTERVAL 480 MINUTE), '%Y-%m-%d') AS day, COUNT(*) AS checkins " +
    "FROM xt_attendance_records WHERE account_id = ? AND status IN ('active','completed') AND check_in_at >= ? " +
    "GROUP BY day ORDER BY day",
    [req.user.id, weekStart]
  );
  const dailyMap = new Map(dailyRows.map(function (row) {
    return [String(row.day), Number(row.checkins)];
  }));
  const daily = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = security.startOfSchoolDayUtc(now, -offset);
    const key = security.schoolDateKey(date);
    daily.push({ date: key, checkins: dailyMap.get(key) || 0 });
  }

  res.json({
    user: req.user,
    stats: {
      todayCheckins: Number(todayRows[0].checkins) || 0,
      todayCheckouts: Number(todayRows[0].checkouts) || 0,
      todaySeconds: Number(todayRows[0].seconds) || 0,
      activeCount: activeRecord ? 1 : 0,
      weekSeconds: Number(weekRows[0].seconds) || 0,
      weekSessions: Number(weekRows[0].sessions) || 0,
      pendingTasks: taskCounts.pending,
      overdueTasks: taskCounts.overdue
    },
    activeRecord,
    tasks: tasks.map(serializeTask),
    daily
  });
});

router.get("/attendance", auth.requireAuth, auth.requirePasswordChanged, async function (req, res) {
  const range = String(req.query.range || "today");
  const bounds = rangeBounds(range);
  const accountId = req.user.role === "admin" ? null : req.user.id;
  const records = await fetchAttendance({
    accountId,
    from: bounds.from,
    to: bounds.to,
    status: String(req.query.status || "all"),
    query: String(req.query.q || "").trim(),
    limit: Number(req.query.limit) || 300
  });
  const totalRows = await db.query(
    "SELECT COUNT(*) AS total FROM xt_attendance_records WHERE account_id = ?",
    [req.user.id]
  );
  res.json({ records, total: Number(totalRows[0].total) || 0, range });
});

router.get("/attendance/export", auth.requireAuth, auth.requirePasswordChanged, async function (req, res) {
  const range = String(req.query.range || "today");
  const bounds = rangeBounds(range);
  const records = await fetchAttendance({
    accountId: req.user.role === "admin" ? null : req.user.id,
    from: bounds.from,
    to: bounds.to,
    status: String(req.query.status || "all"),
    query: String(req.query.q || "").trim(),
    limit: 5000
  });
  sendAttendanceCsv(res, records, "attendance-" + security.schoolDateKey(new Date()) + ".csv");
});

router.post("/attendance/check-in", auth.requireAuth, auth.requireApprentice, auth.requirePasswordChanged, async function (req, res) {
  const location = parseLocation(req.body && req.body.location);
  const now = new Date();
  const record = await db.withTransaction(async function (connection) {
    const [active] = await connection.query(
      "SELECT id FROM xt_attendance_records WHERE account_id = ? AND status = 'active' AND check_out_at IS NULL FOR UPDATE",
      [req.user.id]
    );
    if (active.length) {
      fail(409, "你还有未签退的记录，请先签退", "ALREADY_CHECKED_IN");
    }
    const [result] = await connection.query(
      "INSERT INTO xt_attendance_records " +
      "(account_id, check_in_at, check_in_lat, check_in_lng, check_in_accuracy, check_in_address, status, source, created_by) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'active', 'self', ?)",
      [req.user.id, now, ...locationFields(location), req.user.id]
    );
    return result.insertId;
  });

  await auth.recordAudit(req.user.id, "attendance.check_in", "attendance", record, null, req);
  const rows = await db.query(
    "SELECT ar.*, a.display_name, a.number, a.role FROM xt_attendance_records ar JOIN xt_accounts a ON a.id = ar.account_id WHERE ar.id = ?",
    [record]
  );
  res.status(201).json({ record: serializeAttendance(rows[0]) });
});

router.post("/attendance/check-out", auth.requireAuth, auth.requireApprentice, auth.requirePasswordChanged, async function (req, res) {
  const location = parseLocation(req.body && req.body.location);
  const now = new Date();
  const recordId = await db.withTransaction(async function (connection) {
    const [active] = await connection.query(
      "SELECT id FROM xt_attendance_records WHERE account_id = ? AND status = 'active' AND check_out_at IS NULL FOR UPDATE",
      [req.user.id]
    );
    if (!active.length) {
      fail(409, "当前没有未签退的记录", "NO_ACTIVE_RECORD");
    }
    await connection.query(
      "UPDATE xt_attendance_records SET check_out_at = ?, check_out_lat = ?, check_out_lng = ?, " +
      "check_out_accuracy = ?, check_out_address = ?, status = 'completed', updated_by = ? " +
      "WHERE id = ?",
      [now, ...locationFields(location), req.user.id, active[0].id]
    );
    return active[0].id;
  });

  await auth.recordAudit(req.user.id, "attendance.check_out", "attendance", recordId, null, req);
  const rows = await db.query(
    "SELECT ar.*, a.display_name, a.number, a.role FROM xt_attendance_records ar JOIN xt_accounts a ON a.id = ar.account_id WHERE ar.id = ?",
    [recordId]
  );
  res.json({ record: serializeAttendance(rows[0]) });
});

/* ---------------- tasks (apprentice) ---------------- */

router.get("/tasks", auth.requireAuth, auth.requireApprentice, auth.requirePasswordChanged, async function (req, res) {
  const tasks = await db.query(
    taskSelectSql() +
    "WHERE t.assigned_to = ? AND t.status <> 'cancelled' " +
    "ORDER BY FIELD(t.status, 'in_progress','pending','completed'), t.due_at IS NULL, t.due_at",
    [req.user.id]
  );
  res.json({ tasks: tasks.map(serializeTask) });
});

router.patch("/tasks/:id/status", auth.requireAuth, auth.requireApprentice, auth.requirePasswordChanged, async function (req, res) {
  const id = parseId(req.params.id);
  const target = String((req.body && req.body.status) || "");
  if (!["in_progress", "completed"].includes(target)) {
    fail(400, "无效的任务状态", "INVALID_TASK_STATUS");
  }

  const task = await db.withTransaction(async function (connection) {
    const [rows] = await connection.query(
      "SELECT * FROM xt_tasks WHERE id = ? AND assigned_to = ? FOR UPDATE",
      [id, req.user.id]
    );
    if (!rows.length) {
      fail(404, "任务不存在", "TASK_NOT_FOUND");
    }
    const current = rows[0];
    if (current.status === "cancelled") {
      fail(409, "任务已取消", "TASK_CANCELLED");
    }
    if (target === "in_progress") {
      if (current.status !== "pending") {
        fail(409, "当前状态不能开始任务", "INVALID_TRANSITION");
      }
      await connection.query(
        "UPDATE xt_tasks SET status = 'in_progress', started_at = COALESCE(started_at, UTC_TIMESTAMP(3)) WHERE id = ?",
        [id]
      );
    } else if (target === "completed") {
      if (current.status !== "in_progress") {
        fail(409, "请先开始任务，再标记完成", "INVALID_TRANSITION");
      }
      await connection.query(
        "UPDATE xt_tasks SET status = 'completed', completed_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [id]
      );
    }
    const [updated] = await connection.query(
      taskSelectSql() + "WHERE t.id = ?",
      [id]
    );
    return updated[0];
  });

  await auth.recordAudit(req.user.id, "task." + target, "task", id, { title: task.title }, req);
  res.json({ task: serializeTask(task) });
});

/* ---------------- admin ---------------- */

router.get("/admin/overview", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const now = new Date();
  const start = security.startOfSchoolDayUtc(now);
  const end = security.startOfSchoolDayUtc(now, 1);
  const weekStart = security.startOfSchoolDayUtc(now, -6);

  const accountRows = await db.query(
    "SELECT COUNT(*) AS total FROM xt_accounts WHERE role = 'apprentice' AND status = 'active'"
  );
  const activeRows = await db.query(
    "SELECT COUNT(*) AS count FROM xt_attendance_records WHERE status = 'active'"
  );
  const todayRows = await db.query(
    "SELECT " +
    "SUM(CASE WHEN status IN ('active','completed') THEN 1 ELSE 0 END) AS checkins, " +
    "SUM(CASE WHEN status = 'completed' AND check_out_at >= ? AND check_out_at < ? THEN 1 ELSE 0 END) AS checkouts, " +
    "COALESCE(SUM(CASE WHEN status = 'completed' THEN duration_seconds ELSE TIMESTAMPDIFF(SECOND, check_in_at, UTC_TIMESTAMP(3)) END), 0) AS seconds " +
    "FROM xt_attendance_records WHERE status IN ('active','completed') AND check_in_at >= ? AND check_in_at < ?",
    [start, end, start, end]
  );
  const taskRows = await db.query(
    "SELECT " +
    "SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS pending, " +
    "SUM(CASE WHEN status IN ('pending','in_progress') AND due_at IS NOT NULL AND due_at < UTC_TIMESTAMP(3) THEN 1 ELSE 0 END) AS overdue " +
    "FROM xt_tasks"
  );
  const dailyRows = await db.query(
    "SELECT DATE_FORMAT(DATE_ADD(check_in_at, INTERVAL 480 MINUTE), '%Y-%m-%d') AS day, " +
    "COUNT(*) AS checkins, " +
    "COALESCE(SUM(CASE WHEN status = 'completed' THEN duration_seconds ELSE TIMESTAMPDIFF(SECOND, check_in_at, UTC_TIMESTAMP(3)) END), 0) AS seconds " +
    "FROM xt_attendance_records WHERE status IN ('active','completed') AND check_in_at >= ? " +
    "GROUP BY day ORDER BY day",
    [weekStart]
  );
  const dailyMap = new Map(dailyRows.map(function (row) {
    return [String(row.day), { checkins: Number(row.checkins), seconds: Number(row.seconds) }];
  }));
  const daily = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = security.startOfSchoolDayUtc(now, -offset);
    const key = security.schoolDateKey(date);
    const value = dailyMap.get(key) || { checkins: 0, seconds: 0 };
    daily.push({ date: key, checkins: value.checkins, seconds: value.seconds });
  }

  const recent = await fetchAttendance({ limit: 6 });
  const tasks = await db.query(
    taskSelectSql() +
    "WHERE t.status IN ('pending','in_progress') ORDER BY t.due_at IS NULL, t.due_at, t.created_at DESC LIMIT 5"
  );

  res.json({
    stats: {
      totalApprentices: Number(accountRows[0].total) || 0,
      activeCount: Number(activeRows[0].count) || 0,
      todayCheckins: Number(todayRows[0].checkins) || 0,
      todayCheckouts: Number(todayRows[0].checkouts) || 0,
      todaySeconds: Number(todayRows[0].seconds) || 0,
      pendingTasks: Number(taskRows[0].pending) || 0,
      overdueTasks: Number(taskRows[0].overdue) || 0
    },
    daily,
    recent,
    tasks: tasks.map(serializeTask)
  });
});

router.get("/admin/accounts", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const where = ["1 = 1"];
  const params = [];
  if (req.query.role && ["apprentice", "admin"].includes(String(req.query.role))) {
    where.push("role = ?");
    params.push(String(req.query.role));
  }
  if (req.query.status && ["active", "disabled"].includes(String(req.query.status))) {
    where.push("status = ?");
    params.push(String(req.query.status));
  }
  if (req.query.q) {
    where.push("(display_name LIKE ? OR CONVERT(number USING utf8mb4) COLLATE utf8mb4_0900_ai_ci LIKE ?)");
    const like = "%" + escapeLike(String(req.query.q).trim()) + "%";
    params.push(like, like);
  }
  const rows = await db.query(
    "SELECT id, number, number_type, display_name, role, status, must_change_password, last_login_at, created_at " +
    "FROM xt_accounts WHERE " + where.join(" AND ") + " ORDER BY role, number",
    params
  );
  res.json({
    accounts: rows.map(function (row) {
      return {
        id: Number(row.id),
        number: row.number,
        numberType: row.number_type,
        name: row.display_name,
        role: row.role,
        status: row.status,
        mustChangePassword: security.booleanValue(row.must_change_password),
        lastLoginAt: security.toIso(row.last_login_at),
        createdAt: security.toIso(row.created_at)
      };
    })
  });
});

router.post("/admin/accounts", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const displayName = security.cleanText(req.body && req.body.displayName, 50);
  const role = (req.body && req.body.role) === "admin" ? "admin" : "apprentice";
  if (!displayName) {
    fail(400, "请填写姓名", "NAME_REQUIRED");
  }
  let password = String((req.body && req.body.password) || "");
  const generated = !password;
  if (generated) {
    password = security.generateTempPassword(10);
  } else {
    const message = security.validatePassword(password);
    if (message) {
      fail(400, message, "WEAK_PASSWORD");
    }
  }

  const result = await auth.createAccount({ displayName, role, password });
  await auth.recordAudit(req.user.id, "account.create", "account", result.account.id, {
    number: result.number,
    role: result.role
  }, req);
  res.status(201).json({
    account: result.account,
    initialPassword: generated ? password : null
  });
});

router.patch("/admin/accounts/:id/status", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const id = parseId(req.params.id);
  const status = String((req.body && req.body.status) || "");
  const result = await auth.setAccountStatus(id, status, req);
  res.json({ account: result.account, status: result.status });
});

router.post("/admin/accounts/:id/reset-password", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const id = parseId(req.params.id);
  const result = await auth.resetPassword(id, req);
  const account = result.account;
  res.json({
    account: {
      id: Number(account.id),
      number: account.number,
      name: account.display_name,
      role: account.role
    },
    initialPassword: result.tempPassword
  });
});

router.get("/admin/attendance", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const bounds = adminDateBounds(req.query);
  const records = await fetchAttendance({
    from: bounds.from,
    to: bounds.to,
    status: String(req.query.status || "all"),
    query: String(req.query.q || "").trim(),
    limit: Number(req.query.limit) || 500
  });
  res.json({ records, total: records.length });
});

router.get("/admin/attendance/export", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const bounds = adminDateBounds(req.query);
  const records = await fetchAttendance({
    from: bounds.from,
    to: bounds.to,
    status: String(req.query.status || "all"),
    query: String(req.query.q || "").trim(),
    limit: 5000
  });
  sendAttendanceCsv(res, records, "attendance-" + security.schoolDateKey(new Date()) + ".csv");
});

router.patch("/admin/attendance/:id/void", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const id = parseId(req.params.id);
  const note = security.cleanText(req.body && req.body.note, 255);
  const record = await db.withTransaction(async function (connection) {
    const [rows] = await connection.query("SELECT * FROM xt_attendance_records WHERE id = ? FOR UPDATE", [id]);
    if (!rows.length) {
      fail(404, "考勤记录不存在", "ATTENDANCE_NOT_FOUND");
    }
    if (rows[0].status === "voided") {
      fail(409, "该记录已经作废", "ALREADY_VOIDED");
    }
    await connection.query(
      "UPDATE xt_attendance_records SET status = 'voided', note = ?, updated_by = ? WHERE id = ?",
      [note || "管理员作废", req.user.id, id]
    );
    const [updated] = await connection.query(
      "SELECT ar.*, a.display_name, a.number, a.role FROM xt_attendance_records ar JOIN xt_accounts a ON a.id = ar.account_id WHERE ar.id = ?",
      [id]
    );
    return serializeAttendance(updated[0]);
  });
  await auth.recordAudit(req.user.id, "attendance.void", "attendance", id, { note }, req);
  res.json({ record });
});

router.get("/admin/durations", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const bounds = adminDateBounds(req.query);
  const rows = await db.query(
    "SELECT a.id, a.number, a.display_name, " +
    "COUNT(ar.id) AS sessions, " +
    "COALESCE(SUM(CASE WHEN ar.status = 'completed' THEN ar.duration_seconds ELSE TIMESTAMPDIFF(SECOND, ar.check_in_at, UTC_TIMESTAMP(3)) END), 0) AS total_seconds, " +
    "MAX(ar.check_in_at) AS last_check_in " +
    "FROM xt_accounts a " +
    "LEFT JOIN xt_attendance_records ar ON ar.account_id = a.id " +
    "AND ar.status IN ('active','completed') " +
    "AND ar.check_in_at >= ? AND ar.check_in_at <= ? " +
    "WHERE a.role = 'apprentice' AND a.status = 'active' " +
    "GROUP BY a.id, a.number, a.display_name " +
    "ORDER BY total_seconds DESC, a.number",
    [bounds.from, bounds.to]
  );
  const totalSeconds = rows.reduce(function (sum, row) {
    return sum + Number(row.total_seconds || 0);
  }, 0);
  res.json({
    from: security.toIso(bounds.from),
    to: security.toIso(bounds.to),
    rows: rows.map(function (row) {
      return {
        accountId: Number(row.id),
        number: row.number,
        name: row.display_name,
        sessions: Number(row.sessions) || 0,
        totalSeconds: Number(row.total_seconds) || 0,
        lastCheckInAt: security.toIso(row.last_check_in)
      };
    }),
    totalSeconds,
    totalSessions: rows.reduce(function (sum, row) { return sum + Number(row.sessions || 0); }, 0)
  });
});

router.get("/admin/tasks", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const where = ["1 = 1"];
  const params = [];
  if (req.query.status && TASK_STATUSES.includes(String(req.query.status))) {
    where.push("t.status = ?");
    params.push(String(req.query.status));
  }
  if (req.query.q) {
    where.push("(t.title LIKE ? OR assigned.display_name LIKE ? OR CONVERT(assigned.number USING utf8mb4) COLLATE utf8mb4_0900_ai_ci LIKE ?)");
    const like = "%" + escapeLike(String(req.query.q).trim()) + "%";
    params.push(like, like, like);
  }
  const rows = await db.query(
    taskSelectSql() + "WHERE " + where.join(" AND ") +
    " ORDER BY FIELD(t.status, 'pending','in_progress','completed','cancelled'), t.due_at IS NULL, t.due_at, t.created_at DESC LIMIT 500",
    params
  );
  res.json({ tasks: rows.map(serializeTask) });
});

router.post("/admin/tasks", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const title = security.cleanText(req.body && req.body.title, 120);
  const description = security.cleanText(req.body && req.body.description, 2000);
  const assignedTo = parseId(req.body && req.body.assignedTo);
  const priority = ["low", "normal", "high"].includes(req.body && req.body.priority) ?
    req.body.priority : "normal";
  let dueAt = null;
  if (req.body && req.body.dueAt) {
    const parsed = new Date(req.body.dueAt);
    if (Number.isNaN(parsed.getTime())) {
      fail(400, "截止时间无效", "INVALID_DUE_AT");
    }
    dueAt = parsed;
  }
  if (!title) {
    fail(400, "请填写任务标题", "TITLE_REQUIRED");
  }
  const assignee = await db.query(
    "SELECT id, display_name, number FROM xt_accounts WHERE id = ? AND role = 'apprentice' AND status = 'active'",
    [assignedTo]
  );
  if (!assignee.length) {
    fail(400, "只能分配给在校的有效学徒账号", "INVALID_ASSIGNEE");
  }

  const result = await db.execute(
    "INSERT INTO xt_tasks (title, description, assigned_to, created_by, priority, due_at) VALUES (?, ?, ?, ?, ?, ?)",
    [title, description, assignedTo, req.user.id, priority, dueAt]
  );
  const rows = await db.query(taskSelectSql() + "WHERE t.id = ?", [result.insertId]);
  await auth.recordAudit(req.user.id, "task.create", "task", result.insertId, {
    title,
    assignedTo,
    priority
  }, req);
  res.status(201).json({ task: serializeTask(rows[0]) });
});

router.patch("/admin/tasks/:id/cancel", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const id = parseId(req.params.id);
  const rows = await db.query("SELECT * FROM xt_tasks WHERE id = ? LIMIT 1", [id]);
  if (!rows.length) {
    fail(404, "任务不存在", "TASK_NOT_FOUND");
  }
  if (["completed", "cancelled"].includes(rows[0].status)) {
    fail(409, "当前任务不能取消", "INVALID_TRANSITION");
  }
  await db.execute(
    "UPDATE xt_tasks SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [id]
  );
  const updated = await db.query(taskSelectSql() + "WHERE t.id = ?", [id]);
  await auth.recordAudit(req.user.id, "task.cancel", "task", id, { title: rows[0].title }, req);
  res.json({ task: serializeTask(updated[0]) });
});

router.get("/admin/audit", auth.requireAdmin, auth.requirePasswordChanged, async function (req, res) {
  const rows = await db.query(
    "SELECT l.*, a.display_name AS actor_name, a.number AS actor_number " +
    "FROM xt_audit_logs l LEFT JOIN xt_accounts a ON a.id = l.actor_account_id " +
    "ORDER BY l.created_at DESC LIMIT 200"
  );
  res.json({
    logs: rows.map(function (row) {
      let detail = row.detail;
      if (typeof detail === "string") {
        try {
          detail = JSON.parse(detail);
        } catch (error) {
          detail = null;
        }
      }
      return {
        id: Number(row.id),
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id == null ? null : Number(row.target_id),
        actorName: row.actor_name || "系统",
        actorNumber: row.actor_number || "",
        detail,
        ip: row.ip_address || "",
        createdAt: security.toIso(row.created_at)
      };
    })
  });
});

/* ---------------- csv ---------------- */

function sendAttendanceCsv(res, records, filename) {
  const headers = [
    "学号/工号", "姓名", "签到时间", "签退时间", "在校时长",
    "状态", "签到地点", "签到坐标", "签退地点", "签退坐标", "备注"
  ];
  const lines = [headers.map(security.csvCell).join(",")];
  for (const record of records) {
    const checkIn = record.checkInLocation;
    const checkOut = record.checkOutLocation;
    lines.push([
      record.number,
      record.name,
      security.formatDateTime(record.checkInAt),
      security.formatDateTime(record.checkOutAt),
      record.durationSeconds == null ? "" : formatDurationForCsv(record.durationSeconds),
      statusText(record.status),
      checkIn.address || "",
      checkIn.lat == null ? "" : checkIn.lat.toFixed(5) + ", " + checkIn.lng.toFixed(5),
      checkOut.address || "",
      checkOut.lat == null ? "" : checkOut.lat.toFixed(5) + ", " + checkOut.lng.toFixed(5),
      record.note || ""
    ].map(security.csvCell).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"" + filename + "\"");
  res.send("\uFEFF" + lines.join("\r\n"));
}

function statusText(status) {
  if (status === "active") {
    return "在校中";
  }
  if (status === "completed") {
    return "已签退";
  }
  if (status === "voided") {
    return "已作废";
  }
  return status;
}

function formatDurationForCsv(seconds) {
  const totalMinutes = Math.floor(Number(seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return hours + " 小时 " + minutes + " 分";
  }
  return minutes + " 分钟";
}

module.exports = router;
