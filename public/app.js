(function () {
  "use strict";

  const LAST_LOCATION_KEY = "apprenticeAttendance.lastLocation";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  const state = {
    user: null,
    activeRecord: null,
    stats: null,
    records: [],
    tasks: [],
    filters: { range: "today", status: "all", query: "", task: "all" },
    maps: {},
    locations: { hero: null, checkin: null, checkout: null },
    tokens: { hero: 0, checkin: 0, checkout: 0 },
    locating: { hero: false, checkin: false, checkout: false },
    checkinSubmitting: false,
    checkoutSubmitting: false,
    viewingRecordId: null,
    viewingType: "in",
    geocodeCache: new Map(),
    lastDay: "",
    clockTimer: 0
  };

  const el = {};
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

  function formatTime(value) {
    if (!value) {
      return "—";
    }
    const date = new Date(value);
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
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

  function formatFullDate(date) {
    return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日 " +
      WEEKDAYS[date.getDay()];
  }

  function formatDayLabel(value) {
    const date = new Date(value);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diff = Math.round((today - day) / DAY_MS);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    return (date.getMonth() + 1) + "月" + date.getDate() + "日";
  }

  function formatDuration(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) {
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

  function durationParts(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    if (total >= 3600) {
      return { value: (total / 3600).toFixed(1), unit: "小时" };
    }
    return { value: String(Math.round(total / 60)), unit: "分钟" };
  }

  function formatAccuracy(value) {
    const accuracy = Number(value);
    if (!Number.isFinite(accuracy) || accuracy <= 0) {
      return "精度未知";
    }
    return accuracy < 1000 ? "± " + Math.round(accuracy) + " 米" :
      "± " + (accuracy / 1000).toFixed(1) + " 公里";
  }

  function formatCoord(location) {
    if (!location || location.lat == null || location.lng == null) {
      return "—";
    }
    return Math.abs(location.lat).toFixed(5) + "°" + (location.lat >= 0 ? "N" : "S") + " · " +
      Math.abs(location.lng).toFixed(5) + "°" + (location.lng >= 0 ? "E" : "W");
  }

  function locationText(location) {
    if (!location) {
      return "未记录";
    }
    return location.address || formatCoord(location);
  }

  function initialOf(name) {
    return Array.from(String(name || "").trim())[0] || "学";
  }

  function avatarTone(name) {
    let total = 0;
    for (const character of String(name || "")) {
      total += character.charCodeAt(0);
    }
    return total % 5;
  }

  function relativeTime(value) {
    if (!value) {
      return "";
    }
    const diff = Math.max(0, Date.now() - new Date(value).getTime());
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " 分钟前";
    if (formatDayLabel(value) === "今天") return "今天 " + formatTime(value);
    return formatDayLabel(value) + " " + formatTime(value);
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

  function cacheElements() {
    el.header = $("#siteHeader");
    el.headerClock = $("#headerClock");
    el.headerAvatar = $("#headerAvatar");
    el.headerName = $("#headerName");
    el.headerNumber = $("#headerNumber");
    el.heroDate = $("#heroDate");
    el.heroName = $("#heroName");
    el.heroAvatar = $("#heroAvatar");
    el.heroStatus = $("#heroStatus");
    el.heroHint = $("#heroHint");
    el.checkinBtn = $("#checkinBtn");
    el.checkoutBtn = $("#checkoutBtn");
    el.locateBtn = $("#locateBtn");
    el.locateTextBtn = $("#locateTextBtn");
    el.heroMap = $("#heroMap");
    el.mapBadgeText = $("#mapBadgeText");
    el.mapStatusDot = $("#mapStatusDot");
    el.heroAddress = $("#heroAddress");
    el.heroCoords = $("#heroCoords");
    el.heroAccuracy = $("#heroAccuracy");

    el.statCheckins = $("#statCheckins");
    el.statCheckinsFoot = $("#statCheckinsFoot");
    el.statSpark = $("#statSpark");
    el.statCheckouts = $("#statCheckouts");
    el.statCheckoutsFoot = $("#statCheckoutsFoot");
    el.statTodayDuration = $("#statTodayDuration");
    el.statTodayUnit = $("#statTodayUnit");
    el.statTodayFoot = $("#statTodayFoot");
    el.statWeekDuration = $("#statWeekDuration");
    el.statWeekUnit = $("#statWeekUnit");
    el.statWeekFoot = $("#statWeekFoot");

    el.searchInput = $("#searchInput");
    el.statusFilter = $("#statusFilter");
    el.rangeFilter = $("#rangeFilter");
    el.recordCount = $("#recordCount");
    el.shownCount = $("#shownCount");
    el.totalCount = $("#totalCount");
    el.filterSummary = $("#filterSummary");
    el.tableScroll = $("#tableScroll");
    el.recordsBody = $("#recordsBody");
    el.emptyState = $("#emptyState");
    el.emptyTitle = $("#emptyTitle");
    el.emptyText = $("#emptyText");
    el.emptyCheckinBtn = $("#emptyCheckinBtn");
    el.exportBtn = $("#exportBtn");
    el.taskFilter = $("#taskFilter");
    el.tasksList = $("#tasksList");
    el.tasksEmpty = $("#tasksEmpty");

    el.checkinModal = $("#checkinModal");
    el.checkinForm = $("#checkinForm");
    el.checkinAvatar = $("#checkinAvatar");
    el.checkinName = $("#checkinName");
    el.checkinNumber = $("#checkinNumber");
    el.checkinMap = $("#checkinMap");
    el.checkinLocStatus = $("#checkinLocStatus");
    el.checkinAddress = $("#checkinAddress");
    el.checkinCoords = $("#checkinCoords");
    el.checkinAccuracy = $("#checkinAccuracy");
    el.refreshCheckinLoc = $("#refreshCheckinLoc");
    el.checkinSubmit = $("#checkinSubmit");
    el.checkinHint = $("#checkinHint");

    el.checkoutModal = $("#checkoutModal");
    el.checkoutForm = $("#checkoutForm");
    el.checkoutSummary = $("#checkoutSummary");
    el.checkoutMap = $("#checkoutMap");
    el.checkoutLocStatus = $("#checkoutLocStatus");
    el.checkoutAddress = $("#checkoutAddress");
    el.checkoutCoords = $("#checkoutCoords");
    el.checkoutAccuracy = $("#checkoutAccuracy");
    el.refreshCheckoutLoc = $("#refreshCheckoutLoc");
    el.checkoutSubmit = $("#checkoutSubmit");
    el.checkoutHint = $("#checkoutHint");

    el.locationModal = $("#locationModal");
    el.locationSubtitle = $("#locationSubtitle");
    el.locationTabs = $("#locationTabs");
    el.locationMap = $("#locationMap");
    el.locationAddress = $("#locationAddress");
    el.locationCoords = $("#locationCoords");
    el.locationType = $("#locationType");
    el.locationTime = $("#locationTime");
    el.locationAccuracy = $("#locationAccuracy");
    el.locationOsmLink = $("#locationOsmLink");

    el.passwordModal = $("#passwordModal");
    el.passwordForm = $("#passwordForm");
    el.currentPassword = $("#currentPassword");
    el.newPassword = $("#newPassword");
    el.confirmPassword = $("#confirmPassword");
    el.passwordSubmit = $("#passwordSubmit");
    el.passwordHint = $("#passwordHint");

    el.changePasswordBtn = $("#changePasswordBtn");
    el.logoutBtn = $("#logoutBtn");
    el.toastContainer = $("#toastContainer");
    el.footerYear = $("#footerYear");
  }

  function setUserInterface(user) {
    state.user = user;
    el.headerName.textContent = user.name;
    el.headerNumber.textContent = user.number;
    el.headerAvatar.textContent = initialOf(user.name);
    el.headerAvatar.className = "avatar user-avatar avatar-tone-" + avatarTone(user.name);
    el.heroName.textContent = user.name;
    el.heroAvatar.textContent = initialOf(user.name);
    el.heroAvatar.className = "avatar avatar-tone-" + avatarTone(user.name);
    el.checkinAvatar.textContent = initialOf(user.name);
    el.checkinAvatar.className = "person-avatar avatar-tone-" + avatarTone(user.name);
    el.checkinName.textContent = user.name;
    el.checkinNumber.textContent = user.number;
  }

  async function init() {
    cacheElements();
    startClock();
    setupScrollBehaviour();
    bindEvents();

    try {
      const me = await request("/api/me");
      if (!me.user) {
        window.location.href = "/login";
        return;
      }
      if (me.user.role === "admin") {
        window.location.href = "/admin";
        return;
      }
      if (me.user.mustChangePassword) {
        window.location.href = "/login?change=1";
        return;
      }
      setUserInterface(me.user);
      setupHeroMap();
      await refreshAll();
    } catch (error) {
      if (!error.message.includes("请先登录")) {
        showToast("页面加载失败", error.message, "error");
      }
    }
  }

  async function refreshAll() {
    await Promise.all([loadDashboard(), loadAttendance()]);
  }

  async function loadDashboard() {
    const data = await request("/api/dashboard");
    state.stats = data.stats;
    state.activeRecord = data.activeRecord;
    state.tasks = data.tasks || [];
    renderStats(data.daily || []);
    renderHeroState();
    renderTasks();
  }

  function renderStats(daily) {
    const stats = state.stats || {};
    el.statCheckins.textContent = stats.todayCheckins || 0;
    el.statCheckouts.textContent = stats.todayCheckouts || 0;
    el.statCheckinsFoot.textContent = stats.todayCheckins
      ? "今日已签到 " + stats.todayCheckins + " 人次"
      : "今天还未签到";
    el.statCheckoutsFoot.textContent = stats.todayCheckouts
      ? "今日已完成 " + stats.todayCheckouts + " 次签退"
      : "还没有签退记录";

    const today = durationParts(stats.todaySeconds || 0);
    el.statTodayDuration.textContent = today.value;
    el.statTodayUnit.textContent = today.unit;
    el.statTodayFoot.textContent = state.activeRecord ? "含进行中的本次签到" : "签到后开始累计";

    const week = durationParts(stats.weekSeconds || 0);
    el.statWeekDuration.textContent = week.value;
    el.statWeekUnit.textContent = week.unit;
    el.statWeekFoot.textContent = "近 7 天 · " + (stats.weekSessions || 0) + " 次签到";

    const counts = (daily || []).map(function (item) { return Number(item.checkins) || 0; });
    const maximum = Math.max.apply(null, counts.concat([1]));
    el.statSpark.innerHTML = counts.map(function (count, index) {
      const height = 4 + Math.round(count / maximum * 17);
      return '<span style="height:' + height + 'px" title="' + escapeHtml(daily[index].date) + " · " +
        count + ' 人次"></span>';
    }).join("");
  }

  function renderHeroState() {
    const active = state.activeRecord;
    el.checkinBtn.disabled = Boolean(active);
    el.checkoutBtn.disabled = !active;
    el.checkinBtn.classList.toggle("btn-primary", !active);
    el.checkinBtn.classList.toggle("btn-outline", Boolean(active));
    el.checkoutBtn.classList.toggle("btn-primary", Boolean(active));
    el.checkoutBtn.classList.toggle("btn-outline", !active);
    el.checkinBtn.innerHTML = active
      ? '<svg class="icon"><use href="#i-check"></use></svg>已签到'
      : '<span class="btn-icon-wrap"><svg class="icon"><use href="#i-check"></use></svg></span>学徒签到';

    if (active) {
      el.heroStatus.textContent = "当前在校 · " + formatTime(active.checkInAt) + " 签到";
      el.heroHint.textContent = "本次已在校 " + formatDuration(Math.max(0, (Date.now() - new Date(active.checkInAt).getTime()) / 1000));
    } else {
      el.heroStatus.textContent = "当前未在校";
      el.heroHint.textContent = "今天已签到 " + ((state.stats && state.stats.todayCheckins) || 0) + " 人次";
    }
  }

  async function loadAttendance() {
    const params = new URLSearchParams();
    params.set("range", state.filters.range);
    params.set("status", state.filters.status);
    if (state.filters.query.trim()) {
      params.set("q", state.filters.query.trim());
    }
    const data = await request("/api/attendance?" + params.toString());
    state.records = data.records || [];
    state.totalRecords = data.total || state.records.length;
    renderRecords();
  }

  function renderRecords() {
    const records = state.records;
    el.recordsBody.innerHTML = records.map(recordRowMarkup).join("");
    el.recordCount.textContent = records.length;
    el.shownCount.textContent = records.length;
    el.totalCount.textContent = state.totalRecords == null ? records.length : state.totalRecords;
    el.tableScroll.hidden = records.length === 0;
    el.emptyState.hidden = records.length > 0;
    el.emptyCheckinBtn.hidden = Boolean(state.activeRecord);
    el.filterSummary.textContent = rangeLabel() + " · " + statusLabel();
    if (!records.length) {
      el.emptyTitle.textContent = "当前筛选下没有记录";
      el.emptyText.textContent = state.filters.query
        ? "换一个关键词或调整筛选条件试试。"
        : "到校后点击「学徒签到」，考勤记录会出现在这里。";
    }
    updateLiveDurations();
  }

  function recordRowMarkup(record) {
    const active = record.status === "active";
    const location = record.checkInLocation;
    const hasLocation = location && location.lat != null;
    const locationLabel = hasLocation ? locationText(location) : "未记录";
    const statusClass = record.status === "active" ? "is-active" :
      record.status === "completed" ? "is-done" : "is-done";
    const statusText = record.status === "active" ? "在校中" :
      record.status === "completed" ? "已签退" : "已作废";
    let action = "";
    if (active) {
      action = '<button class="row-action is-primary" type="button" data-action="checkout" data-id="' +
        record.id + '">签退</button>';
    } else if (hasLocation || (record.checkOutLocation && record.checkOutLocation.lat != null)) {
      action = '<button class="row-action" type="button" data-action="location" data-id="' +
        record.id + '">位置</button>';
    }
    return "<tr>" +
      '<td><div class="time-cell"><strong>' + formatTime(record.checkInAt) + '</strong><span>' +
      escapeHtml(formatDayLabel(record.checkInAt)) + "</span></div></td>" +
      '<td><div class="time-cell"><strong>' + formatTime(record.checkOutAt) + "</strong><span>" +
      (record.checkOutAt ? escapeHtml(formatDayLabel(record.checkOutAt)) : "—") + "</span></div></td>" +
      '<td><div class="duration-cell"><span class="duration-value"' +
      (active ? ' data-live-duration="' + record.id + '"' : "") + ">" +
      escapeHtml(formatDuration(record.durationSeconds)) + "</span>" +
      (active ? '<span class="live-flag">进行中</span>' : "") + "</div></td>" +
      "<td>" + (hasLocation
        ? '<button class="record-location" type="button" data-action="location" data-id="' + record.id +
        '" title="' + escapeHtml(locationLabel) + '"><svg class="icon"><use href="#i-pin"></use></svg><span>' +
        escapeHtml(locationLabel) + "</span></button>"
        : '<span class="muted">未记录</span>') + "</td>" +
      '<td><span class="status-pill ' + statusClass + '">' + statusText + "</span></td>" +
      '<td><div class="row-actions">' + (action || '<span class="muted">—</span>') + "</div></td>" +
      "</tr>";
  }

  function rangeLabel() {
    return { today: "今天", week: "近 7 天", month: "近 30 天", all: "全部时间" }[state.filters.range];
  }

  function statusLabel() {
    return { all: "全部状态", active: "在校中", completed: "已签退" }[state.filters.status];
  }

  function updateLiveDurations() {
    const now = Date.now();
    $$("[data-live-duration]").forEach(function (node) {
      const record = state.records.find(function (item) {
        return String(item.id) === node.getAttribute("data-live-duration");
      });
      if (record && record.status === "active") {
        node.textContent = formatDuration(Math.max(0, (now - new Date(record.checkInAt).getTime()) / 1000));
      }
    });
    const checkoutElapsed = $("#checkoutElapsed");
    if (checkoutElapsed && state.activeRecord) {
      checkoutElapsed.textContent = formatDuration(Math.max(0, (now - new Date(state.activeRecord.checkInAt).getTime()) / 1000));
    }
    if (state.activeRecord) {
      el.heroHint.textContent = "本次已在校 " + formatDuration(Math.max(0, (now - new Date(state.activeRecord.checkInAt).getTime()) / 1000));
    }
  }

  function renderTasks() {
    const filter = state.filters.task;
    const tasks = state.tasks.filter(function (task) {
      return filter === "all" || task.status === filter;
    });
    el.tasksList.innerHTML = tasks.map(taskCardMarkup).join("");
    el.tasksEmpty.hidden = tasks.length > 0;
    $$("[data-task-status]", el.taskFilter).forEach(function (button) {
      const active = button.getAttribute("data-task-status") === filter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function taskCardMarkup(task) {
    const priorityLabel = { high: "优先", normal: "普通", low: "较低" }[task.priority] || task.priority;
    const statusText = { pending: "待开始", in_progress: "进行中", completed: "已完成" }[task.status] || task.status;
    const stateClass = task.overdue && task.status !== "completed" ? "state-overdue" : "state-" + task.status;
    let action = "";
    let doneText = "";
    if (task.status === "pending") {
      action = '<button class="btn btn-primary btn-sm" type="button" data-task-action="start" data-id="' +
        task.id + '">开始任务</button>';
    } else if (task.status === "in_progress") {
      action = '<button class="btn btn-primary btn-sm" type="button" data-task-action="complete" data-id="' +
        task.id + '">完成任务</button>';
    } else if (task.completedAt) {
      doneText = "完成于 " + formatDateTime(task.completedAt);
    }
    return '<article class="task-card priority-' + escapeHtml(task.priority) +
      (task.status === "completed" ? " is-completed" : "") +
      (task.overdue && task.status !== "completed" ? " is-overdue" : "") + '">' +
      '<div class="task-top"><span class="task-priority priority-' + escapeHtml(task.priority) + '">' +
      escapeHtml(priorityLabel) + '</span><span class="task-state ' + stateClass + '">' +
      (task.overdue && task.status !== "completed" ? "已逾期" : statusText) + "</span></div>" +
      "<h3>" + escapeHtml(task.title) + "</h3>" +
      "<p>" + escapeHtml(task.description || "暂无任务说明") + "</p>" +
      '<div class="task-meta"><span><svg class="icon"><use href="#i-calendar"></use></svg>截止 ' +
      (task.dueAt ? formatDateTime(task.dueAt) : "未设置") + "</span><span>发布 " +
      formatDateTime(task.createdAt) + "</span></div>" +
      '<div class="task-card-foot"><span class="task-done-text">' + escapeHtml(doneText) + "</span>" +
      action + "</div></article>";
  }

  async function updateTask(taskId, status) {
    const button = document.querySelector('[data-task-action][data-id="' + taskId + '"]');
    if (button) {
      button.disabled = true;
      button.textContent = status === "completed" ? "正在完成…" : "正在开始…";
    }
    try {
      await request("/api/tasks/" + taskId + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      showToast(status === "completed" ? "任务已完成" : "任务已开始", "状态已同步到管理员后台", "success");
      await loadDashboard();
    } catch (error) {
      showToast("任务更新失败", error.message, "error");
      if (button) {
        button.disabled = false;
        button.textContent = status === "completed" ? "完成任务" : "开始任务";
      }
    }
  }

  /* ---------------- location / map ---------------- */

  function locationStorageKey() {
    return LAST_LOCATION_KEY + (state.user ? "." + state.user.id : "");
  }

  function readCachedLocation() {
    try {
      const raw = localStorage.getItem(locationStorageKey());
      if (!raw) return null;
      const location = JSON.parse(raw);
      if (!location || location.lat == null || location.lng == null) return null;
      if (Date.now() - new Date(location.at).getTime() > DAY_MS) return null;
      return location;
    } catch (error) {
      return null;
    }
  }

  function saveCachedLocation(location) {
    try {
      localStorage.setItem(locationStorageKey(), JSON.stringify(location));
    } catch (error) {
      /* ignore */
    }
  }

  function setupHeroMap() {
    const cached = readCachedLocation();
    const map = ensureMap("hero", el.heroMap, cached, cached ? 15 : 4);
    if (!map) return;
    if (cached) {
      map.setLocation(cached.lat, cached.lng, {
        accuracy: cached.accuracy,
        zoom: 15,
        label: "上次位置"
      });
      el.mapBadgeText.textContent = "上次位置";
      el.mapStatusDot.className = "status-dot is-warn";
      updateHeroLocation(cached, true);
    } else {
      map.showEmpty("等待定位", "点击右上角获取当前位置");
      el.mapBadgeText.textContent = "等待定位";
      el.mapStatusDot.className = "status-dot is-idle";
    }
  }

  function ensureMap(key, element, center, zoom) {
    if (state.maps[key]) {
      state.maps[key].resize();
      return state.maps[key];
    }
    if (!element) return null;
    const options = {};
    if (center) options.center = { lat: center.lat, lng: center.lng };
    if (zoom) options.zoom = zoom;
    state.maps[key] = new window.LocationMap(element, options);
    return state.maps[key];
  }

  function updateHeroLocation(location, cached, addressOnly) {
    const map = state.maps.hero;
    if (map && !addressOnly) {
      map.setLocation(location.lat, location.lng, {
        accuracy: location.accuracy,
        zoom: cached ? 15 : 16,
        label: cached ? "上次位置" : "当前位置"
      });
    }
    el.heroAddress.textContent = location.address || formatCoord(location);
    el.heroAddress.title = location.address || formatCoord(location);
    el.heroCoords.textContent = formatCoord(location) + " · " + relativeTime(location.at);
    el.heroAccuracy.textContent = "定位精度 " + formatAccuracy(location.accuracy);
    if (!addressOnly) {
      el.mapBadgeText.textContent = cached ? "上次位置" : "实时定位";
      el.mapStatusDot.className = "status-dot " + (cached ? "is-warn" : "is-live");
    }
  }

  function getCurrentPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject({ code: "UNSUPPORTED", message: "浏览器不支持定位" });
        return;
      }
      if (window.isSecureContext === false) {
        reject({ code: "INSECURE", message: "请通过 localhost 打开页面" });
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, function (error) {
        reject(error);
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
    });
  }

  async function locateFor(mode) {
    const token = ++state.tokens[mode];
    state.locating[mode] = true;
    beginLocating(mode);
    try {
      const position = await getCurrentPosition();
      if (token !== state.tokens[mode]) return;
      const location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: Number(position.coords.accuracy) || null,
        address: "",
        at: new Date().toISOString()
      };
      state.locations[mode] = location;
      saveCachedLocation(location);
      applyLocation(mode, location);
      resolveAddress(mode, location);
    } catch (error) {
      if (token !== state.tokens[mode]) return;
      handleLocationError(mode, error);
    } finally {
      if (token === state.tokens[mode]) {
        state.locating[mode] = false;
        endLocating(mode);
      }
    }
  }

  function beginLocating(mode) {
    if (mode === "hero") {
      el.locateBtn.disabled = true;
      el.locateBtn.classList.add("is-loading");
      el.locateTextBtn.disabled = true;
      el.locateTextBtn.textContent = "定位中…";
      el.mapBadgeText.textContent = "正在定位";
      el.mapStatusDot.className = "status-dot is-idle";
      if (state.maps.hero && !state.maps.hero.marker) {
        state.maps.hero.setLoading("正在获取当前位置", "请允许浏览器访问当前位置");
      }
    }
    if (mode === "checkin") {
      el.checkinLocStatus.textContent = "正在获取当前位置…";
      el.checkinSubmit.disabled = true;
      el.checkinHint.textContent = "正在定位，请稍候";
      el.checkinHint.className = "submit-hint";
      if (state.maps.checkin && !state.maps.checkin.marker) {
        state.maps.checkin.setLoading("正在获取当前位置", "请允许浏览器访问当前位置");
      }
    }
    if (mode === "checkout") {
      el.checkoutLocStatus.textContent = "正在获取当前位置…";
      el.checkoutSubmit.disabled = true;
      el.checkoutHint.textContent = "正在定位，请稍候";
      el.checkoutHint.className = "submit-hint";
      if (state.maps.checkout && !state.maps.checkout.marker) {
        state.maps.checkout.setLoading("正在获取当前位置", "请允许浏览器访问当前位置");
      }
    }
  }

  function endLocating(mode) {
    if (mode === "hero") {
      el.locateBtn.disabled = false;
      el.locateBtn.classList.remove("is-loading");
      el.locateTextBtn.disabled = false;
      el.locateTextBtn.innerHTML = '获取位置 <svg class="icon"><use href="#i-arrow-right"></use></svg>';
    }
    if (mode === "checkin") {
      el.checkinSubmit.disabled = state.checkinSubmitting;
      if (state.locations.checkin) {
        el.checkinHint.textContent = "位置已记录，可以签到";
        el.checkinHint.className = "submit-hint is-ok";
      } else {
        el.checkinHint.textContent = "定位不可用，仍可正常签到";
        el.checkinHint.className = "submit-hint";
      }
    }
    if (mode === "checkout") {
      el.checkoutSubmit.disabled = state.checkoutSubmitting;
      if (state.locations.checkout) {
        el.checkoutHint.textContent = "位置已记录，可以签退";
        el.checkoutHint.className = "submit-hint is-ok";
      } else {
        el.checkoutHint.textContent = "定位不可用，仍可正常签退";
        el.checkoutHint.className = "submit-hint";
      }
    }
  }

  function applyLocation(mode, location) {
    if (mode === "hero") {
      updateHeroLocation(location, false);
      return;
    }
    if (mode === "checkin") {
      if (state.maps.checkin) {
        state.maps.checkin.setLocation(location.lat, location.lng, {
          accuracy: location.accuracy, zoom: 16, label: "签到处"
        });
      }
      el.checkinAddress.textContent = location.address || "位置已获取，地址解析中…";
      el.checkinAddress.title = location.address || "";
      el.checkinCoords.textContent = formatCoord(location) + " · " + relativeTime(location.at);
      el.checkinAccuracy.textContent = formatAccuracy(location.accuracy);
      el.checkinLocStatus.textContent = "定位成功 · " + formatTime(location.at);
      if (state.maps.hero) updateHeroLocation(location, false);
      return;
    }
    if (mode === "checkout") {
      if (state.maps.checkout) {
        state.maps.checkout.setLocation(location.lat, location.lng, {
          accuracy: location.accuracy, zoom: 16, label: "签退处"
        });
      }
      el.checkoutAddress.textContent = location.address || "位置已获取，地址解析中…";
      el.checkoutAddress.title = location.address || "";
      el.checkoutCoords.textContent = formatCoord(location) + " · " + relativeTime(location.at);
      el.checkoutAccuracy.textContent = formatAccuracy(location.accuracy);
      el.checkoutLocStatus.textContent = "定位成功 · " + formatTime(location.at);
      if (state.maps.hero) updateHeroLocation(location, false);
    }
  }

  function handleLocationError(mode, error) {
    const message = geoMessage(error);
    if (mode === "hero") {
      el.mapBadgeText.textContent = "定位失败";
      el.mapStatusDot.className = "status-dot is-warn";
      if (!readCachedLocation()) {
        el.heroAddress.textContent = "未能获取当前位置";
        el.heroCoords.textContent = message.short;
        el.heroAccuracy.textContent = "请检查位置权限";
        if (state.maps.hero) state.maps.hero.showEmpty("定位未开启", message.short);
      }
    }
    if (mode === "checkin") {
      el.checkinLocStatus.textContent = "定位不可用 · 仍可签到";
      el.checkinAddress.textContent = "未获取当前位置";
      el.checkinCoords.textContent = message.short;
      el.checkinAccuracy.textContent = "—";
      el.checkinHint.textContent = "本次签到不会记录位置";
      el.checkinHint.className = "submit-hint";
      if (state.maps.checkin) state.maps.checkin.showEmpty("无法获取位置", "仍可签到，但本次不会记录位置");
    }
    if (mode === "checkout") {
      el.checkoutLocStatus.textContent = "定位不可用 · 仍可签退";
      el.checkoutAddress.textContent = "未获取当前位置";
      el.checkoutCoords.textContent = message.short;
      el.checkoutAccuracy.textContent = "—";
      el.checkoutHint.textContent = "本次签退不会记录位置";
      el.checkoutHint.className = "submit-hint";
      if (state.maps.checkout) state.maps.checkout.showEmpty("无法获取位置", "仍可签退，但本次不会记录位置");
    }
    if (!document.querySelector(".modal.is-open")) {
      showToast(message.title, message.detail, "warning");
    }
  }

  function geoMessage(error) {
    if (error && (error.code === 1 || error.code === "PERMISSION_DENIED")) {
      return { short: "请在浏览器允许位置权限后重试", title: "位置权限被拒绝", detail: "可在地址栏左侧重新允许定位。" };
    }
    if (error && (error.code === 3 || error.code === "TIMEOUT")) {
      return { short: "定位超时，请稍后重试", title: "获取位置超时", detail: "请检查设备定位服务。" };
    }
    if (error && error.code === "INSECURE") {
      return { short: "请通过 localhost 或 HTTPS 打开", title: "当前页面无法使用定位", detail: "双击 start.bat，通过 http://localhost:8080 打开。" };
    }
    return { short: "定位失败，请稍后重试", title: "未能获取当前位置", detail: "请检查位置权限和设备定位服务。" };
  }

  function resolveAddress(mode, location) {
    reverseGeocode(location.lat, location.lng).then(function (address) {
      if (!address || state.locations[mode] !== location) return;
      location.address = address;
      if (mode === "hero") updateHeroLocation(location, false, true);
      if (mode === "checkin") {
        el.checkinAddress.textContent = address;
        el.checkinAddress.title = address;
        if (state.maps.hero) updateHeroLocation(location, false, true);
      }
      if (mode === "checkout") {
        el.checkoutAddress.textContent = address;
        el.checkoutAddress.title = address;
        if (state.maps.hero) updateHeroLocation(location, false, true);
      }
    });
  }

  async function reverseGeocode(lat, lng) {
    const key = Number(lat).toFixed(4) + "," + Number(lng).toFixed(4);
    if (state.geocodeCache.has(key)) return state.geocodeCache.get(key);
    const controller = new AbortController();
    const timer = window.setTimeout(function () { controller.abort(); }, 6000);
    try {
      const response = await fetch("https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=" +
        encodeURIComponent(lat) + "&longitude=" + encodeURIComponent(lng) + "&localityLanguage=zh", {
        signal: controller.signal,
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error("geocode failed");
      const data = await response.json();
      const parts = [];
      [data.principalSubdivision, data.city, data.locality].forEach(function (value) {
        const text = String(value || "").trim();
        if (text && parts.indexOf(text) === -1) parts.push(text);
      });
      if (!parts.length && data.countryName) parts.push(data.countryName);
      const address = parts.slice(0, 3).join(" · ");
      state.geocodeCache.set(key, address);
      return address;
    } catch (error) {
      state.geocodeCache.set(key, "");
      return "";
    } finally {
      window.clearTimeout(timer);
    }
  }

  /* ---------------- check-in / check-out ---------------- */

  function openCheckinModal() {
    if (state.activeRecord) {
      showToast("已经签到", "请先办理签退，再进行下一次签到", "warning");
      return;
    }
    state.locations.checkin = null;
    state.checkinSubmitting = false;
    el.checkinForm.reset();
    el.checkinLocStatus.textContent = "正在获取当前位置…";
    el.checkinAddress.textContent = "等待获取位置";
    el.checkinCoords.textContent = "坐标将随签到一并保存";
    el.checkinAccuracy.textContent = "—";
    el.checkinHint.textContent = "正在定位，请稍候";
    el.checkinHint.className = "submit-hint";
    el.checkinSubmit.disabled = true;
    openModal("checkinModal");
    const cached = readCachedLocation();
    const map = ensureMap("checkin", el.checkinMap, cached, cached ? 15 : 4);
    if (map) {
      map.clearLocation();
      map.showEmpty("正在获取当前位置", "请允许浏览器访问当前位置");
    }
    window.requestAnimationFrame(function () { if (map) map.resize(); });
    locateFor("checkin");
  }

  function openCheckoutModal() {
    if (!state.activeRecord) {
      showToast("当前没有未签退记录", "到校签到后才能办理签退", "warning");
      return;
    }
    state.locations.checkout = null;
    state.checkoutSubmitting = false;
    renderCheckoutSummary();
    el.checkoutLocStatus.textContent = "正在获取当前位置…";
    el.checkoutAddress.textContent = "等待获取位置";
    el.checkoutCoords.textContent = "坐标将随签退一并保存";
    el.checkoutAccuracy.textContent = "—";
    el.checkoutHint.textContent = "正在定位，请稍候";
    el.checkoutHint.className = "submit-hint";
    el.checkoutSubmit.disabled = true;
    openModal("checkoutModal");
    const cached = readCachedLocation();
    const map = ensureMap("checkout", el.checkoutMap, cached, cached ? 15 : 4);
    if (map) {
      map.clearLocation();
      map.showEmpty("正在获取当前位置", "请允许浏览器访问当前位置");
    }
    window.requestAnimationFrame(function () { if (map) map.resize(); });
    locateFor("checkout");
  }

  function renderCheckoutSummary() {
    const record = state.activeRecord;
    if (!record) return;
    const inLocation = record.checkInLocation ? locationText(record.checkInLocation) : "未记录";
    el.checkoutSummary.innerHTML =
      '<div class="checkout-person"><span class="person-avatar avatar-tone-' + avatarTone(state.user.name) + '">' +
      escapeHtml(initialOf(state.user.name)) + '</span><div class="checkout-person-meta"><strong>' +
      escapeHtml(state.user.name) + '</strong><span>' + escapeHtml(state.user.number) + '</span></div>' +
      '<span class="status-pill is-active">在校中</span></div>' +
      '<div class="checkout-times"><div><span>签到时间</span><strong>' + formatTime(record.checkInAt) +
      " · " + escapeHtml(formatDayLabel(record.checkInAt)) + '</strong></div><div><span>已在校</span><strong id="checkoutElapsed">' +
      escapeHtml(formatDuration(record.durationSeconds)) + '</strong></div><div><span>签到位置</span><strong title="' +
      escapeHtml(inLocation) + '">' + escapeHtml(inLocation) + "</strong></div></div>";
  }

  async function handleCheckinSubmit(event) {
    event.preventDefault();
    if (state.checkinSubmitting || state.locating.checkin) return;
    state.checkinSubmitting = true;
    el.checkinSubmit.disabled = true;
    el.checkinSubmit.innerHTML = "正在签到…";
    try {
      const location = state.locations.checkin ? cloneLocation(state.locations.checkin) : null;
      const data = await request("/api/attendance/check-in", {
        method: "POST",
        body: JSON.stringify({ location })
      });
      closeModal("checkinModal");
      showToast("签到成功", data.record ? "签到时间 " + formatTime(data.record.checkInAt) : "", "success");
      await refreshAll();
    } catch (error) {
      showToast("签到失败", error.message, "error");
      el.checkinSubmit.disabled = false;
      el.checkinSubmit.innerHTML = '<svg class="icon"><use href="#i-check"></use></svg>确认签到';
      state.checkinSubmitting = false;
    }
  }

  async function handleCheckoutSubmit(event) {
    event.preventDefault();
    if (state.checkoutSubmitting || state.locating.checkout) return;
    state.checkoutSubmitting = true;
    el.checkoutSubmit.disabled = true;
    el.checkoutSubmit.innerHTML = "正在签退…";
    try {
      const location = state.locations.checkout ? cloneLocation(state.locations.checkout) : null;
      const data = await request("/api/attendance/check-out", {
        method: "POST",
        body: JSON.stringify({ location })
      });
      closeModal("checkoutModal");
      showToast("签退成功", data.record ? "本次在校 " + formatDuration(data.record.durationSeconds) : "", "success");
      await refreshAll();
    } catch (error) {
      showToast("签退失败", error.message, "error");
      el.checkoutSubmit.disabled = false;
      el.checkoutSubmit.textContent = "确认签退";
      state.checkoutSubmitting = false;
    }
  }

  function cloneLocation(location) {
    return {
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
      address: location.address || ""
    };
  }

  /* ---------------- location modal ---------------- */

  function openLocationModal(recordId, type) {
    const record = state.records.find(function (item) { return String(item.id) === String(recordId); });
    if (!record) {
      showToast("没有找到位置记录", "", "warning");
      return;
    }
    const inLocation = record.checkInLocation;
    const outLocation = record.checkOutLocation;
    if (!inLocation && !outLocation) {
      showToast("这条记录没有位置信息", "", "warning");
      return;
    }
    state.viewingRecordId = record.id;
    state.viewingType = type === "out" && outLocation ? "out" : "in";
    if (state.viewingType === "in" && !inLocation && outLocation) state.viewingType = "out";
    el.locationSubtitle.textContent = "签到与签退位置留痕";
    renderLocationTabs();
    openModal("locationModal", ".modal-close");
    const location = state.viewingType === "out" ? outLocation : inLocation;
    const map = ensureMap("location", el.locationMap, location, 16);
    window.requestAnimationFrame(function () {
      if (map) map.resize();
      renderLocationView();
    });
  }

  function renderLocationTabs() {
    const record = state.records.find(function (item) { return String(item.id) === String(state.viewingRecordId); });
    if (!record || !record.checkInLocation || !record.checkOutLocation) {
      el.locationTabs.hidden = true;
      el.locationTabs.innerHTML = "";
      return;
    }
    el.locationTabs.hidden = false;
    el.locationTabs.innerHTML =
      '<button type="button" data-loc-type="in" class="' + (state.viewingType === "in" ? "is-active" : "") +
      '">签到位置</button><button type="button" data-loc-type="out" class="' +
      (state.viewingType === "out" ? "is-active" : "") + '">签退位置</button>';
  }

  function renderLocationView() {
    const record = state.records.find(function (item) { return String(item.id) === String(state.viewingRecordId); });
    if (!record) return;
    const isOut = state.viewingType === "out";
    const location = isOut ? record.checkOutLocation : record.checkInLocation;
    if (!location) return;
    const time = isOut ? record.checkOutAt : record.checkInAt;
    el.locationAddress.textContent = locationText(location);
    el.locationAddress.title = locationText(location);
    el.locationCoords.textContent = formatCoord(location);
    el.locationType.textContent = isOut ? "签退" : "签到";
    el.locationTime.textContent = formatDateTime(time);
    el.locationAccuracy.textContent = formatAccuracy(location.accuracy);
    el.locationOsmLink.href = "https://www.openstreetmap.org/?mlat=" + location.lat + "&mlon=" +
      location.lng + "#map=18/" + location.lat + "/" + location.lng;
    const map = ensureMap("location", el.locationMap, location, 16);
    if (map) {
      map.resize();
      map.setLocation(location.lat, location.lng, {
        accuracy: location.accuracy,
        zoom: 16,
        label: isOut ? "签退位置" : "签到位置"
      });
    }
    $$("[data-loc-type]", el.locationTabs).forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-loc-type") === state.viewingType);
    });
  }

  /* ---------------- modals / toast / clock ---------------- */

  function openModal(id, focusSelector) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    const panel = $(".modal-panel", modal);
    if (panel) panel.scrollTop = 0;
    window.requestAnimationFrame(function () {
      const target = focusSelector ? $(focusSelector, modal) : $("input:not([disabled]), button:not([disabled])", modal);
      if (target) target.focus({ preventScroll: true });
    });
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal || !modal.classList.contains("is-open")) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (id === "checkinModal") {
      state.tokens.checkin += 1;
      state.locating.checkin = false;
      state.checkinSubmitting = false;
      el.checkinSubmit.disabled = false;
      el.checkinSubmit.innerHTML = '<svg class="icon"><use href="#i-check"></use></svg>确认签到';
    }
    if (id === "checkoutModal") {
      state.tokens.checkout += 1;
      state.locating.checkout = false;
      state.checkoutSubmitting = false;
      el.checkoutSubmit.disabled = false;
      el.checkoutSubmit.textContent = "确认签退";
    }
    if (!document.querySelector(".modal.is-open")) {
      document.body.classList.remove("modal-open");
    }
  }

  function showToast(title, detail, type) {
    const toast = document.createElement("div");
    toast.className = "toast" + (type ? " is-" + type : " is-success");
    const icon = type === "error" ? "i-alert" : type === "warning" ? "i-info" : "i-check-circle";
    toast.innerHTML = '<span class="toast-icon"><svg class="icon"><use href="#' + icon +
      '"></use></svg></span><span class="toast-copy"><strong></strong><span></span></span>';
    $("strong", toast).textContent = title;
    const detailNode = $(".toast-copy > span", toast);
    if (detail) detailNode.textContent = detail;
    else detailNode.remove();
    el.toastContainer.appendChild(toast);
    while (el.toastContainer.children.length > 3) el.toastContainer.firstElementChild.remove();
    window.setTimeout(function () {
      toast.classList.add("is-leaving");
      window.setTimeout(function () { toast.remove(); }, 220);
    }, 4200);
  }

  function startClock() {
    tickClock();
    state.clockTimer = window.setInterval(function () {
      tickClock();
      updateLiveDurations();
    }, 30000);
    window.setInterval(tickClock, 1000);
  }

  function tickClock() {
    const now = new Date();
    el.headerClock.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
    el.heroDate.textContent = formatFullDate(now);
    el.footerYear.textContent = String(now.getFullYear());
    const day = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    if (state.lastDay && state.lastDay !== day) {
      refreshAll().catch(function () {});
    }
    state.lastDay = day;
  }

  function setupScrollBehaviour() {
    const links = $$(".nav-link");
    const sections = ["today", "records", "tasks"].map(function (id) {
      return document.getElementById(id);
    }).filter(Boolean);
    let ticking = false;
    function update() {
      const scrollY = window.scrollY || window.pageYOffset;
      el.header.classList.toggle("is-scrolled", scrollY > 10);
      const anchor = scrollY + 150;
      let current = "today";
      sections.forEach(function (section) {
        if (section.offsetTop <= anchor) current = section.id;
      });
      links.forEach(function (link) {
        link.classList.toggle("is-active", link.getAttribute("href") === "#" + current);
      });
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    }, { passive: true });
    update();
  }

  function bindEvents() {
    el.checkinBtn.addEventListener("click", openCheckinModal);
    el.checkoutBtn.addEventListener("click", openCheckoutModal);
    el.emptyCheckinBtn.addEventListener("click", openCheckinModal);
    el.checkinForm.addEventListener("submit", handleCheckinSubmit);
    el.checkoutForm.addEventListener("submit", handleCheckoutSubmit);
    el.refreshCheckinLoc.addEventListener("click", function () { locateFor("checkin"); });
    el.refreshCheckoutLoc.addEventListener("click", function () { locateFor("checkout"); });
    el.locateBtn.addEventListener("click", function () { locateFor("hero"); });
    el.locateTextBtn.addEventListener("click", function () { locateFor("hero"); });

    el.exportBtn.addEventListener("click", function () {
      const params = new URLSearchParams();
      params.set("range", state.filters.range);
      params.set("status", state.filters.status);
      if (state.filters.query.trim()) params.set("q", state.filters.query.trim());
      window.location.href = "/api/attendance/export?" + params.toString();
    });

    el.statusFilter.addEventListener("click", function (event) {
      const button = event.target.closest("[data-status]");
      if (!button) return;
      state.filters.status = button.getAttribute("data-status");
      setSegmented(el.statusFilter, "data-status", state.filters.status);
      loadAttendance().catch(function (error) { showToast("加载失败", error.message, "error"); });
    });

    el.rangeFilter.addEventListener("click", function (event) {
      const button = event.target.closest("[data-range]");
      if (!button) return;
      state.filters.range = button.getAttribute("data-range");
      setSegmented(el.rangeFilter, "data-range", state.filters.range);
      loadAttendance().catch(function (error) { showToast("加载失败", error.message, "error"); });
    });

    let searchTimer = 0;
    el.searchInput.addEventListener("input", function () {
      state.filters.query = el.searchInput.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () {
        loadAttendance().catch(function (error) { showToast("加载失败", error.message, "error"); });
      }, 200);
    });

    el.recordsBody.addEventListener("click", function (event) {
      const action = event.target.closest("[data-action]");
      if (!action) return;
      const id = action.getAttribute("data-id");
      if (action.getAttribute("data-action") === "checkout") {
        openCheckoutModal();
      } else {
        openLocationModal(id);
      }
    });

    el.taskFilter.addEventListener("click", function (event) {
      const button = event.target.closest("[data-task-status]");
      if (!button) return;
      state.filters.task = button.getAttribute("data-task-status");
      renderTasks();
    });

    el.tasksList.addEventListener("click", function (event) {
      const button = event.target.closest("[data-task-action]");
      if (!button) return;
      const action = button.getAttribute("data-task-action");
      updateTask(button.getAttribute("data-id"), action === "start" ? "in_progress" : "completed");
    });

    document.addEventListener("click", function (event) {
      const close = event.target.closest("[data-close]");
      if (close) closeModal(close.getAttribute("data-close"));
      const toggle = event.target.closest("[data-loc-type]");
      if (toggle) {
        state.viewingType = toggle.getAttribute("data-loc-type");
        renderLocationView();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        const open = $$(".modal.is-open").pop();
        if (open) closeModal(open.id);
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target;
        const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" || target.isContentEditable);
        if (!typing && !document.querySelector(".modal.is-open")) {
          event.preventDefault();
          el.searchInput.focus();
        }
      }
    });

    el.changePasswordBtn.addEventListener("click", function () {
      el.passwordForm.reset();
      el.passwordHint.textContent = "修改后请使用新密码登录";
      el.passwordHint.className = "submit-hint";
      openModal("passwordModal", "#currentPassword");
    });

    el.passwordForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      const currentPassword = el.currentPassword.value;
      const newPassword = el.newPassword.value;
      const confirm = el.confirmPassword.value;
      if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        showToast("密码不符合要求", "至少 8 位，并包含字母和数字", "warning");
        return;
      }
      if (newPassword !== confirm) {
        showToast("两次输入的新密码不一致", "", "warning");
        return;
      }
      el.passwordSubmit.disabled = true;
      el.passwordSubmit.textContent = "正在保存…";
      try {
        await request("/api/auth/change-password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword })
        });
        closeModal("passwordModal");
        showToast("密码已修改", "其他设备上的登录已失效", "success");
      } catch (error) {
        el.passwordHint.textContent = error.message;
        el.passwordHint.className = "submit-hint is-error";
      } finally {
        el.passwordSubmit.disabled = false;
        el.passwordSubmit.textContent = "保存新密码";
      }
    });

    el.logoutBtn.addEventListener("click", async function () {
      try {
        await request("/api/auth/logout", { method: "POST" });
      } catch (error) {
        /* still redirect */
      }
      window.location.href = "/login";
    });
  }

  function setSegmented(container, attribute, value) {
    $$("button", container).forEach(function (button) {
      const active = button.getAttribute(attribute) === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  window.addEventListener("DOMContentLoaded", init);
})();
