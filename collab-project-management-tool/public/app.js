const state = {
  token: localStorage.getItem("collab_token"),
  user: null,
  projects: [],
  activeProject: null,
  tasks: [],
  comments: [],
  notifications: [],
  socket: null,
  filters: {
    search: "",
    priority: "all"
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name = "?") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.textContent = message;
  $("#toast-container").appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function setModal(id, open) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.toggle("hidden", !open);
}

function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  return fetch(path, { ...options, headers }).then(async (response) => {
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (response.status === 401) {
      logout(false);
      throw new Error(data.error || "Session expired");
    }

    if (!response.ok) {
      throw new Error(data.error || "Something went wrong");
    }

    return data;
  });
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("collab_token", token);
  connectSocket();
}

function logout(showMessage = true) {
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }

  localStorage.removeItem("collab_token");
  state.token = null;
  state.user = null;
  state.projects = [];
  state.activeProject = null;
  state.tasks = [];
  state.notifications = [];

  $("#app-shell").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");

  if (showMessage) showToast("Logged out");
}

async function boot() {
  setupEvents();

  if (!state.token) {
    showAuth();
    return;
  }

  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    showApp();
    await loadProjects();
    await loadNotifications();
    connectSocket();
  } catch {
    logout(false);
  }
}

function showAuth() {
  $("#auth-screen").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
}

function showApp() {
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#current-user-name").textContent = state.user.name;
  $("#current-user-email").textContent = state.user.email;
  $("#current-avatar").textContent = initials(state.user.name);
  $("#current-avatar").style.background = state.user.avatarColor;
  $("#comment-avatar").textContent = initials(state.user.name);
  $("#comment-avatar").style.background = state.user.avatarColor;
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects;
  renderProjects();

  if (!state.projects.length) {
    state.activeProject = null;
    $("#empty-state").classList.remove("hidden");
    $("#project-view").classList.add("hidden");
    $("#page-title").textContent = "Select a project";
    return;
  }

  $("#empty-state").classList.add("hidden");

  const activeStillExists = state.activeProject &&
    state.projects.some((p) => p.id === state.activeProject.id);

  if (!activeStillExists) {
    await openProject(state.projects[0].id);
  } else {
    await openProject(state.activeProject.id);
  }
}

function renderProjects() {
  $("#project-count").textContent = state.projects.length;
  $("#project-list").innerHTML = state.projects.map((project) => `
    <button class="project-item ${state.activeProject?.id === project.id ? "active" : ""}"
      data-project-id="${project.id}">
      <span class="project-dot"></span>
      <span>${escapeHtml(project.name)}</span>
    </button>
  `).join("");
}

async function openProject(projectId) {
  try {
    const data = await api(`/api/projects/${projectId}`);
    state.activeProject = data.project;
    state.tasks = data.project.tasks;
    state.filters.search = "";
    state.filters.priority = "all";
    $("#task-search").value = "";
    $("#priority-filter").value = "all";

    renderProjects();
    renderProject();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderProject() {
  const project = state.activeProject;
  if (!project) return;

  $("#empty-state").classList.add("hidden");
  $("#project-view").classList.remove("hidden");
  $("#page-title").textContent = project.name;
  $("#project-name").textContent = project.name;
  $("#project-description").textContent = project.description || "No project description";
  $("#project-role").textContent = project.owner_id === state.user.id ? "Owner" : "Member";
  $("#delete-project-btn").classList.toggle("hidden", project.owner_id !== state.user.id);

  $("#stat-total").textContent = state.tasks.length;
  $("#stat-progress").textContent = state.tasks.filter(t => t.status === "in_progress").length;
  $("#stat-done").textContent = state.tasks.filter(t => t.status === "done").length;
  $("#stat-members").textContent = project.members.length;

  renderBoard();
  renderMembers();
}

function getFilteredTasks() {
  const search = state.filters.search.toLowerCase().trim();
  const priority = state.filters.priority;

  return state.tasks.filter((task) => {
    const matchesSearch =
      !search ||
      task.title.toLowerCase().includes(search) ||
      (task.description || "").toLowerCase().includes(search);

    const matchesPriority =
      priority === "all" || task.priority === priority;

    return matchesSearch && matchesPriority;
  });
}

function isOverdue(task) {
  if (!task.due_date || task.status === "done") return false;
  const due = new Date(`${task.due_date}T23:59:59`);
  return due < new Date();
}

function renderBoard() {
  const tasks = getFilteredTasks();
  const statuses = ["backlog", "in_progress", "done"];

  for (const status of statuses) {
    const list = document.getElementById(`list-${status}`);
    const statusTasks = tasks.filter(t => t.status === status);

    document.getElementById(`count-${status}`).textContent = statusTasks.length;

    list.innerHTML = statusTasks.length
      ? statusTasks.map(renderTaskCard).join("")
      : `<div class="empty-column">Drop tasks here</div>`;
  }

  $$(".task-card").forEach((card) => {
    card.addEventListener("click", () => openTaskDetails(Number(card.dataset.taskId)));
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/task-id", card.dataset.taskId);
      event.dataTransfer.effectAllowed = "move";
    });
  });
}

function renderTaskCard(task) {
  const assigneeName = task.assignee_name || "Unassigned";
  const avatarColor = task.assignee_color || "#94a3b8";
  const due = task.due_date
    ? `<span class="${isOverdue(task) ? "due-overdue" : ""}">📅 ${task.due_date}</span>`
    : "";

  return `
    <article class="task-card" draggable="true" data-task-id="${task.id}">
      <div class="task-top">
        <h4>${escapeHtml(task.title)}</h4>
        <span class="priority-chip ${task.priority}">${task.priority}</span>
      </div>
      ${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ""}
      <div class="task-footer">
        <div class="task-assignee">
          <div class="mini-avatar" style="background:${avatarColor}">${initials(assigneeName)}</div>
          <span>${escapeHtml(assigneeName)}</span>
        </div>
        <div class="task-meta">
          ${due}
          <span>💬 ${task.comment_count || 0}</span>
        </div>
      </div>
    </article>
  `;
}

function populateAssignees(selectedId = null) {
  const select = $("#task-assignee");
  const members = state.activeProject?.members || [];

  select.innerHTML = `
    <option value="">Unassigned</option>
    ${members.map(member => `
      <option value="${member.id}" ${Number(selectedId) === Number(member.id) ? "selected" : ""}>
        ${escapeHtml(member.name)}
      </option>
    `).join("")}
  `;
}

function openCreateTask(status = "backlog") {
  $("#task-modal-title").textContent = "Create task";
  $("#task-id").value = "";
  $("#task-title").value = "";
  $("#task-description").value = "";
  $("#task-status").value = status;
  $("#task-priority").value = "medium";
  $("#task-due-date").value = "";
  populateAssignees();
  setModal("task-modal", true);
  setTimeout(() => $("#task-title").focus(), 50);
}

function openEditTask(task) {
  $("#task-modal-title").textContent = "Edit task";
  $("#task-id").value = task.id;
  $("#task-title").value = task.title;
  $("#task-description").value = task.description || "";
  $("#task-status").value = task.status;
  $("#task-priority").value = task.priority;
  $("#task-due-date").value = task.due_date || "";
  populateAssignees(task.assignee_id);
  setModal("task-modal", true);
}

async function saveTask(event) {
  event.preventDefault();

  const taskId = $("#task-id").value;
  const payload = {
    title: $("#task-title").value,
    description: $("#task-description").value,
    status: $("#task-status").value,
    priority: $("#task-priority").value,
    assigneeId: $("#task-assignee").value || null,
    dueDate: $("#task-due-date").value || null
  };

  try {
    const data = taskId
      ? await api(`/api/tasks/${taskId}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        })
      : await api(`/api/projects/${state.activeProject.id}/tasks`, {
          method: "POST",
          body: JSON.stringify(payload)
        });

    if (taskId) {
      replaceTask(data.task);
      showToast("Task updated");
    } else {
      upsertTask(data.task);
      showToast("Task created");
    }

    setModal("task-modal", false);
    renderProject();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function upsertTask(task) {
  const index = state.tasks.findIndex(t => t.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
}

function replaceTask(task) {
  const index = state.tasks.findIndex(t => t.id === task.id);
  if (index >= 0) state.tasks[index] = task;
}

function findTask(taskId) {
  return state.tasks.find(t => Number(t.id) === Number(taskId));
}

async function openTaskDetails(taskId) {
  const task = findTask(taskId);
  if (!task) return;

  $("#detail-title").textContent = task.title;
  $("#detail-description").textContent = task.description || "No description";
  $("#detail-priority").textContent = task.priority;
  $("#detail-priority").className = `priority-chip ${task.priority}`;
  $("#detail-assignee").textContent = task.assignee_name || "Unassigned";
  $("#detail-due").textContent = task.due_date || "No due date";
  $("#detail-creator").textContent = task.creator_name || "-";
  $("#edit-task-btn").dataset.taskId = task.id;

  setModal("task-details-modal", true);
  await loadComments(task.id);
}

async function loadComments(taskId) {
  try {
    const data = await api(`/api/tasks/${taskId}/comments`);
    state.comments = data.comments;
    renderComments();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderComments() {
  $("#comment-count-label").textContent =
    `${state.comments.length} ${state.comments.length === 1 ? "comment" : "comments"}`;

  $("#comments-list").innerHTML = state.comments.length
    ? state.comments.map(comment => `
      <div class="comment">
        <div class="mini-avatar" style="background:${comment.avatar_color}">
          ${initials(comment.user_name)}
        </div>
        <div class="comment-content">
          <strong>${escapeHtml(comment.user_name)}</strong>
          <p>${escapeHtml(comment.body)}</p>
          <time>${formatDate(comment.created_at)}</time>
        </div>
      </div>
    `).join("")
    : `<div class="no-notifications">No comments yet. Start the conversation.</div>`;
}

function formatDate(value) {
  if (!value) return "";
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

async function submitComment(event) {
  event.preventDefault();

  const taskId = $("#edit-task-btn").dataset.taskId;
  const body = $("#comment-input").value.trim();
  if (!body) return;

  try {
    const data = await api(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });

    state.comments.push(data.comment);
    $("#comment-input").value = "";
    renderComments();

    const task = findTask(taskId);
    if (task) {
      task.comment_count = (task.comment_count || 0) + 1;
      renderBoard();
    }

    showToast("Comment added");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderMembers() {
  const project = state.activeProject;
  if (!project) return;

  const isOwner = project.owner_id === state.user.id;

  $("#members-list").innerHTML = project.members.map(member => `
    <div class="member-row">
      <div class="avatar" style="background:${member.avatar_color}">${initials(member.name)}</div>
      <div class="member-info">
        <strong>${escapeHtml(member.name)} ${member.id === state.user.id ? "(You)" : ""}</strong>
        <span>${escapeHtml(member.email)}</span>
      </div>
      <span class="member-role">${member.role}</span>
      ${isOwner && member.id !== state.user.id
        ? `<button class="member-remove" data-remove-member="${member.id}">Remove</button>`
        : ""}
    </div>
  `).join("");

  $$(".member-remove").forEach(button => {
    button.addEventListener("click", () => removeMember(Number(button.dataset.removeMember)));
  });
}

async function addMember(event) {
  event.preventDefault();

  try {
    await api(`/api/projects/${state.activeProject.id}/members`, {
      method: "POST",
      body: JSON.stringify({ email: $("#member-email").value })
    });

    $("#member-email").value = "";
    await openProject(state.activeProject.id);
    showToast("Member added");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function removeMember(userId) {
  if (!confirm("Remove this member from the project?")) return;

  try {
    await api(`/api/projects/${state.activeProject.id}/members/${userId}`, {
      method: "DELETE"
    });

    await openProject(state.activeProject.id);
    showToast("Member removed");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function createProject(event) {
  event.preventDefault();

  try {
    const data = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: $("#project-input-name").value,
        description: $("#project-input-description").value
      })
    });

    setModal("project-modal", false);
    $("#project-form").reset();
    await loadProjects();
    await openProject(data.project.id);
    showToast("Project created");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteProject() {
  if (!state.activeProject) return;

  const projectName = state.activeProject.name;
  if (!confirm(`Delete "${projectName}" and all its tasks? This cannot be undone.`)) return;

  try {
    await api(`/api/projects/${state.activeProject.id}`, { method: "DELETE" });
    state.activeProject = null;
    await loadProjects();
    showToast("Project deleted");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function loadNotifications() {
  try {
    const data = await api("/api/notifications");
    state.notifications = data.notifications;
    renderNotifications();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderNotifications() {
  const unread = state.notifications.filter(n => !n.is_read).length;

  $("#notification-count").textContent = unread;
  $("#notification-count").classList.toggle("hidden", unread === 0);
  $("#top-notification-dot").classList.toggle("hidden", unread === 0);

  $("#notifications-list").innerHTML = state.notifications.length
    ? state.notifications.map(n => `
      <div class="notification-item ${n.is_read ? "" : "unread"}" data-notification-id="${n.id}">
        <div class="mini-avatar" style="background:#4f46e5">!</div>
        <div>
          <p>${escapeHtml(n.message)}</p>
          <time>${formatDate(n.created_at)}</time>
        </div>
      </div>
    `).join("")
    : `<div class="no-notifications">You're all caught up.</div>`;

  $$(".notification-item").forEach(item => {
    item.addEventListener("click", async () => {
      const notificationId = Number(item.dataset.notificationId);
      const notification = state.notifications.find(n => n.id === notificationId);

      if (notification && !notification.is_read) {
        notification.is_read = 1;
        renderNotifications();
        await api(`/api/notifications/${notificationId}/read`, { method: "PUT" }).catch(() => {});
      }

      if (notification?.project_id) {
        await openProject(notification.project_id);
      }

      if (notification?.task_id) {
        setTimeout(() => openTaskDetails(notification.task_id), 100);
      }
    });
  });
}

function toggleNotifications() {
  $("#notifications-panel").classList.toggle("hidden");
}

function connectSocket() {
  if (!state.token) return;

  if (state.socket) {
    try { state.socket.close(); } catch {}
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}?token=${encodeURIComponent(state.token)}`;
  const socket = new WebSocket(wsUrl);
  state.socket = socket;

  socket.addEventListener("open", () => {
    console.log("WebSocket connected");
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);
      await handleRealtimeMessage(message);
    } catch (error) {
      console.error("Realtime message error:", error);
    }
  });

  socket.addEventListener("close", () => {
    if (state.token) {
      setTimeout(() => {
        if (state.token && state.socket === socket) connectSocket();
      }, 2500);
    }
  });
}

async function handleRealtimeMessage(message) {
  switch (message.type) {
    case "notification:new":
      state.notifications.unshift(message.notification);
      state.notifications = state.notifications.slice(0, 50);
      renderNotifications();
      showToast(message.notification.message);
      break;

    case "task:created":
      if (state.activeProject?.id === message.task.project_id) {
        upsertTask(message.task);
        renderProject();
      } else {
        await loadProjects();
      }
      break;

    case "task:updated":
      if (state.activeProject?.id === message.task.project_id) {
        upsertTask(message.task);
        renderProject();
      }
      break;

    case "task:deleted":
      state.tasks = state.tasks.filter(t => t.id !== message.taskId);
      renderProject();
      break;

    case "task:comment_count_updated": {
      const task = findTask(message.taskId);
      if (task) {
        task.comment_count = message.count;
        renderBoard();
      }
      break;
    }

    case "comment:created":
      if (Number($("#edit-task-btn").dataset.taskId) === Number(message.taskId)) {
        state.comments.push(message.comment);
        renderComments();
      }
      break;

    case "comment:deleted":
      state.comments = state.comments.filter(c => c.id !== message.commentId);
      renderComments();
      break;

    case "project:members_updated":
      if (state.activeProject?.id === message.projectId) {
        state.activeProject.members = message.members;
        renderProject();
      }
      break;

    case "project:created":
      await loadProjects();
      break;

    case "project:deleted":
      if (state.activeProject?.id === message.projectId) {
        await loadProjects();
      }
      break;
  }
}

async function moveTask(taskId, newStatus) {
  const task = findTask(taskId);
  if (!task || task.status === newStatus) return;

  try {
    const data = await api(`/api/tasks/${taskId}`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus })
    });

    replaceTask(data.task);
    renderProject();
  } catch (error) {
    showToast(error.message, "error");
    renderBoard();
  }
}

function setupDragAndDrop() {
  $$(".column").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("drag-over");
    });

    column.addEventListener("dragleave", () => {
      column.classList.remove("drag-over");
    });

    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("drag-over");

      const taskId = Number(event.dataTransfer.getData("text/task-id"));
      const status = column.dataset.status;
      await moveTask(taskId, status);
    });
  });
}

function setupEvents() {
  $$("[data-auth-tab]").forEach(button => {
    button.addEventListener("click", () => {
      $$("[data-auth-tab]").forEach(b => b.classList.remove("active"));
      button.classList.add("active");

      const isLogin = button.dataset.authTab === "login";
      $("#login-form").classList.toggle("hidden", !isLogin);
      $("#register-form").classList.toggle("hidden", isLogin);
    });
  });

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: $("#login-email").value,
          password: $("#login-password").value
        })
      });

      saveSession(data.token, data.user);
      showApp();
      await loadProjects();
      await loadNotifications();
      showToast("Welcome back!");
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#register-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const data = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name: $("#register-name").value,
          email: $("#register-email").value,
          password: $("#register-password").value
        })
      });

      saveSession(data.token, data.user);
      showApp();
      await loadProjects();
      await loadNotifications();
      showToast("Account created!");
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#logout-btn").addEventListener("click", () => logout());

  $("#new-project-btn").addEventListener("click", () => setModal("project-modal", true));
  $("#empty-new-project").addEventListener("click", () => setModal("project-modal", true));
  $("#project-form").addEventListener("submit", createProject);

  $("#add-task-btn").addEventListener("click", () => openCreateTask());
  $$(".column-add").forEach(button => {
    button.addEventListener("click", () => openCreateTask(button.dataset.status));
  });

  $("#task-form").addEventListener("submit", saveTask);
  $("#comment-form").addEventListener("submit", submitComment);

  $("#edit-task-btn").addEventListener("click", () => {
    const task = findTask(Number($("#edit-task-btn").dataset.taskId));
    if (!task) return;
    setModal("task-details-modal", false);
    openEditTask(task);
  });

  $("#members-btn").addEventListener("click", () => {
    renderMembers();
    setModal("members-modal", true);
  });

  $("#member-form").addEventListener("submit", addMember);
  $("#delete-project-btn").addEventListener("click", deleteProject);

  $("#task-search").addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    renderBoard();
  });

  $("#priority-filter").addEventListener("change", (event) => {
    state.filters.priority = event.target.value;
    renderBoard();
  });

  $("#clear-filters").addEventListener("click", () => {
    state.filters.search = "";
    state.filters.priority = "all";
    $("#task-search").value = "";
    $("#priority-filter").value = "all";
    renderBoard();
  });

  $("#refresh-btn").addEventListener("click", async () => {
    await loadProjects();
    await loadNotifications();
    showToast("Workspace refreshed");
  });

  $("#notifications-btn").addEventListener("click", toggleNotifications);
  $("#top-notifications-btn").addEventListener("click", toggleNotifications);

  $("#mark-all-read").addEventListener("click", async () => {
    await api("/api/notifications/read-all", { method: "PUT" }).catch(() => {});
    state.notifications.forEach(n => n.is_read = 1);
    renderNotifications();
  });

  $$(".modal-close").forEach(button => {
    button.addEventListener("click", () => setModal(button.dataset.close, false));
  });

  $$(".modal").forEach(modal => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) setModal(modal.id, false);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $$(".modal:not(.hidden)").forEach(modal => modal.classList.add("hidden"));
      $("#notifications-panel").classList.add("hidden");
    }
  });

  $("#project-list").addEventListener("click", async (event) => {
    const item = event.target.closest("[data-project-id]");
    if (item) await openProject(Number(item.dataset.projectId));
  });

  setupDragAndDrop();
}

boot();
