"use strict";

const mysql = require("mysql2/promise");
const config = require("./config");

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  charset: config.db.charset,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  timezone: "Z",
  dateStrings: false,
  decimalNumbers: true,
  supportBigNumbers: true,
  bigNumberStrings: false
});

pool.on("connection", function (connection) {
  connection.query("SET time_zone = '+00:00'");
  connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci");
});

async function query(sql, params) {
  const [rows] = await pool.query(sql, params || []);
  return rows;
}

async function execute(sql, params) {
  const [result] = await pool.query(sql, params || []);
  return result;
}

async function withTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      /* ignore rollback failure */
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function ping() {
  const rows = await query("SELECT 1 AS ok");
  return rows[0] && rows[0].ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  execute,
  withTransaction,
  ping,
  close
};
