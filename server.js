"use strict";

const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const config = require("./server/config");
const db = require("./server/db");
const auth = require("./server/auth");
const api = require("./server/api");
const security = require("./server/security");

const app = express();
const SHOULD_OPEN = process.env.NO_OPEN !== "1";

app.disable("x-powered-by");
app.use(function (req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.use(function (req, res, next) {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (origin.host !== req.headers.host) {
        return res.status(403).json({ error: "请求来源无效", code: "INVALID_ORIGIN" });
      }
    } catch (error) {
      return res.status(403).json({ error: "请求来源无效", code: "INVALID_ORIGIN" });
    }
  }
  next();
});

app.use(auth.attachUser);

app.get("/api/health", async function (req, res, next) {
  try {
    await db.ping();
    res.json({ ok: true, database: "connected", time: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.use("/api", api);

app.use("/api", function (req, res) {
  res.status(404).json({ error: "接口不存在", code: "API_NOT_FOUND" });
});

const publicDir = config.publicDir;

function sendPage(res, filename) {
  res.sendFile(path.join(publicDir, filename));
}

app.get("/", auth.pageAuth("apprentice"), function (req, res) {
  sendPage(res, "index.html");
});

app.get("/admin", auth.pageAuth("admin"), function (req, res) {
  sendPage(res, "admin.html");
});

app.get("/login", function (req, res) {
  if (req.user && !req.user.mustChangePassword) {
    return res.redirect(req.user.role === "admin" ? "/admin" : "/");
  }
  sendPage(res, "login.html");
});

app.get("/index.html", function (req, res) {
  res.redirect("/");
});

app.get("/admin.html", function (req, res) {
  res.redirect("/admin");
});

app.get("/login.html", function (req, res) {
  res.redirect("/login");
});

app.use(express.static(publicDir, {
  index: false,
  dotfiles: "ignore",
  etag: true,
  maxAge: 0
}));

app.use(function (req, res) {
  res.status(404).send("404 Not Found");
});

app.use(function (error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }
  const status = error instanceof security.ApiError ? error.status : 500;
  const code = error instanceof security.ApiError ? error.code : "INTERNAL_ERROR";
  if (status >= 500) {
    console.error(error);
  }
  if (req.path.startsWith("/api")) {
    return res.status(status).json({
      error: status >= 500 ? "服务器内部错误" : error.message,
      code
    });
  }
  res.status(status).send(status >= 500 ? "Internal Server Error" : error.message);
});

function openBrowser(url) {
  if (!SHOULD_OPEN) {
    return;
  }
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
    } else if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
    } else {
      const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      child.unref();
    }
  } catch (error) {
    /* manual URL remains in console */
  }
}

async function start() {
  await db.ping();
  const server = app.listen(config.port, config.host, function () {
    const url = "http://localhost:" + config.port;
    console.log("");
    console.log("  学徒考勤系统已启动");
    console.log("  本地地址: " + url);
    console.log("  数据库: " + config.db.database + " @ " + config.db.host + ":" + config.db.port);
    console.log("  关闭此窗口即可停止服务");
    console.log("");
    openBrowser(url);
  });

  server.on("error", function (error) {
    if (error.code === "EADDRINUSE") {
      console.error("端口 " + config.port + " 已被占用，请关闭占用程序或修改 PORT。");
    } else {
      console.error("服务启动失败：", error.message);
    }
    process.exitCode = 1;
  });

  async function shutdown() {
    server.close(async function () {
      try {
        await db.close();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(function () {
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch(function (error) {
  console.error("无法连接数据库或启动服务：", error.message);
  process.exit(1);
});
