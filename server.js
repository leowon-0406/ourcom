const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");
const { pool, query, transaction, initializeDatabase } = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET 환경 변수를 설정해주세요.");
}
if (isProduction && !process.env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD 환경 변수를 설정해주세요.");
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
    store: new pgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || "development-only-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 30
    }
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

const asyncHandler = handler => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            success: false,
            message: "로그인이 필요합니다."
        });
    }
    next();
}

function adminOnly(req, res, next) {
    if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({
            success: false,
            message: "관리자만 사용할 수 있습니다."
        });
    }
    next();
}

function chatTime() {
    return new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit"
    }).format(new Date());
}

function safeText(value, maxLength = 2000) {
    return typeof value === "string"
        ? value.trim().slice(0, maxLength)
        : "";
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function loginAttemptKey(req, id) {
    return `${req.ip}:${id || "unknown"}`;
}

function messagePage(rows) {
    return {
        messages: rows.slice(0, 50).reverse(),
        hasMore: rows.length > 50
    };
}

function beforeId(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requestedMessageIds(req) {
    return String(req.query.ids || "")
        .split(",")
        .map(Number)
        .filter(Number.isInteger)
        .slice(0, 500);
}

async function createAdmin() {
    const id = process.env.ADMIN_ID || "leowon0406";
    const name = process.env.ADMIN_NAME || "원준영";
    const password = process.env.ADMIN_PASSWORD || "development-password";
    const passwordHash = await bcrypt.hash(password, 12);

    await query(
        `INSERT INTO users (id, name, password, role)
         VALUES ($1, $2, $3, 'admin')
         ON CONFLICT (id) DO UPDATE SET role = 'admin'`,
        [id, name, passwordHash]
    );
}

async function getUsers() {
    const result = await query(
        "SELECT id, name, role FROM users ORDER BY name"
    );
    return result.rows;
}

app.post("/api/login", asyncHandler(async (req, res) => {
    const id = safeText(req.body.id, 80);
    const password = typeof req.body.password === "string"
        ? req.body.password
        : "";
    const attemptKey = loginAttemptKey(req, id);
    const now = Date.now();
    const previous = loginAttempts.get(attemptKey);
    const attempt = previous && now - previous.startedAt < LOGIN_WINDOW_MS
        ? previous
        : { count: 0, startedAt: now };

    if (attempt.count >= LOGIN_MAX_ATTEMPTS) {
        return res.status(429).json({
            success: false,
            message: "로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요."
        });
    }

    if (!id || !password) {
        return res.status(400).json({
            success: false,
            message: "아이디와 비밀번호를 입력해주세요."
        });
    }

    const result = await query(
        "SELECT id, name, password, role FROM users WHERE id = $1",
        [id]
    );
    const account = result.rows[0];
    const passwordMatches = account && account.password.startsWith("$2")
        ? await bcrypt.compare(password, account.password)
        : account && password === account.password;

    if (!passwordMatches) {
        attempt.count += 1;
        loginAttempts.set(attemptKey, attempt);
        return res.status(401).json({
            success: false,
            message: "아이디 또는 비밀번호가 올바르지 않습니다."
        });
    }

    loginAttempts.delete(attemptKey);

    const user = { id: account.id, name: account.name, role: account.role };
    req.session.user = user;
    await new Promise((resolve, reject) =>
        req.session.save(error => error ? reject(error) : resolve())
    );
    res.json({ success: true, user });
}));

app.get("/api/me", (req, res) => {
    if (!req.session.user) {
        return res.json({ loggedIn: false });
    }
    res.json({ loggedIn: true, user: req.session.user });
});

app.get("/api/users", requireLogin, asyncHandler(async (req, res) => {
    const users = (await getUsers()).filter(
        user => user.id !== req.session.user.id
    );
    res.json({ success: true, users });
}));

app.get("/api/admin/users", adminOnly, asyncHandler(async (req, res) => {
    const adminId = process.env.ADMIN_ID || "leowon0406";
    const result = await query(
        "SELECT id, name FROM users WHERE id <> $1 ORDER BY name",
        [adminId]
    );
    res.json({ success: true, users: result.rows });
}));

app.post("/api/admin/users", adminOnly, asyncHandler(async (req, res) => {
    const id = safeText(req.body.id, 80);
    const name = safeText(req.body.name, 80);
    const password = typeof req.body.password === "string"
        ? req.body.password
        : "";

    if (!id || !name || !password) {
        return res.status(400).json({
            success: false,
            message: "모든 항목을 입력해주세요."
        });
    }

    const exists = await query("SELECT 1 FROM users WHERE id = $1", [id]);
    if (exists.rowCount) {
        return res.status(400).json({
            success: false,
            message: "이미 존재하는 아이디입니다."
        });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await query(
        "INSERT INTO users (id, name, password, role) VALUES ($1, $2, $3, 'user')",
        [id, name, passwordHash]
    );
    res.json({
        success: true,
        message: `${name}님의 계정이 생성되었습니다.`
    });
}));

app.delete("/api/admin/users/:id", adminOnly, asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const adminId = process.env.ADMIN_ID || "leowon0406";

    if (userId === adminId) {
        return res.status(400).json({
            success: false,
            message: "초기 관리자는 삭제할 수 없습니다."
        });
    }

    await query("DELETE FROM users WHERE id = $1", [userId]);
    res.json({ success: true });
}));

app.get("/api/group-messages", requireLogin, asyncHandler(async (req, res) => {
    const before = beforeId(req.query.before);
    const result = await query(`
        SELECT m.id::int, m.user_id AS "userId", m.user_name AS name,
               m.text, m.time, (m.edited_at IS NOT NULL) AS edited,
               (m.deleted_at IS NOT NULL) AS deleted,
               m.reply_to_id::int AS "replyToId",
               reply.user_name AS "replyToName", reply.text AS "replyToText"
        FROM group_messages m
        LEFT JOIN group_messages reply ON reply.id = m.reply_to_id
        WHERE ($1::bigint IS NULL OR m.id < $1)
        ORDER BY m.id DESC
        LIMIT 51
    `, [before]);
    res.json({ success: true, ...messagePage(result.rows) });
}));

app.post("/api/group-read", requireLogin, asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body.messageIds)
        ? req.body.messageIds.map(Number).filter(Number.isInteger)
        : [];

    if (!Array.isArray(req.body.messageIds)) {
        return res.status(400).json({ success: false });
    }

    if (ids.length) {
        await query(`
            INSERT INTO group_reads (message_id, user_id)
            SELECT id, $2 FROM group_messages
            WHERE id = ANY($1::bigint[]) AND user_id <> $2
            ON CONFLICT DO NOTHING
        `, [ids, req.session.user.id]);
        io.emit("read-status-update");
    }
    res.json({ success: true });
}));

app.get("/api/group-unread-counts", requireLogin, asyncHandler(async (req, res) => {
    const ids = requestedMessageIds(req);
    if (!ids.length) return res.json({ success: true, counts: {} });
    const result = await query(`
        SELECT m.id::int,
               GREATEST(
                   (SELECT COUNT(*) FROM users u WHERE u.created_at <= m.created_at)
                   - 1 - COUNT(r.user_id),
                   0
               )::int AS count
        FROM group_messages m
        LEFT JOIN group_reads r ON r.message_id = m.id
        WHERE m.id = ANY($1::bigint[])
        GROUP BY m.id, m.created_at
    `, [ids]);
    const counts = Object.fromEntries(result.rows.map(row => [row.id, row.count]));
    res.json({ success: true, counts });
}));

app.get("/api/group-message/:messageId/unread-users", requireLogin,
    asyncHandler(async (req, res) => {
        const messageId = Number(req.params.messageId);
        const result = await query(`
            SELECT u.id, u.name
            FROM users u
            JOIN group_messages m ON m.id = $1
            WHERE u.id <> m.user_id
              AND u.created_at <= m.created_at
              AND NOT EXISTS (
                  SELECT 1 FROM group_reads r
                  WHERE r.message_id = m.id AND r.user_id = u.id
              )
            ORDER BY u.name
        `, [messageId]);
        res.json({ success: true, users: result.rows });
    })
);

app.get("/api/private-messages/:userId", requireLogin,
    asyncHandler(async (req, res) => {
        const me = req.session.user.id;
        const other = req.params.userId;
        const before = beforeId(req.query.before);
        const userResult = await query(
            "SELECT id, name, role FROM users WHERE id = $1",
            [other]
        );
        const otherUser = userResult.rows[0];

        if (!otherUser) {
            return res.status(404).json({
                success: false,
                message: "사용자를 찾을 수 없습니다."
            });
        }

        const result = await query(`
            SELECT m.id::int, m.from_id AS "fromId", m.from_name AS "fromName",
                   m.to_id AS "toId", m.text, m.time,
                   (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   m.reply_to_id::int AS "replyToId",
                   reply.from_name AS "replyToName", reply.text AS "replyToText"
            FROM private_messages m
            LEFT JOIN private_messages reply ON reply.id = m.reply_to_id
            WHERE ((m.from_id = $1 AND m.to_id = $2)
               OR (m.from_id = $2 AND m.to_id = $1))
              AND ($3::bigint IS NULL OR m.id < $3)
            ORDER BY m.id DESC
            LIMIT 51
        `, [me, other, before]);
        res.json({ success: true, user: otherUser, ...messagePage(result.rows) });
    })
);

app.post("/api/private-messages/:userId", requireLogin,
    asyncHandler(async (req, res) => {
        const from = req.session.user;
        const toId = req.params.userId;
        const text = safeText(req.body.text);
        const requestedReplyId = Number(req.body.replyToId);
        let reply = null;

        if (!text) {
            return res.status(400).json({
                success: false,
                message: "메시지를 입력해주세요."
            });
        }

        const target = await query("SELECT 1 FROM users WHERE id = $1", [toId]);
        if (!target.rowCount) {
            return res.status(404).json({
                success: false,
                message: "상대방을 찾을 수 없습니다."
            });
        }

        if (Number.isInteger(requestedReplyId)) {
            const replyResult = await query(`
                SELECT id::int, from_name AS "replyToName", text AS "replyToText"
                FROM private_messages
                WHERE id = $1
                  AND ((from_id = $2 AND to_id = $3)
                    OR (from_id = $3 AND to_id = $2))
            `, [requestedReplyId, from.id, toId]);
            reply = replyResult.rows[0] || null;
        }

        const time = chatTime();
        const result = await query(`
            INSERT INTO private_messages
                (from_id, from_name, to_id, text, time, reply_to_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id::int
        `, [from.id, from.name, toId, text, time, reply && reply.id]);
        const message = {
            id: result.rows[0].id,
            fromId: from.id,
            fromName: from.name,
            toId,
            text,
            time,
            replyToId: reply && reply.id,
            replyToName: reply && reply.replyToName,
            replyToText: reply && reply.replyToText
        };
        io.to(`private:${from.id}`).to(`private:${toId}`)
            .emit("private message", message);
        res.json({ success: true, message });
    })
);

app.post("/api/private-read", requireLogin, asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body.messageIds)) {
        return res.status(400).json({ success: false });
    }
    const ids = req.body.messageIds.map(Number).filter(Number.isInteger);

    if (ids.length) {
        await query(`
            INSERT INTO private_reads (message_id, user_id)
            SELECT id, $2 FROM private_messages
            WHERE id = ANY($1::bigint[]) AND to_id = $2
            ON CONFLICT DO NOTHING
        `, [ids, req.session.user.id]);
        const senders = await query(`
            SELECT DISTINCT from_id
            FROM private_messages
            WHERE id = ANY($1::bigint[]) AND to_id = $2
        `, [ids, req.session.user.id]);
        io.to(`private:${req.session.user.id}`).emit("private-read-update");
        senders.rows.forEach(row => {
            io.to(`private:${row.from_id}`).emit("private-read-update");
        });
    }
    res.json({ success: true });
}));

app.get("/api/private-unread-counts", requireLogin,
    asyncHandler(async (req, res) => {
        const me = req.session.user.id;
        const result = await query(`
            SELECT u.id,
                   COUNT(m.id) FILTER (WHERE r.message_id IS NULL)::int AS count
            FROM users u
            LEFT JOIN private_messages m
              ON m.from_id = u.id AND m.to_id = $1
            LEFT JOIN private_reads r
              ON r.message_id = m.id AND r.user_id = $1
            WHERE u.id <> $1
            GROUP BY u.id
        `, [me]);
        const counts = Object.fromEntries(result.rows.map(row => [row.id, row.count]));
        res.json({ success: true, counts });
    })
);

app.get("/api/private-message-status/:userId", requireLogin,
    asyncHandler(async (req, res) => {
        const me = req.session.user.id;
        const other = req.params.userId;
        const ids = requestedMessageIds(req);
        if (!ids.length) return res.json({ success: true, counts: {} });
        const result = await query(`
            SELECT m.id::int,
                   CASE WHEN r.message_id IS NULL THEN 1 ELSE 0 END AS count
            FROM private_messages m
            LEFT JOIN private_reads r
              ON r.message_id = m.id AND r.user_id = m.to_id
            WHERE ((m.from_id = $1 AND m.to_id = $2)
               OR (m.from_id = $2 AND m.to_id = $1))
              AND m.id = ANY($3::bigint[])
        `, [me, other, ids]);
        const counts = Object.fromEntries(
            result.rows.map(row => [row.id, Number(row.count)])
        );
        res.json({ success: true, counts });
    })
);

app.get("/api/private-message/:messageId/unread-users", requireLogin,
    asyncHandler(async (req, res) => {
        const messageId = Number(req.params.messageId);
        const me = req.session.user.id;
        const result = await query(`
            SELECT u.id, u.name
            FROM private_messages m
            JOIN users u ON u.id = m.to_id
            LEFT JOIN private_reads r
              ON r.message_id = m.id AND r.user_id = m.to_id
            WHERE m.id = $1
              AND (m.from_id = $2 OR m.to_id = $2)
              AND r.message_id IS NULL
        `, [messageId, me]);
        res.json({ success: true, users: result.rows });
    })
);

app.get("/api/chat-rooms", requireLogin, asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT r.id::int, r.name, r.creator_id AS "creatorId",
               r.creator_name AS "creatorName", r.created_at AS "createdAt",
               COUNT(all_members.user_id)::int AS "memberCount"
        FROM group_rooms r
        JOIN group_room_members mine
          ON mine.room_id = r.id AND mine.user_id = $1
        LEFT JOIN group_room_members all_members ON all_members.room_id = r.id
        GROUP BY r.id
        ORDER BY r.id DESC
    `, [req.session.user.id]);
    res.json({ success: true, rooms: result.rows });
}));

app.post("/api/chat-rooms", requireLogin, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const name = safeText(req.body.name, 50);
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
    const ids = [...new Set([user.id, ...memberIds])]
        .filter(id => typeof id === "string" && id.trim());

    if (!name) {
        return res.status(400).json({
            success: false,
            message: "채팅방 이름을 입력해주세요."
        });
    }
    if (ids.length < 2) {
        return res.status(400).json({
            success: false,
            message: "최소 1명 이상의 친구를 선택해주세요."
        });
    }

    const usersResult = await query(
        "SELECT id, name FROM users WHERE id = ANY($1::text[])",
        [ids]
    );
    if (usersResult.rowCount !== ids.length) {
        return res.status(400).json({
            success: false,
            message: "존재하지 않는 사용자가 포함되어 있습니다."
        });
    }

    const room = await transaction(async client => {
        const roomResult = await client.query(`
            INSERT INTO group_rooms (name, creator_id, creator_name)
            VALUES ($1, $2, $3)
            RETURNING id::int, name, creator_id AS "creatorId",
                      creator_name AS "creatorName", created_at AS "createdAt"
        `, [name, user.id, user.name]);
        const created = roomResult.rows[0];

        for (const member of usersResult.rows) {
            await client.query(`
                INSERT INTO group_room_members (room_id, user_id, user_name)
                VALUES ($1, $2, $3)
            `, [created.id, member.id, member.name]);
        }
        return created;
    });
    res.json({ success: true, room });
}));

app.get("/api/chat-rooms/:roomId", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const result = await query(`
            SELECT r.id::int, r.name, r.creator_id AS "creatorId",
                   r.creator_name AS "creatorName", r.created_at AS "createdAt"
            FROM group_rooms r
            JOIN group_room_members m
              ON m.room_id = r.id AND m.user_id = $2
            WHERE r.id = $1
        `, [roomId, req.session.user.id]);
        const room = result.rows[0];

        if (!room) {
            return res.status(404).json({
                success: false,
                message: "채팅방을 찾을 수 없거나 멤버가 아닙니다."
            });
        }

        const members = await query(`
            SELECT user_id AS id, user_name AS name
            FROM group_room_members
            WHERE room_id = $1
            ORDER BY user_name
        `, [roomId]);
        res.json({ success: true, room, members: members.rows });
    })
);

app.get("/api/chat-rooms/:roomId/messages", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const before = beforeId(req.query.before);
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, req.session.user.id]
        );
        if (!member.rowCount) {
            return res.status(403).json({
                success: false,
                message: "채팅방 멤버가 아닙니다."
            });
        }
        const result = await query(`
            SELECT m.id::int, m.user_id AS "userId", m.user_name AS "userName",
                   m.text, m.time, (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   reply.user_name AS "replyToName", reply.text AS "replyToText"
            FROM group_room_messages m
            LEFT JOIN group_room_messages reply ON reply.id = m.reply_to_id
            WHERE m.room_id = $1
              AND ($2::bigint IS NULL OR m.id < $2)
            ORDER BY m.id DESC
            LIMIT 51
        `, [roomId, before]);
        res.json({ success: true, ...messagePage(result.rows) });
    })
);

app.post("/api/chat-rooms/:roomId/read", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const userId = req.session.user.id;
        const ids = Array.isArray(req.body.messageIds)
            ? req.body.messageIds.map(Number).filter(Number.isInteger)
            : [];
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, userId]
        );
        if (!member.rowCount) {
            return res.status(403).json({ success: false });
        }
        if (ids.length) {
            await query(`
                INSERT INTO group_room_reads (message_id, user_id)
                SELECT id, $3 FROM group_room_messages
                WHERE room_id = $1 AND id = ANY($2::bigint[]) AND user_id <> $3
                ON CONFLICT DO NOTHING
            `, [roomId, ids, userId]);
            io.to(`chatroom:${roomId}`).emit("chat-room-read-update", { roomId });
        }
        res.json({ success: true });
    })
);

app.get("/api/chat-rooms/:roomId/unread-counts", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const userId = req.session.user.id;
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, userId]
        );
        if (!member.rowCount) {
            return res.status(403).json({ success: false });
        }
        const ids = requestedMessageIds(req);
        if (!ids.length) return res.json({ success: true, counts: {} });
        const result = await query(`
            SELECT m.id::int,
                   GREATEST(
                       (SELECT COUNT(*) FROM group_room_members WHERE room_id = $1)
                       - 1 - COUNT(r.user_id),
                       0
                   )::int AS count
            FROM group_room_messages m
            LEFT JOIN group_room_reads r ON r.message_id = m.id
            WHERE m.room_id = $1 AND m.id = ANY($2::bigint[])
            GROUP BY m.id
        `, [roomId, ids]);
        const counts = Object.fromEntries(result.rows.map(row => [row.id, row.count]));
        res.json({ success: true, counts });
    })
);

app.get("/api/chat-rooms/:roomId/message/:messageId/unread-users", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const messageId = Number(req.params.messageId);
        const userId = req.session.user.id;
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, userId]
        );
        if (!member.rowCount) {
            return res.status(403).json({ success: false });
        }
        const result = await query(`
            SELECT members.user_id AS id, members.user_name AS name
            FROM group_room_members members
            JOIN group_room_messages m ON m.id = $2 AND m.room_id = $1
            WHERE members.room_id = $1
              AND members.user_id <> m.user_id
              AND NOT EXISTS (
                  SELECT 1 FROM group_room_reads reads
                  WHERE reads.message_id = m.id
                    AND reads.user_id = members.user_id
              )
            ORDER BY members.user_name
        `, [roomId, messageId]);
        res.json({ success: true, users: result.rows });
    })
);

app.get("/api/unread-summary", requireLogin, asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const result = await query(`
        SELECT
            (SELECT COUNT(*)::int
             FROM group_messages m
             WHERE m.user_id <> $1
               AND m.created_at >= (SELECT created_at FROM users WHERE id = $1)
               AND NOT EXISTS (
                   SELECT 1 FROM group_reads r
                   WHERE r.message_id = m.id AND r.user_id = $1
               )) AS "globalCount",
            (SELECT COUNT(*)::int
             FROM private_messages m
             WHERE m.to_id = $1
               AND NOT EXISTS (
                   SELECT 1 FROM private_reads r
                   WHERE r.message_id = m.id AND r.user_id = $1
               )) AS "privateCount",
            (SELECT COUNT(*)::int
             FROM group_room_messages m
             JOIN group_room_members member
               ON member.room_id = m.room_id AND member.user_id = $1
             WHERE m.user_id <> $1
               AND NOT EXISTS (
                   SELECT 1 FROM group_room_reads r
                   WHERE r.message_id = m.id AND r.user_id = $1
               )) AS "roomCount"
    `, [userId]);
    const counts = result.rows[0];
    res.json({
        success: true,
        ...counts,
        hasUnread: counts.globalCount + counts.privateCount + counts.roomCount > 0
    });
}));

app.delete("/api/chat-rooms/:roomId/leave", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const result = await query(
            "DELETE FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, req.session.user.id]
        );
        if (!result.rowCount) {
            return res.status(404).json({
                success: false,
                message: "채팅방을 찾을 수 없거나 멤버가 아닙니다."
            });
        }
        await query(`
            DELETE FROM group_rooms r
            WHERE r.id = $1
              AND NOT EXISTS (
                  SELECT 1 FROM group_room_members m WHERE m.room_id = r.id
              )
        `, [roomId]);
        res.json({ success: true });
    })
);

app.post("/api/logout", (req, res, next) => {
    req.session.destroy(error => {
        if (error) return next(error);
        res.clearCookie("connect.sid");
        res.json({ success: true });
    });
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
    const socketSession = socket.request.session;
    if (!socketSession || !socketSession.user) {
        return next(new Error("로그인이 필요합니다."));
    }
    socket.user = socketSession.user;
    next();
});

io.on("connection", socket => {
    const userId = socket.user.id;
    socket.join(`private:${userId}`);

    const guard = handler => async (...args) => {
        try {
            await handler(...args);
        } catch (error) {
            console.error("Socket 오류:", error);
            socket.emit("server error", "요청을 처리하지 못했습니다.");
        }
    };

    socket.on("join group", guard(async () => {
        socket.join("group");
        const result = await query(`
            SELECT m.id::int, m.user_id AS "userId", m.user_name AS name,
                   m.text, m.time, (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   reply.user_name AS "replyToName", reply.text AS "replyToText"
            FROM group_messages m
            LEFT JOIN group_messages reply ON reply.id = m.reply_to_id
            ORDER BY m.id DESC
            LIMIT 51
        `);
        socket.emit("group history", messagePage(result.rows));
    }));

    socket.on("group message", guard(async value => {
        const data = typeof value === "string" ? { text: value } : value;
        const text = safeText(data && data.text);
        const clientId = safeText(data && data.clientId, 80) || null;
        if (!text) return;
        const requestedReplyId = Number(data && data.replyToId);
        let reply = null;
        if (Number.isInteger(requestedReplyId)) {
            const replyResult = await query(`
                SELECT id::int, user_name AS "replyToName", text AS "replyToText"
                FROM group_messages WHERE id = $1
            `, [requestedReplyId]);
            reply = replyResult.rows[0] || null;
        }
        const time = chatTime();
        const result = await query(`
            INSERT INTO group_messages
                (user_id, user_name, text, time, reply_to_id, client_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL
            DO UPDATE SET client_id = EXCLUDED.client_id
            RETURNING id::int, time
        `, [userId, socket.user.name, text, time, reply && reply.id, clientId]);
        io.to("group").emit("group message", {
            id: result.rows[0].id,
            userId,
            name: socket.user.name,
            text,
            time: result.rows[0].time,
            replyToId: reply && reply.id,
            replyToName: reply && reply.replyToName,
            replyToText: reply && reply.replyToText,
            clientId
        });
    }));

    socket.on("mark messages read", guard(async values => {
        const ids = Array.isArray(values)
            ? values.map(Number).filter(Number.isInteger)
            : [];
        if (!ids.length) return;
        await query(`
            INSERT INTO group_reads (message_id, user_id)
            SELECT id, $2 FROM group_messages
            WHERE id = ANY($1::bigint[]) AND user_id <> $2
            ON CONFLICT DO NOTHING
        `, [ids, userId]);
        io.emit("read-status-update");
    }));

    socket.on("join private", guard(async otherId => {
        if (typeof otherId !== "string" || otherId === userId) return;
        const otherResult = await query(
            "SELECT id, name FROM users WHERE id = $1",
            [otherId]
        );
        if (!otherResult.rowCount) return;
        const result = await query(`
            SELECT m.id::int, m.from_id AS "fromId", m.from_name AS "fromName",
                   m.to_id AS "toId", m.text, m.time,
                   (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   m.reply_to_id::int AS "replyToId",
                   reply.from_name AS "replyToName", reply.text AS "replyToText"
            FROM private_messages m
            LEFT JOIN private_messages reply ON reply.id = m.reply_to_id
            WHERE (m.from_id = $1 AND m.to_id = $2)
               OR (m.from_id = $2 AND m.to_id = $1)
            ORDER BY m.id DESC
            LIMIT 51
        `, [userId, otherId]);
        const page = messagePage(result.rows);
        socket.emit("private history", {
            user: otherResult.rows[0],
            ...page
        });
    }));

    socket.on("private message", guard(async data => {
        if (!data || typeof data.toId !== "string") return;
        const toId = data.toId;
        const text = safeText(data.text);
        const clientId = safeText(data.clientId, 80) || null;
        if (!text || toId === userId) return;
        const target = await query("SELECT 1 FROM users WHERE id = $1", [toId]);
        if (!target.rowCount) return;
        const requestedReplyId = Number(data.replyToId);
        let reply = null;
        if (Number.isInteger(requestedReplyId)) {
            const replyResult = await query(`
                SELECT id::int, from_name AS "replyToName", text AS "replyToText"
                FROM private_messages
                WHERE id = $1
                  AND ((from_id = $2 AND to_id = $3)
                    OR (from_id = $3 AND to_id = $2))
            `, [requestedReplyId, userId, toId]);
            reply = replyResult.rows[0] || null;
        }
        const time = chatTime();
        const result = await query(`
            INSERT INTO private_messages
                (from_id, from_name, to_id, text, time, reply_to_id, client_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (from_id, client_id) WHERE client_id IS NOT NULL
            DO UPDATE SET client_id = EXCLUDED.client_id
            RETURNING id::int, time
        `, [userId, socket.user.name, toId, text, time, reply && reply.id, clientId]);
        const message = {
            id: result.rows[0].id,
            fromId: userId,
            fromName: socket.user.name,
            toId,
            text,
            time: result.rows[0].time,
            replyToId: reply && reply.id,
            replyToName: reply && reply.replyToName,
            replyToText: reply && reply.replyToText,
            clientId
        };
        io.to(`private:${userId}`).to(`private:${toId}`)
            .emit("private message", message);
    }));

    socket.on("join chat room", guard(async value => {
        const roomId = Number(value);
        if (!Number.isInteger(roomId)) return;
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, userId]
        );
        if (!member.rowCount) {
            return socket.emit("chat room error", "이 채팅방의 멤버가 아닙니다.");
        }
        socket.join(`chatroom:${roomId}`);
        const result = await query(`
            SELECT m.id::int, m.user_id AS "userId", m.user_name AS "userName",
                   m.text, m.time, (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   reply.user_name AS "replyToName", reply.text AS "replyToText"
            FROM group_room_messages m
            LEFT JOIN group_room_messages reply ON reply.id = m.reply_to_id
            WHERE m.room_id = $1
            ORDER BY m.id DESC
            LIMIT 51
        `, [roomId]);
        socket.emit("chat room history", { roomId, ...messagePage(result.rows) });
    }));

    socket.on("chat room message", guard(async data => {
        const roomId = Number(data && data.roomId);
        const text = safeText(data && data.text);
        const clientId = safeText(data && data.clientId, 80) || null;
        const requestedReplyId = Number(data && data.replyToId);
        if (!Number.isInteger(roomId) || !text) return;
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, userId]
        );
        if (!member.rowCount) return;
        let reply = null;
        if (Number.isInteger(requestedReplyId) && requestedReplyId > 0) {
            const replyResult = await query(`
                SELECT id::int, user_name AS "replyToName", text AS "replyToText"
                FROM group_room_messages
                WHERE id = $1 AND room_id = $2
            `, [requestedReplyId, roomId]);
            reply = replyResult.rows[0] || null;
            if (!reply) return;
        }
        const time = chatTime();
        const result = await query(`
            INSERT INTO group_room_messages
                (room_id, user_id, user_name, text, time, reply_to_id, client_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (room_id, user_id, client_id) WHERE client_id IS NOT NULL
            DO UPDATE SET client_id = EXCLUDED.client_id
            RETURNING id::int, time
        `, [roomId, userId, socket.user.name, text, time, reply && reply.id, clientId]);
        io.to(`chatroom:${roomId}`).emit("chat room message", {
            id: result.rows[0].id,
            roomId,
            userId,
            userName: socket.user.name,
            text,
            time: result.rows[0].time,
            replyToId: reply && reply.id,
            replyToName: reply && reply.replyToName,
            replyToText: reply && reply.replyToText,
            clientId
        });
    }));

    socket.on("edit group message", guard(async data => {
        const messageId = Number(data && data.messageId);
        const text = safeText(data && data.text);
        if (!Number.isInteger(messageId) || !text) return;
        const result = await query(`
            UPDATE group_messages
            SET text = $1, edited_at = NOW()
            WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
            RETURNING id::int
        `, [text, messageId, userId]);
        if (!result.rowCount) return;
        io.to("group").emit("group message updated", {
            id: result.rows[0].id, text, edited: true, deleted: false
        });
    }));

    socket.on("delete group message", guard(async data => {
        const messageId = Number(data && data.messageId);
        if (!Number.isInteger(messageId)) return;
        const result = await query(`
            UPDATE group_messages
            SET text = '삭제된 메시지', deleted_at = NOW(), edited_at = NULL
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            RETURNING id::int
        `, [messageId, userId]);
        if (!result.rowCount) return;
        io.to("group").emit("group message updated", {
            id: result.rows[0].id,
            text: "삭제된 메시지",
            edited: false,
            deleted: true
        });
    }));

    socket.on("edit private message", guard(async data => {
        const messageId = Number(data && data.messageId);
        const text = safeText(data && data.text);
        if (!Number.isInteger(messageId) || !text) return;
        const result = await query(`
            UPDATE private_messages
            SET text = $1, edited_at = NOW()
            WHERE id = $2 AND from_id = $3 AND deleted_at IS NULL
            RETURNING id::int, from_id, to_id
        `, [text, messageId, userId]);
        if (!result.rowCount) return;
        const row = result.rows[0];
        io.to(`private:${row.from_id}`).to(`private:${row.to_id}`)
            .emit("private message updated", {
                id: row.id, text, edited: true, deleted: false
            });
    }));

    socket.on("delete private message", guard(async data => {
        const messageId = Number(data && data.messageId);
        if (!Number.isInteger(messageId)) return;
        const result = await query(`
            UPDATE private_messages
            SET text = '삭제된 메시지', deleted_at = NOW(), edited_at = NULL
            WHERE id = $1 AND from_id = $2 AND deleted_at IS NULL
            RETURNING id::int, from_id, to_id
        `, [messageId, userId]);
        if (!result.rowCount) return;
        const row = result.rows[0];
        io.to(`private:${row.from_id}`).to(`private:${row.to_id}`)
            .emit("private message updated", {
                id: row.id,
                text: "삭제된 메시지",
                edited: false,
                deleted: true
            });
    }));

    socket.on("edit chat room message", guard(async data => {
        const messageId = Number(data && data.messageId);
        const roomId = Number(data && data.roomId);
        const text = safeText(data && data.text);
        if (!Number.isInteger(messageId) || !Number.isInteger(roomId) || !text) return;
        const result = await query(`
            UPDATE group_room_messages
            SET text = $1, edited_at = NOW()
            WHERE id = $2 AND room_id = $3 AND user_id = $4 AND deleted_at IS NULL
            RETURNING id::int
        `, [text, messageId, roomId, userId]);
        if (!result.rowCount) return;
        io.to(`chatroom:${roomId}`).emit("chat room message updated", {
            id: result.rows[0].id, roomId, text, edited: true, deleted: false
        });
    }));

    socket.on("delete chat room message", guard(async data => {
        const messageId = Number(data && data.messageId);
        const roomId = Number(data && data.roomId);
        if (!Number.isInteger(messageId) || !Number.isInteger(roomId)) return;
        const result = await query(`
            UPDATE group_room_messages
            SET text = '삭제된 메시지', deleted_at = NOW(), edited_at = NULL
            WHERE id = $1 AND room_id = $2 AND user_id = $3 AND deleted_at IS NULL
            RETURNING id::int
        `, [messageId, roomId, userId]);
        if (!result.rowCount) return;
        io.to(`chatroom:${roomId}`).emit("chat room message updated", {
            id: result.rows[0].id,
            roomId,
            text: "삭제된 메시지",
            edited: false,
            deleted: true
        });
    }));
});

app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    res.status(500).json({
        success: false,
        message: "서버 오류가 발생했습니다."
    });
});

async function start() {
    await initializeDatabase();
    await createAdmin();
    server.listen(PORT, () => {
        console.log(`OURCOM 서버 실행: ${PORT}번 포트`);
    });
}

start().catch(error => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
