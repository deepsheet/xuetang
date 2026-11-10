(function () {
  "use strict";

  const elements = {
    loading: document.getElementById("authLoading"),
    error: document.getElementById("authError"),
    loginForm: document.getElementById("loginForm"),
    setupForm: document.getElementById("setupForm"),
    changeForm: document.getElementById("changeForm"),
    loginNumber: document.getElementById("loginNumber"),
    loginPassword: document.getElementById("loginPassword"),
    loginSubmit: document.getElementById("loginSubmit"),
    setupName: document.getElementById("setupName"),
    setupPassword: document.getElementById("setupPassword"),
    setupConfirm: document.getElementById("setupConfirm"),
    setupSubmit: document.getElementById("setupSubmit"),
    changeCurrent: document.getElementById("changeCurrent"),
    changePassword: document.getElementById("changePassword"),
    changeConfirm: document.getElementById("changeConfirm"),
    changeSubmit: document.getElementById("changeSubmit")
  };

  const state = { lastPassword: "" };

  function showOnly(form) {
    elements.loading.hidden = true;
    [elements.loginForm, elements.setupForm, elements.changeForm].forEach(function (item) {
      item.hidden = item !== form;
    });
  }

  function setError(message) {
    if (!message) {
      elements.error.hidden = true;
      elements.error.textContent = "";
      return;
    }
    elements.error.hidden = false;
    elements.error.textContent = message;
  }

  function setBusy(button, busy, busyText) {
    if (!button) {
      return;
    }
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.textContent = busyText || "请稍候…";
    } else {
      button.disabled = false;
      if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
      }
    }
  }

  async function request(path, options) {
    const response = await fetch(path, Object.assign({
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    }, options || {}));
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok) {
      const message = data && data.error ? data.error : "请求失败，请稍后重试";
      const error = new Error(message);
      error.status = response.status;
      error.code = data && data.code;
      throw error;
    }
    return data;
  }

  function redirectFor(user) {
    window.location.href = user.role === "admin" ? "/admin" : "/";
  }

  function showChange(user) {
    showOnly(elements.changeForm);
    if (state.lastPassword) {
      elements.changeCurrent.value = state.lastPassword;
    }
    elements.changePassword.focus();
  }

  async function init() {
    try {
      const setup = await request("/api/setup/status");
      let currentUser = null;
      try {
        const me = await request("/api/me");
        currentUser = me.user;
      } catch (error) {
        if (error.status !== 401) {
          throw error;
        }
      }

      if (currentUser) {
        if (currentUser.mustChangePassword) {
          showChange(currentUser);
          return;
        }
        redirectFor(currentUser);
        return;
      }

      if (setup.needsSetup) {
        showOnly(elements.setupForm);
        elements.setupName.focus();
      } else {
        showOnly(elements.loginForm);
        elements.loginNumber.focus();
      }
    } catch (error) {
      elements.loading.hidden = true;
      setError(error.message);
      showOnly(elements.loginForm);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setError("");
    const number = elements.loginNumber.value.trim();
    const password = elements.loginPassword.value;
    if (!number || !password) {
      setError("请输入学号/工号和密码");
      return;
    }
    setBusy(elements.loginSubmit, true, "正在登录…");
    try {
      const data = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ number, password })
      });
      state.lastPassword = password;
      if (data.user.mustChangePassword) {
        showChange(data.user);
      } else {
        redirectFor(data.user);
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(elements.loginSubmit, false);
    }
  }

  async function handleSetup(event) {
    event.preventDefault();
    setError("");
    const displayName = elements.setupName.value.trim();
    const password = elements.setupPassword.value;
    const confirm = elements.setupConfirm.value;
    if (!displayName) {
      setError("请填写管理员姓名");
      return;
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      setError("密码至少 8 位，并同时包含字母和数字");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(elements.setupSubmit, true, "正在创建…");
    try {
      const data = await request("/api/setup", {
        method: "POST",
        body: JSON.stringify({ displayName, password })
      });
      state.lastPassword = password;
      redirectFor(data.user);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(elements.setupSubmit, false);
    }
  }

  async function handleChange(event) {
    event.preventDefault();
    setError("");
    const currentPassword = elements.changeCurrent.value;
    const newPassword = elements.changePassword.value;
    const confirm = elements.changeConfirm.value;
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError("新密码至少 8 位，并同时包含字母和数字");
      return;
    }
    if (newPassword !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(elements.changeSubmit, true, "正在保存…");
    try {
      const data = await request("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      state.lastPassword = "";
      redirectFor(data.user);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(elements.changeSubmit, false);
    }
  }

  document.addEventListener("click", function (event) {
    const toggle = event.target.closest("[data-toggle-password]");
    if (!toggle) {
      return;
    }
    const input = document.getElementById(toggle.getAttribute("data-toggle-password"));
    if (!input) {
      return;
    }
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? "隐藏" : "显示";
    toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
  });

  elements.loginForm.addEventListener("submit", handleLogin);
  elements.setupForm.addEventListener("submit", handleSetup);
  elements.changeForm.addEventListener("submit", handleChange);
  window.addEventListener("DOMContentLoaded", init);
})();
