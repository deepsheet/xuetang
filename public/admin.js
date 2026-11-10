(function () {
  "use strict";

  const state = {
    user: null,
    view: "overview",
    accountRole: "all",
    resultText: "",
    assignees: [],
    loading: {}
  };

  const VIEW_TITLES = {
    overview: "工作台",
    accounts: "账号管理",
    attendance: "考勤记录",
    durations: "在校时长",
    tasks: "任务管理",
    audit: "审计日志"
  };

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character];
    });
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function toDateInput(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function formatDateTime(value) {
    if (!value) {
      return "—";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "—";
    }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function formatShortDate(value) {
    if (!value) {
      return "—";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "—";
    }
    return (date.getMonth() + 1) + "月" + date.getDate() + "日";
  }

  function formatDuration(seconds) {
    if (seconds == null) {
      return "—";
    }
    const totalMinutes = Math.floor(Number(seconds) / 60);
    if (totalMinutes < 1) {
      return "不足 1 分钟";
    }
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) {
      return days + " 天" + (hours ? " " + hours + " 小时" : "");
    }
    if (hours > 0) {
      return hours + " 小时" + (minutes ? " " + minutes + " 分" : "");
    }
    return minutes + " 分钟";
  }

  function formatHours(seconds) {
    const hours = Number(seconds || 0) / 3600;
    if (hours >= 10) {
      return hours.toFixed(0);
    }
    return hours.toFixed(1);
  }

  function initialOf(name) {
    return Array.from(String(name || "").trim())[0] || "学";
  }

  function avatarTone(name) {
    let total = 0;
    for (const char of String(name || "")) {
      total += char.charCodeAt(0);
    }
    return total % 5;
  }

  function avatar(name) {
    return '<span class="person-avatar avatar-tone-' + avatarTone(name) + '">' +
      escapeHtml(initialOf(name)) + "</span>";
  }

  function statusMeta(kind, status) {
    if (kind === "account") {
      return status === "active" ? ["正常", "admin-status-active"] : ["已停用", "admin-status-disabled"];
    }
    if (kind === "attendance") {
      if (status === "active") return ["在校中", "admin-status-active"];
      if (status === "completed") return ["已签退", "admin-status-completed"];
      if (status === "voided") return ["已作废", "admin-status-voided"];
    }
    if (kind === "task") {
      if (status === "pending") return ["待开始", "admin-status-pending"];
      if (status === "in_progress") return ["进行中", "admin-status-in_progress"];
      if (status === "completed") return ["已完成", "admin-status-completed"];
      if (status === "cancelled") return ["已取消", "admin-status-cancelled"];
    }
    return [status || "—", "admin-status-disabled"];
  }

  function statusBadge(kind, status) {
    const meta = statusMeta(kind, status);
    return '<span class="admin-status ' + meta[1] + '">' + meta[0] + "</span>";
  }

  function priorityBadge(priority) {
    const labels = { high: "优先", normal: "普通", low: "较低" };
    return '<span class="admin-priority admin-priority-' + escapeHtml(priority) + '">' +
      (labels[priority] || priority) + "</span>";
  }

  function taskLabel(task) {
    return task.title + " · " + statusMeta("task", task.status)[0];
  }

  function setError(message) {
    const box = $("#adminError");
    if (!message) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.textContent = message;
  }

  async function request(path, options) {
    const config = Object.assign({
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    }, options || {});
    const response = await fetch(path, config);
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (response.status === 401) {
      window.location.href = "/login";
      throw new Error("请先登录");
    }
    if (!response.ok) {
      if (data && data.code === "PASSWORD_CHANGE_REQUIRED") {
        window.location.href = "/login?change=1";
      }
      throw new Error((data && data.error) || "请求失败，请稍后重试");
    }
    return data;
  }

  function showToast(title, detail, type) {
    const container = $("#adminToast");
    const toast = document.createElement("div");
    toast.className = "toast" + (type ? " is-" + type : " is-success");
    const icon = type === "error" ? "i-alert" : type === "warning" ? "i-alert" : "i-check";
    toast.innerHTML =
      '<span class="toast-icon"><svg class="icon"><use href="#' + icon + '"></use></svg></span>' +
      '<span class="toast-copy"><strong></strong><span></span></span>';
    $("strong", toast).textContent = title;
    const detailNode = $(".toast-copy > span", toast);
    if (detail) {
      detailNode.textContent = detail;
    } else {
      detailNode.remove();
    }
    container.appendChild(toast);
    while (container.children.length > 3) {
      container.firstElementChild.remove();
    }
    window.setTimeout(function () {
      toast.classList.add("is-leaving");
      window.setTimeout(function () { toast.remove(); }, 220);
    }, 4200);
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) {
      return;
    }
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    window.requestAnimationFrame(function () {
      const target = $("input:not([disabled]), select:not([disabled]), button:not([disabled])", modal);
      if (target) {
        target.focus({ preventScroll: true });
      }
    });
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) {
      return;
    }
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".modal.is-open")) {
      document.body.classList.remove("modal-open");
    }
  }

  function viewFromHash() {
    const value = window.location.hash.replace(/^#/, "");
    return VIEW_TITLES[value] ? value : "overview";
  }

  async function navigate(view) {
    if (!VIEW_TITLES[view]) {
      view = "overview";
    }
    state.view = view;
    $$(".admin-nav-btn").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-view") === view);
    });
    $$("[data-view-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-view-panel") !== view;
    });
    $("#viewTitle").textContent = VIEW_TITLES[view];
    setError("");
    try {
      await loadView(view);
    } catch (error) {
      setError(error.message);
    }
  }

  function go(view) {
    if (viewFromHash() === view) {
      navigate(view);
    } else {
      window.location.hash = view;
    }
  }

  async function loadView(view) {
    if (view === "overview") return loadOverview();
    if (view === "accounts") return loadAccounts();
    if (view === "attendance") return loadAttendance();
    if (view === "durations") return loadDurations();
    if (view === "tasks") return loadTasks();
    if (view === "audit") return loadAudit();
  }

  /* ---------------- overview ---------------- */

  async function loadOverview() {
    const data = await request("/api/admin/overview");
    const stats = data.stats;
    $("#statTotal").textContent = stats.totalApprentices;
    $("#statActive").textContent = stats.activeCount;
    $("#statTodayIn").textContent = stats.todayCheckins;
    $("#statTodayOut").textContent = stats.todayCheckouts;
    $("#statTodayHours").textContent = formatHours(stats.todaySeconds);
    $("#statPendingTasks").textContent = stats.pendingTasks;
    $("#statOverdueTasks").textContent = stats.overdueTasks + " 个已逾期";

    renderChart(data.daily);
    renderRecent(data.recent);
    renderOverviewTasks(data.tasks);
  }

  function renderChart(daily) {
    const container = $("#dailyChart");
    const maximum = Math.max.apply(null, daily.map(function (item) { return item.checkins; }).concat([1]));
    const total = daily.reduce(function (sum, item) { return sum + item.checkins; }, 0);
    $("#chartTotal").textContent = "共 " + total + " 人次";
    container.innerHTML = daily.map(function (item) {
      const height = Math.max(4, Math.round(item.checkins / maximum * 122));
      const parts = item.date.split("-");
      return '<div class="chart-column">' +
        '<div class="chart-bar-wrap"><div class="chart-bar" style="height:' + height + 'px" title="' +
        item.date + " · " + item.checkins + ' 人次"><span class="chart-bar-value">' +
        (item.checkins || "") + '</span></div></div>' +
        '<div class="chart-label"><strong>' + Number(parts[1]) + "/" + Number(parts[2]) + "</strong>" +
        (item.checkins ? item.checkins + " 人" : "—") + "</div></div>";
    }).join("");
  }

  function renderRecent(records) {
    const body = $("#recentAttendanceBody");
    const empty = $("#recentEmpty");
    if (!records.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = records.map(function (record) {
      return "<tr>" +
        '<td><div class="admin-person">' + avatar(record.name) +
        '<div><strong>' + escapeHtml(record.name) + "</strong><span>" + escapeHtml(record.number) + "</span></div></div></td>" +
        '<td><div class="admin-time"><strong>' + formatDateTime(record.checkInAt) + "</strong></div></td>" +
        '<td><div class="admin-time"><strong>' + formatDateTime(record.checkOutAt) + "</strong></div></td>" +
        '<td><div class="admin-time"><strong>' + formatDuration(record.durationSeconds) + "</strong></div></td>" +
        "<td>" + statusBadge("attendance", record.status) + "</td>" +
        "</tr>";
    }).join("");
  }

  function renderOverviewTasks(tasks) {
    const container = $("#overviewTasks");
    if (!tasks.length) {
      container.innerHTML = '<div class="overview-empty">暂无待办任务</div>';
      return;
    }
    container.innerHTML = tasks.map(function (task) {
      return '<div class="overview-task' + (task.overdue ? " is-overdue" : "") + '">' +
        '<span class="overview-task-dot"></span>' +
        '<div><strong>' + escapeHtml(task.title) + '</strong><span>' +
        escapeHtml(task.assignedName) + " · " + statusMeta("task", task.status)[0] + "</span></div>" +
        "<time>" + (task.dueAt ? formatShortDate(task.dueAt) : "无截止") + "</time></div>";
    }).join("");
  }

  /* ---------------- accounts ---------------- */

  function accountQuery() {
    const params = new URLSearchParams();
    if (state.accountRole !== "all") {
      params.set("role", state.accountRole);
    }
    const q = $("#accountSearch").value.trim();
    if (q) {
      params.set("q", q);
    }
    return params.toString();
  }

  async function loadAccounts() {
    const data = await request("/api/admin/accounts?" + accountQuery());
    const accounts = data.accounts;
    const body = $("#accountsBody");
    const empty = $("#accountsEmpty");
    if (!accounts.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = accounts.map(function (account) {
      const roleText = account.role === "admin" ? "管理员" : "学徒";
      const typeText = account.numberType === "staff" ? "工号" : "学号";
      return "<tr>" +
        '<td><strong class="admin-number">' + escapeHtml(account.number) + "</strong></td>" +
        '<td><div class="admin-person">' + avatar(account.name) +
        '<div><strong>' + escapeHtml(account.name) + "</strong><span>" + typeText + "</span></div></div></td>" +
        "<td>" + roleText + "</td>" +
        "<td>" + statusBadge("account", account.status) + "</td>" +
        '<td><div class="admin-time"><strong>' + (account.lastLoginAt ? formatDateTime(account.lastLoginAt) : "从未登录") + "</strong></div></td>" +
        '<td><div class="admin-row-actions">' +
        '<button class="admin-row-btn" type="button" data-account-action="reset" data-id="' + account.id + '" data-name="' + escapeHtml(account.name) + '"><svg class="icon"><use href="#i-key"></use></svg>重置密码</button>' +
        (account.status === "active" ?
          '<button class="admin-row-btn is-danger" type="button" data-account-action="disable" data-id="' + account.id + '">停用</button>' :
          '<button class="admin-row-btn" type="button" data-account-action="enable" data-id="' + account.id + '">启用</button>') +
        "</div></td></tr>";
    }).join("");
  }

  async function openAccountModal() {
    $("#accountForm").reset();
    $("#accountHint").textContent = "注册后会显示账号和初始密码";
    openModal("accountModal");
  }

  async function submitAccount(event) {
    event.preventDefault();
    const name = $("#accountName").value.trim();
    const role = $("#accountRole").value;
    const password = $("#accountPassword").value;
    if (!name) {
      showToast("请填写姓名", "", "warning");
      $("#accountName").focus();
      return;
    }
    if (password && (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))) {
      showToast("密码不符合要求", "至少 8 位，并包含字母和数字", "warning");
      return;
    }
    const button = $("#accountSubmit");
    button.disabled = true;
    button.textContent = "正在注册…";
    try {
      const data = await request("/api/admin/accounts", {
        method: "POST",
        body: JSON.stringify({ displayName: name, role, password })
      });
      closeModal("accountModal");
      showResult(data.account, data.initialPassword, "账号已创建");
      await loadAccounts();
    } catch (error) {
      showToast("注册失败", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "确认注册";
    }
  }

  async function resetAccountPassword(id, name) {
    if (!window.confirm("确定要重置 " + name + " 的密码吗？对方现有登录会立即失效。")) {
      return;
    }
    try {
      const data = await request("/api/admin/accounts/" + id + "/reset-password", { method: "POST" });
      showResult(data.account, data.initialPassword, "密码已重置");
      await loadAccounts();
    } catch (error) {
      showToast("重置失败", error.message, "error");
    }
  }

  async function toggleAccount(id, status) {
    const label = status === "disabled" ? "停用" : "启用";
    if (!window.confirm("确定要" + label + "这个账号吗？")) {
      return;
    }
    try {
      await request("/api/admin/accounts/" + id + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      showToast("账号已" + label, "", "success");
      await loadAccounts();
    } catch (error) {
      showToast(label + "失败", error.message, "error");
    }
  }

  /* ---------------- attendance ---------------- */

  function attendanceQuery() {
    const params = new URLSearchParams();
    if ($("#attendanceFrom").value) params.set("from", $("#attendanceFrom").value);
    if ($("#attendanceTo").value) params.set("to", $("#attendanceTo").value);
    if ($("#attendanceStatus").value !== "all") params.set("status", $("#attendanceStatus").value);
    const q = $("#attendanceSearch").value.trim();
    if (q) params.set("q", q);
    return params.toString();
  }

  async function loadAttendance() {
    const data = await request("/api/admin/attendance?" + attendanceQuery());
    const records = data.records;
    const body = $("#attendanceBody");
    const empty = $("#attendanceEmpty");
    if (!records.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = records.map(function (record) {
      const location = record.checkInLocation.address ||
        (record.checkInLocation.lat == null ? "未记录" :
          record.checkInLocation.lat.toFixed(5) + ", " + record.checkInLocation.lng.toFixed(5));
      return "<tr>" +
        '<td><div class="admin-person">' + avatar(record.name) +
        '<div><strong>' + escapeHtml(record.name) + "</strong><span>" + escapeHtml(record.number) + "</span></div></div></td>" +
        '<td><div class="admin-time"><strong>' + formatDateTime(record.checkInAt) + "</strong></div></td>" +
        '<td><div class="admin-time"><strong>' + formatDateTime(record.checkOutAt) + "</strong></div></td>" +
        '<td><div class="admin-time"><strong>' + formatDuration(record.durationSeconds) + "</strong></div></td>" +
        '<td><div class="admin-audit-detail" title="' + escapeHtml(location) + '">' + escapeHtml(location) + "</div></td>" +
        "<td>" + statusBadge("attendance", record.status) + "</td>" +
        '<td><div class="admin-row-actions">' +
        (record.status === "voided" ? '<span class="muted">—</span>' :
          '<button class="admin-row-btn is-danger" type="button" data-void-id="' + record.id + '">作废</button>') +
        "</div></td></tr>";
    }).join("");
  }

  function exportAttendance() {
    window.location.href = "/api/admin/attendance/export?" + attendanceQuery();
  }

  async function voidAttendance(id) {
    if (!window.confirm("确定要作废这条考勤记录吗？作废后会保留审计记录。")) {
      return;
    }
    try {
      await request("/api/admin/attendance/" + id + "/void", {
        method: "PATCH",
        body: JSON.stringify({ note: "管理员作废" })
      });
      showToast("记录已作废", "", "success");
      await loadAttendance();
    } catch (error) {
      showToast("作废失败", error.message, "error");
    }
  }

  /* ---------------- durations ---------------- */

  function durationQuery() {
    const params = new URLSearchParams();
    if ($("#durationFrom").value) params.set("from", $("#durationFrom").value);
    if ($("#durationTo").value) params.set("to", $("#durationTo").value);
    return params.toString();
  }

  async function loadDurations() {
    const data = await request("/api/admin/durations?" + durationQuery());
    $("#durationTotal").textContent = formatHours(data.totalSeconds) + " 小时";
    $("#durationSessions").textContent = data.totalSessions + " 次";
    const body = $("#durationsBody");
    const empty = $("#durationsEmpty");
    if (!data.rows.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = data.rows.map(function (row) {
      return "<tr>" +
        '<td><div class="admin-person">' + avatar(row.name) +
        '<div><strong>' + escapeHtml(row.name) + "</strong></div></div></td>" +
        "<td><strong class=\"admin-number\">" + escapeHtml(row.number) + "</strong></td>" +
        "<td>" + row.sessions + " 次</td>" +
        '<td><strong class="admin-duration-value">' + formatDuration(row.totalSeconds) + "</strong></td>" +
        '<td><div class="admin-time"><strong>' + formatDateTime(row.lastCheckInAt) + "</strong></div></td>" +
        "</tr>";
    }).join("");
  }

  /* ---------------- tasks ---------------- */

  function taskQuery() {
    const params = new URLSearchParams();
    if ($("#taskStatusFilter").value !== "all") {
      params.set("status", $("#taskStatusFilter").value);
    }
    const q = $("#taskSearch").value.trim();
    if (q) params.set("q", q);
    return params.toString();
  }

  async function loadTasks() {
    const data = await request("/api/admin/tasks?" + taskQuery());
    const tasks = data.tasks;
    const body = $("#tasksBody");
    const empty = $("#tasksEmpty");
    if (!tasks.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = tasks.map(function (task) {
      return "<tr>" +
        '<td><div class="admin-task-title"><strong>' + escapeHtml(task.title) + "</strong><span>" +
        (task.description ? escapeHtml(task.description) : "无说明") + "</span></div></td>" +
        '<td><div class="admin-person">' + avatar(task.assignedName) +
        '<div><strong>' + escapeHtml(task.assignedName) + "</strong><span>" + escapeHtml(task.assignedNumber) + "</span></div></div></td>" +
        "<td>" + priorityBadge(task.priority) + "</td>" +
        '<td><div class="admin-time"><strong>' + (task.dueAt ? formatDateTime(task.dueAt) : "无截止") +
        "</strong>" + (task.overdue ? '<span class="admin-overdue-text">已逾期</span>' : "") + "</div></td>" +
        "<td>" + statusBadge("task", task.status) + "</td>" +
        '<td><span class="admin-audit-detail">' + escapeHtml(task.createdByName) + "</span></td>" +
        '<td><div class="admin-row-actions">' +
        (["pending", "in_progress"].includes(task.status) ?
          '<button class="admin-row-btn is-danger" type="button" data-cancel-task="' + task.id + '">取消</button>' :
          '<span class="muted">—</span>') +
        "</div></td></tr>";
    }).join("");
  }

  async function loadAssignees() {
    const data = await request("/api/admin/accounts?role=apprentice&status=active");
    state.assignees = data.accounts;
    return data.accounts;
  }

  async function openTaskModal() {
    try {
      const assignees = await loadAssignees();
      if (!assignees.length) {
        showToast("还没有可分配任务的学徒", "请先在账号管理中注册学徒账号", "warning");
        return;
      }
      $("#taskForm").reset();
      $("#taskPriority").value = "normal";
      $("#taskAssignee").innerHTML = assignees.map(function (account) {
        return '<option value="' + account.id + '">' + escapeHtml(account.name) + " · " +
          escapeHtml(account.number) + "</option>";
      }).join("");
      openModal("taskModal");
    } catch (error) {
      showToast("无法打开任务窗口", error.message, "error");
    }
  }

  async function submitTask(event) {
    event.preventDefault();
    const title = $("#taskTitle").value.trim();
    const description = $("#taskDescription").value.trim();
    const assignedTo = Number($("#taskAssignee").value);
    const priority = $("#taskPriority").value;
    const dueValue = $("#taskDueAt").value;
    if (!title || !assignedTo) {
      showToast("请填写任务标题并选择学徒", "", "warning");
      return;
    }
    let dueAt = null;
    if (dueValue) {
      const parsed = new Date(dueValue);
      if (Number.isNaN(parsed.getTime())) {
        showToast("截止时间无效", "", "warning");
        return;
      }
      dueAt = parsed.toISOString();
    }
    const button = $("#taskSubmit");
    button.disabled = true;
    button.textContent = "正在发布…";
    try {
      await request("/api/admin/tasks", {
        method: "POST",
        body: JSON.stringify({ title, description, assignedTo, priority, dueAt })
      });
      closeModal("taskModal");
      showToast("任务已发布", "学徒端会立即看到这条任务", "success");
      await loadTasks();
      if (state.view === "overview") {
        await loadOverview();
      }
    } catch (error) {
      showToast("发布失败", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "发布任务";
    }
  }

  async function cancelTask(id) {
    if (!window.confirm("确定取消这个任务吗？")) {
      return;
    }
    try {
      await request("/api/admin/tasks/" + id + "/cancel", { method: "PATCH" });
      showToast("任务已取消", "", "success");
      await loadTasks();
    } catch (error) {
      showToast("取消失败", error.message, "error");
    }
  }

  /* ---------------- audit ---------------- */

  async function loadAudit() {
    const data = await request("/api/admin/audit");
    const body = $("#auditBody");
    const empty = $("#auditEmpty");
    if (!data.logs.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = data.logs.map(function (log) {
      return "<tr>" +
        '<td><div class="admin-time"><strong>' + formatDateTime(log.createdAt) + "</strong></div></td>" +
        '<td><div class="admin-person"><div><strong>' + escapeHtml(log.actorName) + "</strong><span>" +
        escapeHtml(log.actorNumber) + "</span></div></div></td>" +
        "<td><code class=\"admin-action-code\">" + escapeHtml(log.action) + "</code></td>" +
        "<td>" + escapeHtml(log.targetType) + (log.targetId ? " #" + log.targetId : "") + "</td>" +
        '<td><div class="admin-audit-detail" title="' + escapeHtml(JSON.stringify(log.detail || {})) + '">' +
        escapeHtml(log.detail ? JSON.stringify(log.detail) : "—") + "</div></td>" +
        '<td><span class="admin-audit-detail">' + escapeHtml(log.ip || "—") + "</span></td></tr>";
    }).join("");
  }

  /* ---------------- result / modals ---------------- */

  function showResult(account, password, title) {
    $("#resultTitle").textContent = title;
    const rows = [
      ["姓名", account.name || account.display_name || "—", false],
      ["学号 / 工号", account.number, false],
      ["账号类型", account.role === "admin" ? "管理员" : "学徒", false]
    ];
    if (password) {
      rows.push(["初始密码", password, true]);
    } else {
      rows.push(["初始密码", "使用管理员设置的密码", false]);
    }
    $("#resultBox").innerHTML = rows.map(function (row) {
      return '<div class="result-row"><span>' + row[0] + "</span><strong class=\"" +
        (row[2] ? "is-password" : "") + "\">" + escapeHtml(row[1]) + "</strong></div>";
    }).join("");
    state.resultText = rows.map(function (row) { return row[0] + "：" + row[1]; }).join("\n");
    openModal("resultModal");
  }

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(state.resultText);
      showToast("账号信息已复制", "", "success");
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = state.resultText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      showToast("账号信息已复制", "", "success");
    }
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    $$(".admin-nav-btn").forEach(function (button) {
      button.addEventListener("click", function () {
        go(button.getAttribute("data-view"));
      });
    });

    $$("[data-goto]").forEach(function (button) {
      button.addEventListener("click", function () {
        go(button.getAttribute("data-goto"));
      });
    });

    $("#adminToday").textContent = new Date().toLocaleDateString("zh-CN", {
      year: "numeric", month: "long", day: "numeric", weekday: "long"
    });

    async function logout() {
      try {
        await request("/api/auth/logout", { method: "POST" });
      } catch (error) {
        /* navigate anyway */
      }
      window.location.href = "/login";
    }

    $("#logoutBtn").addEventListener("click", logout);
    $("#topLogoutBtn").addEventListener("click", logout);

    $("#topChangePasswordBtn").addEventListener("click", function () {
      $("#adminPasswordForm").reset();
      $("#adminPasswordHint").textContent = "修改后请使用新密码登录";
      $("#adminPasswordHint").className = "submit-hint";
      openModal("adminPasswordModal");
    });

    $("#adminPasswordForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      const currentPassword = $("#adminCurrentPassword").value;
      const newPassword = $("#adminNewPassword").value;
      const confirm = $("#adminConfirmPassword").value;
      if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        showToast("密码不符合要求", "至少 8 位，并包含字母和数字", "warning");
        return;
      }
      if (newPassword !== confirm) {
        showToast("两次输入的新密码不一致", "", "warning");
        return;
      }
      const button = $("#adminPasswordSubmit");
      button.disabled = true;
      button.textContent = "正在保存…";
      try {
        await request("/api/auth/change-password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword })
        });
        closeModal("adminPasswordModal");
        showToast("密码已修改", "其他设备的登录已失效", "success");
      } catch (error) {
        $("#adminPasswordHint").textContent = error.message;
        $("#adminPasswordHint").className = "submit-hint is-error";
      } finally {
        button.disabled = false;
        button.textContent = "保存新密码";
      }
    });

    $("#topRefreshBtn").addEventListener("click", function () {
      loadView(state.view).catch(function (error) { setError(error.message); });
    });

    $("#topCreateTaskBtn").addEventListener("click", openTaskModal);
    $("#createTaskBtn").addEventListener("click", openTaskModal);
    $("#createAccountBtn").addEventListener("click", openAccountModal);
    $("#accountForm").addEventListener("submit", submitAccount);
    $("#taskForm").addEventListener("submit", submitTask);
    $("#copyResultBtn").addEventListener("click", copyResult);

    $("#accountSearch").addEventListener("input", debounce(loadAccounts, 180));
    $("#accountRoleFilter").addEventListener("click", function (event) {
      const button = event.target.closest("[data-role]");
      if (!button) return;
      state.accountRole = button.getAttribute("data-role");
      $$("[data-role]", $("#accountRoleFilter")).forEach(function (item) {
        item.classList.toggle("is-active", item === button);
      });
      loadAccounts().catch(function (error) { setError(error.message); });
    });
    $("#refreshAccounts").addEventListener("click", function () {
      loadAccounts().catch(function (error) { setError(error.message); });
    });
    $("#accountsBody").addEventListener("click", function (event) {
      const button = event.target.closest("[data-account-action]");
      if (!button) return;
      const id = button.getAttribute("data-id");
      const action = button.getAttribute("data-account-action");
      if (action === "reset") {
        resetAccountPassword(id, button.getAttribute("data-name"));
      } else if (action === "disable") {
        toggleAccount(id, "disabled");
      } else if (action === "enable") {
        toggleAccount(id, "active");
      }
    });

    $("#attendanceStatus").addEventListener("change", function () {
      loadAttendance().catch(function (error) { setError(error.message); });
    });
    $("#attendanceFrom").addEventListener("change", function () {
      loadAttendance().catch(function (error) { setError(error.message); });
    });
    $("#attendanceTo").addEventListener("change", function () {
      loadAttendance().catch(function (error) { setError(error.message); });
    });
    $("#attendanceSearch").addEventListener("input", debounce(loadAttendance, 220));
    $("#refreshAttendance").addEventListener("click", function () {
      loadAttendance().catch(function (error) { setError(error.message); });
    });
    $("#exportAttendance").addEventListener("click", exportAttendance);
    $("#attendanceBody").addEventListener("click", function (event) {
      const button = event.target.closest("[data-void-id]");
      if (button) {
        voidAttendance(button.getAttribute("data-void-id"));
      }
    });

    $("#refreshDurations").addEventListener("click", function () {
      loadDurations().catch(function (error) { setError(error.message); });
    });
    $("#durationFrom").addEventListener("change", function () {
      loadDurations().catch(function (error) { setError(error.message); });
    });
    $("#durationTo").addEventListener("change", function () {
      loadDurations().catch(function (error) { setError(error.message); });
    });

    $("#taskStatusFilter").addEventListener("change", function () {
      loadTasks().catch(function (error) { setError(error.message); });
    });
    $("#taskSearch").addEventListener("input", debounce(loadTasks, 220));
    $("#refreshTasks").addEventListener("click", function () {
      loadTasks().catch(function (error) { setError(error.message); });
    });
    $("#tasksBody").addEventListener("click", function (event) {
      const button = event.target.closest("[data-cancel-task]");
      if (button) {
        cancelTask(button.getAttribute("data-cancel-task"));
      }
    });

    document.addEventListener("click", function (event) {
      const close = event.target.closest("[data-close]");
      if (close) {
        closeModal(close.getAttribute("data-close"));
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        const open = $$(".modal.is-open").pop();
        if (open) {
          closeModal(open.id);
        }
      }
    });

    window.addEventListener("hashchange", function () {
      navigate(viewFromHash()).catch(function (error) { setError(error.message); });
    });
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        fn().catch(function (error) { setError(error.message); });
      }, wait);
    };
  }

  function setDefaultDates() {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    ["attendanceFrom", "durationFrom"].forEach(function (id) {
      $("#" + id).value = toDateInput(weekAgo);
    });
    ["attendanceTo", "durationTo"].forEach(function (id) {
      $("#" + id).value = toDateInput(today);
    });
  }

  async function init() {
    try {
      const me = await request("/api/me");
      if (!me.user || me.user.role !== "admin") {
        window.location.href = me.user && me.user.role === "apprentice" ? "/" : "/login";
        return;
      }
      if (me.user.mustChangePassword) {
        window.location.href = "/login?change=1";
        return;
      }
      state.user = me.user;
      $("#adminName").textContent = me.user.name;
      $("#adminNumber").textContent = me.user.number;
      $("#adminAvatar").textContent = initialOf(me.user.name);
      setDefaultDates();
      bindEvents();
      await navigate(viewFromHash());
    } catch (error) {
      if (!error.message.includes("请先登录")) {
        setError(error.message);
      }
    }
  }

  window.addEventListener("DOMContentLoaded", init);
})();
