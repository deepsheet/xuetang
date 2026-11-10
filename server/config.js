"use strict";

const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const databaseEnvCandidates = [
  process.env.APP_DB_ENV,
  path.join(__dirname, "..", "config", "database.env"),
  "C:\\ProgramData\\ApprenticeAttendance\\config\\database.env"
].filter(Boolean);
const databaseEnvFile = databaseEnvCandidates.find(function (candidate) {
  return fs.existsSync(candidate);
}) || databaseEnvCandidates[1];
loadEnvFile(databaseEnvFile);

const db = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "attendance_app",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "apprentice_attendance",
  charset: process.env.DB_CHARSET || "utf8mb4",
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10
};

if (!db.password) {
  console.error("缺少数据库密码：请检查 " + databaseEnvFile);
  process.exit(1);
}

module.exports = {
  port: Number(process.env.PORT) || 8080,
  host: process.env.HOST || "127.0.0.1",
  db,
  databaseEnvFile,
  publicDir: path.join(__dirname, "..", "public"),
  session: {
    cookieName: "attendance_session",
    ttlHours: Number(process.env.SESSION_TTL_HOURS) || 12,
    secureCookie: process.env.COOKIE_SECURE === "1"
  },
  timezone: process.env.APP_TIMEZONE || "Asia/Shanghai",
  timezoneOffsetMinutes: Number(process.env.APP_TZ_OFFSET_MINUTES) || 480,
  isProduction: process.env.NODE_ENV === "production"
};
