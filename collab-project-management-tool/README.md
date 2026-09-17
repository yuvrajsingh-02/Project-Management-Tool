# CollabBoard — Project Management Tool

A full-stack Trello/Asana-style collaborative project management application built with:

- Node.js + Express
- SQLite + better-sqlite3
- JWT authentication
- bcrypt password hashing
- Vanilla HTML/CSS/JavaScript
- WebSockets (`ws`) for real-time project updates

## Features

- Register and login
- Create group projects
- Add project members by email
- Project boards with Backlog, In Progress and Done columns
- Create, edit and delete tasks
- Assign tasks to project members
- Task priority and due dates
- Drag-and-drop task status updates
- Task comments and communication
- Real-time board/comment updates through WebSockets
- In-app notifications
- Responsive UI
- Protected API routes

## Requirements

Node.js 18+ recommended.

## Run

```bash
npm install
npm start
```

Then open:

http://localhost:3000

For development:

```bash
npm run dev
```

## Demo accounts

The server creates these accounts automatically:

- `demo@example.com` / `Demo@123`
- `alex@example.com` / `Alex@123`

You can also create your own account from the Register page.

## Project structure

```text
collab-project-management-tool/
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── data/
│   └── app.db                # created automatically
├── package.json
├── server.js
└── README.md
```

## API overview

Authentication:
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

Projects:
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `POST /api/projects/:id/members`
- `DELETE /api/projects/:id/members/:userId`
- `DELETE /api/projects/:id`

Tasks:
- `POST /api/projects/:id/tasks`
- `PUT /api/tasks/:id`
- `DELETE /api/tasks/:id`

Comments:
- `GET /api/tasks/:id/comments`
- `POST /api/tasks/:id/comments`
- `DELETE /api/comments/:id`

Notifications:
- `GET /api/notifications`
- `PUT /api/notifications/:id/read`
- `PUT /api/notifications/read-all`

WebSocket:
- Connect to `ws://localhost:3000?token=<JWT>`
- Messages are JSON objects such as `project:created`, `task:updated`, `comment:created`, and `notification:new`.

## Important

This is a strong internship/resume project, but before production deployment you should add:
- environment variables for JWT secrets
- HTTPS/WSS
- rate limiting
- stronger validation
- refresh tokens
- password reset/email verification
- file attachments
- persistent WebSocket scaling (Redis/pub-sub)
- automated tests
