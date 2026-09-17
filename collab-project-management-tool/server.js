const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-production";

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "app.db"));
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#4f46e5',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id INTEGER,
  due_date TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  task_id INTEGER,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
`);

function seedUser(name, email, password, color) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      "INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)"
    ).run(name, email, hash, color);
  }
}

seedUser("Demo User", "demo@example.com", "Demo@123", "#4f46e5");
seedUser("Alex Johnson", "alex@example.com", "Alex@123", "#0f766e");

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarColor: user.avatar_color
  };
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireProjectMember(req, res, next) {
  const projectId = Number(req.params.id || req.body.projectId);
  const member = db.prepare(`
    SELECT pm.project_id, pm.role
    FROM project_members pm
    WHERE pm.project_id = ? AND pm.user_id = ?
  `).get(projectId, req.user.id);

  if (!member) {
    return res.status(403).json({ error: "You are not a member of this project" });
  }

  req.projectId = projectId;
  req.projectRole = member.role;
  next();
}

function getProject(projectId) {
  return db.prepare(`
    SELECT
      p.*,
      u.name AS owner_name,
      u.email AS owner_email
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    WHERE p.id = ?
  `).get(projectId);
}

function getMembers(projectId) {
  return db.prepare(`
    SELECT
      u.id, u.name, u.email, u.avatar_color, pm.role, pm.joined_at
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
    ORDER BY CASE WHEN pm.role = 'owner' THEN 0 ELSE 1 END, u.name
  `).all(projectId);
}

function getTask(taskId) {
  return db.prepare(`
    SELECT
      t.*,
      a.name AS assignee_name,
      a.email AS assignee_email,
      a.avatar_color AS assignee_color,
      c.name AS creator_name
    FROM tasks t
    LEFT JOIN users a ON a.id = t.assignee_id
    JOIN users c ON c.id = t.created_by
    WHERE t.id = ?
  `).get(taskId);
}

function getProjectTasks(projectId) {
  return db.prepare(`
    SELECT
      t.*,
      a.name AS assignee_name,
      a.email AS assignee_email,
      a.avatar_color AS assignee_color,
      c.name AS creator_name,
      (SELECT COUNT(*) FROM comments cm WHERE cm.task_id = t.id) AS comment_count
    FROM tasks t
    LEFT JOIN users a ON a.id = t.assignee_id
    JOIN users c ON c.id = t.created_by
    WHERE t.project_id = ?
    ORDER BY
      CASE t.status
        WHEN 'backlog' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'done' THEN 3
        ELSE 4
      END,
      CASE t.priority
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        ELSE 3
      END,
      t.created_at DESC
  `).all(projectId);
}

function emitToUsers(userIds, payload) {
  const uniqueIds = [...new Set(userIds.map(Number).filter(Boolean))];
  const data = JSON.stringify(payload);

  for (const client of wss.clients) {
    if (client.readyState === 1 && uniqueIds.includes(Number(client.userId))) {
      client.send(data);
    }
  }
}

function emitProject(projectId, payload) {
  const members = getMembers(projectId).map((m) => m.id);
  emitToUsers(members, payload);
}

function createNotification({
  userId,
  projectId = null,
  taskId = null,
  type,
  message
}) {
  const result = db.prepare(`
    INSERT INTO notifications
      (user_id, project_id, task_id, type, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, projectId, taskId, type, message);

  const notification = db.prepare(
    "SELECT * FROM notifications WHERE id = ?"
  ).get(result.lastInsertRowid);

  emitToUsers([userId], {
    type: "notification:new",
    notification
  });

  return notification;
}

function notifyProjectMembers(projectId, options = {}) {
  const members = getMembers(projectId);
  for (const member of members) {
    if (options.excludeUserId && member.id === options.excludeUserId) continue;
    createNotification({
      userId: member.id,
      projectId,
      taskId: options.taskId || null,
      type: options.type || "project",
      message: options.message
    });
  }
}

// ---------- Auth ----------
app.post("/api/auth/register", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 2) return res.status(400).json({ error: "Name must be at least 2 characters" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email is already registered" });

  const colors = ["#4f46e5", "#0f766e", "#b45309", "#be123c", "#7c3aed", "#0369a1"];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const hash = bcrypt.hashSync(password, 10);

  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, avatar_color)
    VALUES (?, ?, ?, ?)
  `).run(name, email, hash, color);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({
    user: publicUser(user),
    token: signToken(user)
  });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  res.json({
    user: publicUser(user),
    token: signToken(user)
  });
});

app.get("/api/auth/me", auth, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user) });
});

// ---------- Projects ----------
app.get("/api/projects", auth, (req, res) => {
  const projects = db.prepare(`
    SELECT
      p.id, p.name, p.description, p.owner_id, p.created_at,
      u.name AS owner_name,
      (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.id) AS member_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS completed_count
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    JOIN users u ON u.id = p.owner_id
    ORDER BY p.created_at DESC
  `).all(req.user.id);

  res.json({ projects });
});

app.post("/api/projects", auth, (req, res) => {
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();

  if (name.length < 2) return res.status(400).json({ error: "Project name is required" });

  const transaction = db.transaction(() => {
    const project = db.prepare(`
      INSERT INTO projects (name, description, owner_id)
      VALUES (?, ?, ?)
    `).run(name, description, req.user.id);

    db.prepare(`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (?, ?, 'owner')
    `).run(project.lastInsertRowid, req.user.id);

    return getProject(project.lastInsertRowid);
  });

  const project = transaction();

  emitProject(project.id, {
    type: "project:created",
    project
  });

  res.status(201).json({
    project: {
      ...project,
      members: getMembers(project.id),
      tasks: []
    }
  });
});

app.get("/api/projects/:id", auth, requireProjectMember, (req, res) => {
  const project = getProject(req.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({
    project: {
      ...project,
      members: getMembers(project.id),
      tasks: getProjectTasks(project.id)
    }
  });
});

app.post("/api/projects/:id/members", auth, requireProjectMember, (req, res) => {
  if (req.projectRole !== "owner") {
    return res.status(403).json({ error: "Only the project owner can add members" });
  }

  const email = String(req.body.email || "").trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!user) return res.status(404).json({ error: "No user found with that email" });

  const already = db.prepare(`
    SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?
  `).get(req.projectId, user.id);

  if (already) return res.status(409).json({ error: "User is already a project member" });

  db.prepare(`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (?, ?, 'member')
  `).run(req.projectId, user.id);

  const project = getProject(req.projectId);

  createNotification({
    userId: user.id,
    projectId: req.projectId,
    type: "member_added",
    message: `You were added to project "${project.name}"`
  });

  emitProject(req.projectId, {
    type: "project:members_updated",
    projectId: req.projectId,
    members: getMembers(req.projectId)
  });

  res.status(201).json({ member: publicUser(user) });
});

app.delete("/api/projects/:id/members/:userId", auth, requireProjectMember, (req, res) => {
  if (req.projectRole !== "owner") {
    return res.status(403).json({ error: "Only the project owner can remove members" });
  }

  const userId = Number(req.params.userId);
  if (userId === req.user.id) {
    return res.status(400).json({ error: "Owner cannot remove themselves" });
  }

  db.prepare(`
    DELETE FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).run(req.projectId, userId);

  emitProject(req.projectId, {
    type: "project:members_updated",
    projectId: req.projectId,
    members: getMembers(req.projectId)
  });

  res.json({ message: "Member removed" });
});

app.delete("/api/projects/:id", auth, requireProjectMember, (req, res) => {
  if (req.projectRole !== "owner") {
    return res.status(403).json({ error: "Only the project owner can delete a project" });
  }

  const project = getProject(req.projectId);
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.projectId);

  emitToUsers(getMembers(req.projectId).map((m) => m.id), {
    type: "project:deleted",
    projectId: req.projectId
  });

  res.json({ message: `Project "${project.name}" deleted` });
});

// ---------- Tasks ----------
app.post("/api/projects/:id/tasks", auth, requireProjectMember, (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const status = ["backlog", "in_progress", "done"].includes(req.body.status)
    ? req.body.status
    : "backlog";
  const priority = ["low", "medium", "high"].includes(req.body.priority)
    ? req.body.priority
    : "medium";
  const dueDate = req.body.dueDate ? String(req.body.dueDate) : null;
  const assigneeId = req.body.assigneeId ? Number(req.body.assigneeId) : null;

  if (title.length < 2) return res.status(400).json({ error: "Task title is required" });

  if (assigneeId) {
    const isMember = db.prepare(`
      SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?
    `).get(req.projectId, assigneeId);
    if (!isMember) return res.status(400).json({ error: "Assignee must be a project member" });
  }

  const result = db.prepare(`
    INSERT INTO tasks
      (project_id, title, description, status, priority, assignee_id, due_date, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    req.projectId,
    title,
    description,
    status,
    priority,
    assigneeId,
    dueDate,
    req.user.id
  );

  const task = getTask(result.lastInsertRowid);
  const project = getProject(req.projectId);

  if (assigneeId && assigneeId !== req.user.id) {
    createNotification({
      userId: assigneeId,
      projectId: req.projectId,
      taskId: task.id,
      type: "task_assigned",
      message: `You were assigned "${task.title}" in ${project.name}`
    });
  }

  emitProject(req.projectId, {
    type: "task:created",
    task
  });

  res.status(201).json({ task });
});

app.put("/api/tasks/:id", auth, (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });

  const member = db.prepare(`
    SELECT role FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).get(task.project_id, req.user.id);

  if (!member) return res.status(403).json({ error: "You are not a project member" });

  const title = req.body.title !== undefined ? String(req.body.title).trim() : task.title;
  const description = req.body.description !== undefined
    ? String(req.body.description).trim()
    : task.description;

  const status = req.body.status !== undefined
    ? req.body.status
    : task.status;

  const priority = req.body.priority !== undefined
    ? req.body.priority
    : task.priority;

  const dueDate = req.body.dueDate !== undefined
    ? (req.body.dueDate ? String(req.body.dueDate) : null)
    : task.due_date;

  const assigneeId = req.body.assigneeId !== undefined
    ? (req.body.assigneeId ? Number(req.body.assigneeId) : null)
    : task.assignee_id;

  if (title.length < 2) return res.status(400).json({ error: "Task title is required" });
  if (!["backlog", "in_progress", "done"].includes(status)) {
    return res.status(400).json({ error: "Invalid task status" });
  }
  if (!["low", "medium", "high"].includes(priority)) {
    return res.status(400).json({ error: "Invalid task priority" });
  }

  if (assigneeId) {
    const isMember = db.prepare(`
      SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?
    `).get(task.project_id, assigneeId);
    if (!isMember) return res.status(400).json({ error: "Assignee must be a project member" });
  }

  db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, status = ?, priority = ?,
        assignee_id = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    title,
    description,
    status,
    priority,
    assigneeId,
    dueDate,
    task.id
  );

  const updated = getTask(task.id);
  const project = getProject(task.project_id);

  if (assigneeId && assigneeId !== task.assignee_id && assigneeId !== req.user.id) {
    createNotification({
      userId: assigneeId,
      projectId: task.project_id,
      taskId: task.id,
      type: "task_assigned",
      message: `You were assigned "${updated.title}" in ${project.name}`
    });
  }

  emitProject(task.project_id, {
    type: "task:updated",
    task: updated
  });

  res.json({ task: updated });
});

app.delete("/api/tasks/:id", auth, (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });

  const member = db.prepare(`
    SELECT role FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).get(task.project_id, req.user.id);

  if (!member) return res.status(403).json({ error: "You are not a project member" });

  db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);

  emitProject(task.project_id, {
    type: "task:deleted",
    taskId: task.id
  });

  res.json({ message: "Task deleted" });
});

// ---------- Comments ----------
app.get("/api/tasks/:id/comments", auth, (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });

  const member = db.prepare(`
    SELECT 1 FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).get(task.project_id, req.user.id);

  if (!member) return res.status(403).json({ error: "You are not a project member" });

  const comments = db.prepare(`
    SELECT
      c.id, c.task_id, c.user_id, c.body, c.created_at,
      u.name AS user_name, u.email AS user_email, u.avatar_color
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ?
    ORDER BY c.created_at ASC
  `).all(task.id);

  res.json({ comments });
});

app.post("/api/tasks/:id/comments", auth, (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: "Task not found" });

  const member = db.prepare(`
    SELECT 1 FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).get(task.project_id, req.user.id);

  if (!member) return res.status(403).json({ error: "You are not a project member" });

  const body = String(req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Comment cannot be empty" });
  if (body.length > 2000) return res.status(400).json({ error: "Comment is too long" });

  const result = db.prepare(`
    INSERT INTO comments (task_id, user_id, body)
    VALUES (?, ?, ?)
  `).run(task.id, req.user.id, body);

  const comment = db.prepare(`
    SELECT
      c.id, c.task_id, c.user_id, c.body, c.created_at,
      u.name AS user_name, u.email AS user_email, u.avatar_color
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);

  const members = getMembers(task.project_id).map((m) => m.id);
  const otherMembers = members.filter((id) => id !== req.user.id);

  if (otherMembers.length) {
    emitToUsers(otherMembers, {
      type: "comment:created",
      comment,
      taskId: task.id
    });
  }

  if (task.assignee_id && task.assignee_id !== req.user.id) {
    createNotification({
      userId: task.assignee_id,
      projectId: task.project_id,
      taskId: task.id,
      type: "comment",
      message: `${comment.user_name} commented on "${task.title}"`
    });
  }

  emitProject(task.project_id, {
    type: "task:comment_count_updated",
    taskId: task.id,
    count: db.prepare("SELECT COUNT(*) AS count FROM comments WHERE task_id = ?").get(task.id).count
  });

  res.status(201).json({ comment });
});

app.delete("/api/comments/:id", auth, (req, res) => {
  const comment = db.prepare(`
    SELECT c.*, t.project_id
    FROM comments c
    JOIN tasks t ON t.id = c.task_id
    WHERE c.id = ?
  `).get(Number(req.params.id));

  if (!comment) return res.status(404).json({ error: "Comment not found" });

  const member = db.prepare(`
    SELECT role FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).get(comment.project_id, req.user.id);

  if (!member) return res.status(403).json({ error: "You are not a project member" });
  if (comment.user_id !== req.user.id && member.role !== "owner") {
    return res.status(403).json({ error: "You can only delete your own comments" });
  }

  db.prepare("DELETE FROM comments WHERE id = ?").run(comment.id);

  emitProject(comment.project_id, {
    type: "comment:deleted",
    commentId: comment.id,
    taskId: comment.task_id
  });

  res.json({ message: "Comment deleted" });
});

// ---------- Notifications ----------
app.get("/api/notifications", auth, (req, res) => {
  const notifications = db.prepare(`
    SELECT *
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.user.id);

  res.json({ notifications });
});

app.put("/api/notifications/:id/read", auth, (req, res) => {
  db.prepare(`
    UPDATE notifications
    SET is_read = 1
    WHERE id = ? AND user_id = ?
  `).run(Number(req.params.id), req.user.id);

  res.json({ message: "Notification marked as read" });
});

app.put("/api/notifications/read-all", auth, (req, res) => {
  db.prepare(`
    UPDATE notifications
    SET is_read = 1
    WHERE user_id = ? AND is_read = 0
  `).run(req.user.id);

  res.json({ message: "All notifications marked as read" });
});

// ---------- Health ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "CollabBoard API" });
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on("connection", (socket, request) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(1008, "Authentication required");
      return;
    }

    const user = jwt.verify(token, JWT_SECRET);
    socket.userId = user.id;

    socket.send(JSON.stringify({
      type: "connected",
      message: "Real-time connection established"
    }));

    socket.on("message", (raw) => {try {
        const message = JSON.parse(raw.toString());
        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // Ignore invalid WebSocket messages.
      }
    });
  } catch {
    socket.close(1008, "Invalid token");
  }
});

server.listen(PORT, () => {
  console.log(`CollabBoard running at http://localhost:${PORT}`);
});
