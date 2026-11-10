"use strict";

const crypto = require("crypto");
const config = require("./config");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || "ERROR";
  }
}

function scryptAsync(password, salt, keyLength, options) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(password, salt, keyLength, options, function (error, derivedKey) {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64")
  ].join("$");
}

async function verifyPassword(password, encoded) {
  if (!encoded || typeof encoded !== "string") {
    return false;
  }
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!n || !r || !p) {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  const actual = await scryptAsync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: 64 * 1024 * 1024
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "密码至少需要 8 位";
  }
  if (password.length > 128) {
    return "密码不能超过 128 位";
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "密码需要同时包含字母和数字";
  }
  return "";
}

function generateTempPassword(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const size = length || 10;
  const bytes = crypto.randomBytes(size);
  let output = "";
  for (const byte of bytes) {
    output += chars[byte % chars.length];
  }
  return output;
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(header) {
  const result = {};
  if (!header) {
    return result;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    try {
      result[key] = decodeURIComponent(value);
    } catch (error) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeNumber(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function cleanText(value, maxLength) {
  return String(value == null ? "" : value).trim().slice(0, maxLength || 500);
}

function isValidNumber(value) {
  return /^[ST]\d{4}-\d{4,6}$/.test(value);
}

function datePartsInSchool(now) {
  const date = now instanceof Date ? now : new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

function startOfSchoolDayUtc(now, offsetDays) {
  const parts = datePartsInSchool(now);
  const base = Date.UTC(parts.year, parts.month - 1, parts.day) -
    config.timezoneOffsetMinutes * 60 * 1000;
  return new Date(base + (offsetDays || 0) * 24 * 60 * 60 * 1000);
}

function schoolDateKey(now) {
  const parts = datePartsInSchool(now);
  return parts.year + "-" + String(parts.month).padStart(2, "0") + "-" +
    String(parts.day).padStart(2, "0");
}

function parseDateInput(value, endOfDay) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const pieces = value.split("-").map(Number);
  const utcMidnight = Date.UTC(pieces[0], pieces[1] - 1, pieces[2]) -
    config.timezoneOffsetMinutes * 60 * 1000;
  return new Date(utcMidnight + (endOfDay ? 24 * 60 * 60 * 1000 - 1 : 0));
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return map.year + "-" + map.month + "-" + map.day + " " +
    map.hour + ":" + map.minute + ":" + map.second;
}

function toIso(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function csvCell(value) {
  let text = String(value == null ? "" : value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = "'" + text;
  }
  return '"' + text.replace(/"/g, '""') + '"';
}

function booleanValue(value) {
  return value === true || value === 1 || value === "1";
}

module.exports = {
  ApiError,
  hashPassword,
  verifyPassword,
  validatePassword,
  generateTempPassword,
  randomToken,
  hashToken,
  parseCookies,
  normalizeNumber,
  cleanText,
  isValidNumber,
  startOfSchoolDayUtc,
  schoolDateKey,
  parseDateInput,
  formatDateTime,
  toIso,
  csvCell,
  booleanValue
};
