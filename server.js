const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const webpush = require("web-push");
const { Server } = require("socket.io");
const { pool, query, transaction, initializeDatabase } = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";
let vapidPublicKey = null;
const onlineUsers = new Map();
const activityUpdates = new Map();

if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET 환경 변수를 설정해주세요.");
}
if (isProduction && !process.env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD 환경 변수를 설정해주세요.");
}
if (isProduction && !process.env.ADMIN_2FA_CODE) {
    throw new Error("ADMIN_2FA_CODE 환경 변수를 설정해주세요.");
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
app.use((req, res, next) => {
    const userId = req.session && req.session.user && req.session.user.id;
    if (userId) {
        const now = Date.now();
        if (now - (activityUpdates.get(userId) || 0) > 60_000) {
            activityUpdates.set(userId, now);
            void query("UPDATE users SET last_active_at = NOW() WHERE id = $1", [userId])
                .catch(error => console.error("활동 상태 갱신 오류:", error.message));
        }
    }
    next();
});
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

function validUserId(value) {
    return /^[A-Za-z0-9._-]{3,30}$/.test(value);
}

function timingSafeTextEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ""));
    const rightBuffer = Buffer.from(String(right || ""));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const CLOUDINARY_TYPES = new Set(["image", "video", "raw"]);
const ATTACHMENT_LIMITS = { image: 10 * 1024 * 1024, video: 40 * 1024 * 1024, raw: 10 * 1024 * 1024 };

function cloudinaryReady() {
    return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function uploadFolder(userId) {
    const owner = crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 16);
    return `ourcom/${owner}`;
}

function cloudinarySignature(params) {
    const payload = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join("&");
    return crypto.createHash("sha1").update(payload + process.env.CLOUDINARY_API_SECRET).digest("hex");
}

function safeAttachment(value, userId) {
    if (!value || typeof value !== "object") return null;
    const resourceType = safeText(value.resourceType, 10);
    const publicId = safeText(value.publicId, 300);
    const secureUrl = safeText(value.secureUrl, 1000);
    const fileName = safeText(value.fileName, 200);
    const mimeType = safeText(value.mimeType, 100).toLowerCase();
    const bytes = Number(value.bytes);
    if (!CLOUDINARY_TYPES.has(resourceType) || !publicId.startsWith(`${uploadFolder(userId)}/`)) return null;
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > ATTACHMENT_LIMITS[resourceType]) return null;
    if ((resourceType === "image" && !/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) ||
        (resourceType === "video" && !/^video\/(mp4|webm)$/.test(mimeType)) ||
        (resourceType === "raw" && mimeType !== "application/pdf")) return null;
    try {
        const url = new URL(secureUrl);
        if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" ||
            !url.pathname.startsWith(`/${process.env.CLOUDINARY_CLOUD_NAME}/`)) return null;
    } catch {
        return null;
    }
    return { resourceType, publicId, secureUrl, fileName: fileName || "파일", mimeType, bytes };
}

async function destroyAttachment(attachment) {
    if (!cloudinaryReady() || !attachment || !CLOUDINARY_TYPES.has(attachment.resourceType)) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: attachment.publicId, timestamp };
    const body = new URLSearchParams({
        ...params,
        api_key: process.env.CLOUDINARY_API_KEY,
        signature: cloudinarySignature(params)
    });
    try {
        const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(process.env.CLOUDINARY_CLOUD_NAME)}/${attachment.resourceType}/destroy`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        });
        if (!response.ok) console.error("Cloudinary 파일 삭제 실패:", response.status);
    } catch (error) {
        console.error("Cloudinary 파일 삭제 오류:", error.message);
    }
}

const loginAttempts = new Map();
const registrationAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const REGISTER_MAX_ATTEMPTS = 10;
const GAME_RULES = Object.freeze({
    reaction: { minMs: 1200, maxMs: 15_000, maxScore: 950 },
    snake: { minMs: 1000, maxMs: 30 * 60_000, maxScore: 50_000 },
    obstacle: { minMs: 1000, maxMs: 30 * 60_000, maxScore: 100_000 },
    mole: { minMs: 15_000, maxMs: 60_000, maxScore: 5_000 }
});

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

async function initializePushNotifications() {
    let publicKey = process.env.VAPID_PUBLIC_KEY || "";
    let privateKey = process.env.VAPID_PRIVATE_KEY || "";

    if (!publicKey || !privateKey) {
        const saved = await query(
            "SELECT key, value FROM app_settings WHERE key = ANY($1::text[])",
            [["vapid_public_key", "vapid_private_key"]]
        );
        const settings = Object.fromEntries(saved.rows.map(row => [row.key, row.value]));
        publicKey = settings.vapid_public_key || "";
        privateKey = settings.vapid_private_key || "";
    }

    if (!publicKey || !privateKey) {
        const generated = webpush.generateVAPIDKeys();
        publicKey = generated.publicKey;
        privateKey = generated.privateKey;
        await transaction(async client => {
            await client.query(`
                INSERT INTO app_settings (key, value)
                VALUES ('vapid_public_key', $1), ('vapid_private_key', $2)
                ON CONFLICT (key) DO NOTHING
            `, [publicKey, privateKey]);
            const stored = await client.query(
                "SELECT key, value FROM app_settings WHERE key = ANY($1::text[])",
                [["vapid_public_key", "vapid_private_key"]]
            );
            const values = Object.fromEntries(stored.rows.map(row => [row.key, row.value]));
            publicKey = values.vapid_public_key;
            privateKey = values.vapid_private_key;
        });
    }

    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "https://ourcom.onrender.com",
        publicKey,
        privateKey
    );
    vapidPublicKey = publicKey;
}

function safePushSubscription(value) {
    if (!value || typeof value !== "object" || typeof value.endpoint !== "string" ||
        !value.keys || typeof value.keys.p256dh !== "string" || typeof value.keys.auth !== "string") return null;
    try {
        const endpoint = new URL(value.endpoint);
        if (endpoint.protocol !== "https:") return null;
    } catch {
        return null;
    }
    if (value.endpoint.length > 2000 || value.keys.p256dh.length > 500 || value.keys.auth.length > 200) return null;
    return {
        endpoint: value.endpoint,
        expirationTime: Number.isFinite(value.expirationTime) ? value.expirationTime : null,
        keys: { p256dh: value.keys.p256dh, auth: value.keys.auth }
    };
}

async function sendPushToUsers(userIds, payload) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length || !vapidPublicKey) return;
    try {
        const subscriptions = await query(`
            SELECT endpoint, subscription
            FROM push_subscriptions
            WHERE user_id = ANY($1::text[])
        `, [ids]);
        await Promise.all(subscriptions.rows.map(async row => {
            try {
                await webpush.sendNotification(row.subscription, JSON.stringify(payload), { TTL: 120 });
            } catch (error) {
                if (error.statusCode === 404 || error.statusCode === 410) {
                    await query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
                } else {
                    console.error("푸시 알림 전송 오류:", error.statusCode || error.message);
                }
            }
        }));
    } catch (error) {
        console.error("푸시 알림 처리 오류:", error.message);
    }
}

async function pushToAllExcept(senderId, payload) {
    try {
        const result = await query("SELECT id FROM users WHERE id <> $1", [senderId]);
        await sendPushToUsers(result.rows.map(row => row.id), payload);
    } catch (error) {
        console.error("전체 푸시 대상 조회 오류:", error.message);
    }
}

async function pushToRoom(roomId, senderId, payload) {
    try {
        const result = await query(
            "SELECT user_id FROM group_room_members WHERE room_id = $1 AND user_id <> $2",
            [roomId, senderId]
        );
        await sendPushToUsers(result.rows.map(row => row.user_id), payload);
    } catch (error) {
        console.error("단톡방 푸시 대상 조회 오류:", error.message);
    }
}

async function notifyRoomMembers(roomId, event, payload = {}) {
    const result = await query("SELECT user_id FROM group_room_members WHERE room_id = $1", [roomId]);
    result.rows.forEach(row => io.to(`private:${row.user_id}`).emit(event, { roomId, ...payload }));
}

function pushMessageBody(senderName, text, attachment) {
    const content = text || (attachment ? `📎 ${attachment.fileName || "파일"}` : "새 메시지");
    return `${senderName}: ${content}`.slice(0, 120);
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
    const existing = await query("UPDATE users SET role = 'admin' WHERE id = $1 RETURNING id", [id]);
    if (existing.rowCount) return;
    const passwordHash = await bcrypt.hash(password, 12);

    await query(
        `INSERT INTO users (id, name, password, role) VALUES ($1, $2, $3, 'admin')`,
        [id, name, passwordHash]
    );
}

app.post("/api/register", asyncHandler(async (req, res) => {
    const id = safeText(req.body.id, 30);
    const name = safeText(req.body.name, 40);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!validUserId(id)) {
        return res.status(400).json({ success: false, message: "아이디는 영문, 숫자, 점, 밑줄, 하이픈으로 3~30자만 사용할 수 있습니다." });
    }
    if (!name || name.length > 40 || password.length < 6 || password.length > 100) {
        return res.status(400).json({ success: false, message: "이름과 6자 이상의 비밀번호를 입력해주세요." });
    }
    const now = Date.now();
    const registrationKey = `${req.ip}:${id.toLowerCase()}`;
    const previous = registrationAttempts.get(registrationKey);
    const attempt = previous && now - previous.startedAt < REGISTER_WINDOW_MS ? previous : { count: 0, startedAt: now };
    if (attempt.count >= REGISTER_MAX_ATTEMPTS) {
        return res.status(429).json({ success: false, message: "같은 아이디로 가입 요청을 너무 많이 보냈습니다. 10분 후 다시 시도해주세요." });
    }
    attempt.count += 1;
    registrationAttempts.set(registrationKey, attempt);
    const exists = await query(`
        SELECT 1 FROM users WHERE id = $1
        UNION ALL
        SELECT 1 FROM registration_requests WHERE id = $1 AND status = 'pending'
        LIMIT 1
    `, [id]);
    if (exists.rowCount) return res.status(409).json({ success: false, message: "이미 사용 중이거나 승인 대기 중인 아이디입니다." });
    const passwordHash = await bcrypt.hash(password, 12);
    await query(`
        INSERT INTO registration_requests (id, name, password, status)
        VALUES ($1, $2, $3, 'pending')
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, password = EXCLUDED.password,
            status = 'pending', created_at = NOW(), reviewed_at = NULL
    `, [id, name, passwordHash]);
    io.to(`private:${process.env.ADMIN_ID || "leowon0406"}`).emit("registration request");
    res.json({ success: true, message: "가입 승인 요청을 보냈습니다. 관리자가 승인하면 로그인할 수 있습니다." });
}));

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
    if (account.role === "admin") {
        delete req.session.user;
        req.session.pendingAdmin = { user, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 };
        await new Promise((resolve, reject) =>
            req.session.save(error => error ? reject(error) : resolve())
        );
        return res.json({ success: true, requiresSecondFactor: true });
    }
    delete req.session.pendingAdmin;
    req.session.user = user;
    await new Promise((resolve, reject) =>
        req.session.save(error => error ? reject(error) : resolve())
    );
    res.json({ success: true, user });
}));

app.post("/api/login/admin-verify", asyncHandler(async (req, res) => {
    const pending = req.session.pendingAdmin;
    if (!pending || !pending.user || pending.user.role !== "admin" || pending.expiresAt < Date.now()) {
        delete req.session.pendingAdmin;
        return res.status(401).json({ success: false, message: "인증 시간이 끝났습니다. 관리자 로그인을 다시 해주세요." });
    }
    if ((pending.attempts || 0) >= 5) {
        delete req.session.pendingAdmin;
        return res.status(429).json({ success: false, message: "2차 인증 시도가 너무 많습니다. 다시 로그인해주세요." });
    }
    const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
    const expected = process.env.ADMIN_2FA_CODE || "7812";
    if (!timingSafeTextEqual(code, expected)) {
        pending.attempts = (pending.attempts || 0) + 1;
        req.session.pendingAdmin = pending;
        return res.status(401).json({ success: false, message: "2차 인증번호가 올바르지 않습니다." });
    }
    req.session.user = pending.user;
    delete req.session.pendingAdmin;
    await new Promise((resolve, reject) =>
        req.session.save(error => error ? reject(error) : resolve())
    );
    res.json({ success: true, user: req.session.user });
}));

app.get("/api/me", (req, res) => {
    if (!req.session.user) {
        return res.json({ loggedIn: false });
    }
    res.json({ loggedIn: true, user: req.session.user });
});

app.get("/api/profile", requireLogin, asyncHandler(async (req, res) => {
    const result = await query(
        `SELECT id, name, role, profile_image AS "profileImage" FROM users WHERE id = $1`,
        [req.session.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: "계정을 찾을 수 없습니다." });
    res.json({ success: true, user: result.rows[0] });
}));

app.patch("/api/profile", requireLogin, asyncHandler(async (req, res) => {
    let profileImage = null;
    if (req.body.profileImage) {
        profileImage = safeAttachment(req.body.profileImage, req.session.user.id);
        if (!profileImage || profileImage.resourceType !== "image") {
            return res.status(400).json({ success: false, message: "올바른 프로필 사진이 아닙니다." });
        }
    }
    const previous = await query(
        `SELECT profile_image AS "profileImage" FROM users WHERE id = $1`,
        [req.session.user.id]
    );
    await query("UPDATE users SET profile_image = $1::jsonb WHERE id = $2", [profileImage ? JSON.stringify(profileImage) : null, req.session.user.id]);
    const oldImage = previous.rows[0] && previous.rows[0].profileImage;
    if (oldImage && (!profileImage || oldImage.publicId !== profileImage.publicId)) void destroyAttachment(oldImage);
    io.emit("profile updated", { userId: req.session.user.id });
    res.json({ success: true, profileImage });
}));

app.patch("/api/profile/password", requireLogin, asyncHandler(async (req, res) => {
    const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
    if (newPassword.length < 6 || newPassword.length > 100) {
        return res.status(400).json({ success: false, message: "새 비밀번호는 6~100자로 입력해주세요." });
    }
    const result = await query("SELECT password FROM users WHERE id = $1", [req.session.user.id]);
    const savedPassword = result.rows[0] && result.rows[0].password;
    const matches = savedPassword && savedPassword.startsWith("$2")
        ? await bcrypt.compare(currentPassword, savedPassword)
        : savedPassword === currentPassword;
    if (!matches) return res.status(401).json({ success: false, message: "현재 비밀번호가 올바르지 않습니다." });
    await query("UPDATE users SET password = $1 WHERE id = $2", [await bcrypt.hash(newPassword, 12), req.session.user.id]);
    res.json({ success: true, message: "비밀번호를 변경했습니다." });
}));

app.post("/api/cloudinary-signature", requireLogin, (req, res) => {
    if (!cloudinaryReady()) {
        return res.status(503).json({ success: false, message: "파일 저장소 설정이 완료되지 않았습니다." });
    }
    const resourceType = safeText(req.body.resourceType, 10);
    if (!CLOUDINARY_TYPES.has(resourceType)) {
        return res.status(400).json({ success: false, message: "지원하지 않는 파일 형식입니다." });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = uploadFolder(req.session.user.id);
    const params = { folder, timestamp };
    res.json({
        success: true,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        resourceType,
        timestamp,
        folder,
        signature: cloudinarySignature(params)
    });
});

app.get("/api/push/public-key", requireLogin, (req, res) => {
    if (!vapidPublicKey) {
        return res.status(503).json({ success: false, message: "푸시 알림을 준비하는 중입니다." });
    }
    res.json({ success: true, publicKey: vapidPublicKey });
});

app.post("/api/push/subscribe", requireLogin, asyncHandler(async (req, res) => {
    const subscription = safePushSubscription(req.body.subscription);
    if (!subscription) {
        return res.status(400).json({ success: false, message: "올바르지 않은 푸시 구독 정보입니다." });
    }
    await query(`
        INSERT INTO push_subscriptions (endpoint, user_id, subscription)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (endpoint) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            subscription = EXCLUDED.subscription,
            updated_at = NOW()
    `, [subscription.endpoint, req.session.user.id, JSON.stringify(subscription)]);
    res.json({ success: true });
}));

app.delete("/api/push/subscribe", requireLogin, asyncHandler(async (req, res) => {
    const endpoint = safeText(req.body.endpoint, 2000);
    if (endpoint) {
        await query(
            "DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2",
            [endpoint, req.session.user.id]
        );
    }
    res.json({ success: true });
}));

app.get("/api/users", requireLogin, asyncHandler(async (req, res) => {
    let users;
    if (req.query.sort === "recent") {
        const result = await query(`
            SELECT u.id, u.name, COALESCE(a.alias, u.name) AS "displayName", u.role,
                   u.profile_image AS "profileImage", u.created_at AS "createdAt",
                   recent.last_message_id::int AS "lastMessageId",
                   recent.last_message_at AS "lastMessageAt"
            FROM users u
            LEFT JOIN user_aliases a ON a.owner_id = $1 AND a.target_id = u.id
            LEFT JOIN (
                SELECT CASE WHEN from_id = $1 THEN to_id ELSE from_id END AS friend_id,
                       MAX(id) AS last_message_id,
                       MAX(created_at) AS last_message_at
                FROM private_messages
                WHERE from_id = $1 OR to_id = $1
                GROUP BY CASE WHEN from_id = $1 THEN to_id ELSE from_id END
            ) recent ON recent.friend_id = u.id
            WHERE u.id <> $1
            ORDER BY recent.last_message_id DESC NULLS LAST, u.name ASC
        `, [req.session.user.id]);
        users = result.rows;
    } else {
        const result = await query(`
            SELECT u.id, u.name, COALESCE(a.alias, u.name) AS "displayName", u.role,
                   u.profile_image AS "profileImage", u.created_at AS "createdAt"
            FROM users u
            LEFT JOIN user_aliases a ON a.owner_id = $1 AND a.target_id = u.id
            WHERE u.id <> $1 ORDER BY COALESCE(a.alias, u.name)
        `, [req.session.user.id]);
        users = result.rows;
    }
    res.json({ success: true, users });
}));

app.put("/api/users/:id/alias", requireLogin, asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    const alias = safeText(req.body.alias, 40);
    if (targetId === req.session.user.id) return res.status(400).json({ success: false, message: "자기 이름은 프로필에서 관리해주세요." });
    const target = await query("SELECT 1 FROM users WHERE id = $1", [targetId]);
    if (!target.rowCount) return res.status(404).json({ success: false, message: "사용자를 찾을 수 없습니다." });
    if (alias) {
        await query(`
            INSERT INTO user_aliases (owner_id, target_id, alias) VALUES ($1, $2, $3)
            ON CONFLICT (owner_id, target_id) DO UPDATE SET alias = EXCLUDED.alias
        `, [req.session.user.id, targetId, alias]);
    } else {
        await query("DELETE FROM user_aliases WHERE owner_id = $1 AND target_id = $2", [req.session.user.id, targetId]);
    }
    res.json({ success: true });
}));

app.get("/api/navigation", requireLogin, asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const [peopleResult, roomResult, preferenceResult] = await Promise.all([
        query(`
            WITH recent AS (
                SELECT CASE WHEN from_id = $1 THEN to_id ELSE from_id END AS friend_id,
                       MAX(id) AS last_message_id, MAX(created_at) AS last_message_at
                FROM private_messages
                WHERE from_id = $1 OR to_id = $1
                GROUP BY CASE WHEN from_id = $1 THEN to_id ELSE from_id END
            ), unread AS (
                SELECT from_id, COUNT(*)::int AS count
                FROM private_messages m
                WHERE to_id = $1 AND NOT EXISTS (
                    SELECT 1 FROM private_reads r WHERE r.message_id = m.id AND r.user_id = $1
                ) GROUP BY from_id
            )
            SELECT u.id, u.name, COALESCE(a.alias, u.name) AS "displayName",
                   u.profile_image AS "profileImage", u.created_at AS "createdAt",
                   recent.last_message_id::int AS "lastMessageId", recent.last_message_at AS "lastMessageAt",
                   COALESCE(unread.count, 0)::int AS "unreadCount"
            FROM users u
            LEFT JOIN user_aliases a ON a.owner_id = $1 AND a.target_id = u.id
            LEFT JOIN recent ON recent.friend_id = u.id
            LEFT JOIN unread ON unread.from_id = u.id
            WHERE u.id <> $1
            ORDER BY recent.last_message_id DESC NULLS LAST, COALESCE(a.alias, u.name)
        `, [userId]),
        query(`
            SELECT r.id::int, r.name, r.creator_id AS "creatorId",
                   (SELECT COUNT(*)::int FROM group_room_members members WHERE members.room_id = r.id) AS "memberCount",
                   latest.id::int AS "lastMessageId", latest.created_at AS "lastMessageAt",
                   (SELECT COUNT(*)::int FROM group_room_messages messages
                    WHERE messages.room_id = r.id AND messages.user_id <> $1
                      AND messages.created_at >= mine.joined_at
                      AND NOT EXISTS (SELECT 1 FROM group_room_reads reads WHERE reads.message_id = messages.id AND reads.user_id = $1)) AS "unreadCount"
            FROM group_rooms r
            JOIN group_room_members mine ON mine.room_id = r.id AND mine.user_id = $1
            LEFT JOIN LATERAL (
                SELECT id, created_at FROM group_room_messages
                WHERE room_id = r.id ORDER BY id DESC LIMIT 1
            ) latest ON true
            ORDER BY latest.id DESC NULLS LAST, r.created_at DESC
        `, [userId]),
        query(`
            SELECT COALESCE(p.friends_seen_at, u.created_at) AS "friendsSeenAt"
            FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = $1
        `, [userId])
    ]);
    const seenAt = preferenceResult.rows[0] && preferenceResult.rows[0].friendsSeenAt;
    const people = peopleResult.rows;
    res.json({
        success: true,
        chats: people.filter(person => person.lastMessageId).map(person => ({
            ...person,
            isNew: new Date(person.createdAt) > new Date(seenAt)
        })),
        friends: people.map(person => ({
            ...person,
            isNew: new Date(person.createdAt) > new Date(seenAt)
        })),
        rooms: roomResult.rows,
        newFriendCount: people.filter(person => new Date(person.createdAt) > new Date(seenAt)).length
    });
}));

app.post("/api/friends/seen", requireLogin, asyncHandler(async (req, res) => {
    await query(`
        INSERT INTO user_preferences (user_id, friends_seen_at) VALUES ($1, NOW())
        ON CONFLICT (user_id) DO UPDATE SET friends_seen_at = NOW()
    `, [req.session.user.id]);
    res.json({ success: true });
}));

app.get("/api/admin/users", adminOnly, asyncHandler(async (req, res) => {
    const adminId = process.env.ADMIN_ID || "leowon0406";
    const result = await query(
        `SELECT id, name, profile_image AS "profileImage", last_active_at AS "lastActiveAt"
         FROM users WHERE id <> $1 ORDER BY name`,
        [adminId]
    );
    res.json({ success: true, users: result.rows.map(user => ({
        ...user,
        online: (onlineUsers.get(user.id) || 0) > 0 || Date.now() - new Date(user.lastActiveAt).getTime() < 120_000
    })) });
}));

app.get("/api/admin/registration-requests", adminOnly, asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, name, created_at AS "createdAt"
        FROM registration_requests WHERE status = 'pending' ORDER BY created_at
    `);
    res.json({ success: true, requests: result.rows });
}));

app.post("/api/admin/registration-requests/:id/approve", adminOnly, asyncHandler(async (req, res) => {
    const id = req.params.id;
    await transaction(async client => {
        const request = await client.query(
            "SELECT id, name, password FROM registration_requests WHERE id = $1 AND status = 'pending' FOR UPDATE",
            [id]
        );
        if (!request.rowCount) {
            const error = new Error("승인 대기 중인 신청을 찾을 수 없습니다.");
            error.status = 404;
            throw error;
        }
        const account = request.rows[0];
        const exists = await client.query("SELECT 1 FROM users WHERE id = $1", [account.id]);
        if (exists.rowCount) {
            const error = new Error("이미 같은 아이디의 계정이 존재합니다.");
            error.status = 409;
            throw error;
        }
        await client.query(
            "INSERT INTO users (id, name, password, role) VALUES ($1, $2, $3, 'user')",
            [account.id, account.name, account.password]
        );
        await client.query(
            "UPDATE registration_requests SET status = 'approved', reviewed_at = NOW() WHERE id = $1",
            [id]
        );
    });
    io.emit("friends updated");
    res.json({ success: true });
}));

app.post("/api/admin/registration-requests/:id/reject", adminOnly, asyncHandler(async (req, res) => {
    const result = await query(
        "UPDATE registration_requests SET status = 'rejected', reviewed_at = NOW() WHERE id = $1 AND status = 'pending'",
        [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: "승인 대기 중인 신청을 찾을 수 없습니다." });
    res.json({ success: true });
}));

app.post("/api/admin/users", adminOnly, asyncHandler(async (req, res) => {
    const id = safeText(req.body.id, 80);
    const name = safeText(req.body.name, 80);
    const password = typeof req.body.password === "string"
        ? req.body.password
        : "";

    if (!validUserId(id) || !name || password.length < 6 || password.length > 100) {
        return res.status(400).json({
            success: false,
            message: "아이디 형식과 이름, 6자 이상의 비밀번호를 확인해주세요."
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

app.patch("/api/admin/users/:id/id", adminOnly, asyncHandler(async (req, res) => {
    const oldId = req.params.id;
    const newId = safeText(req.body.newId, 30);
    const initialAdminId = process.env.ADMIN_ID || "leowon0406";
    if (oldId === initialAdminId || oldId === req.session.user.id) {
        return res.status(400).json({ success: false, message: "현재 관리자 아이디는 환경 변수와 연결되어 있어 여기서 바꿀 수 없습니다." });
    }
    if (!validUserId(newId)) return res.status(400).json({ success: false, message: "새 아이디 형식이 올바르지 않습니다." });
    if (oldId === newId) return res.json({ success: true });
    await transaction(async client => {
        const exists = await client.query(`
            SELECT 1 FROM users WHERE id = $1
            UNION ALL SELECT 1 FROM registration_requests WHERE id = $1 AND status = 'pending'
            LIMIT 1
        `, [newId]);
        if (exists.rowCount) {
            const error = new Error("이미 사용 중인 아이디입니다.");
            error.status = 409;
            throw error;
        }
        const copied = await client.query(`
            INSERT INTO users (id, name, password, role, created_at, profile_image, last_active_at)
            SELECT $2, name, password, role, created_at, profile_image, last_active_at
            FROM users WHERE id = $1 RETURNING id
        `, [oldId, newId]);
        if (!copied.rowCount) {
            const error = new Error("사용자를 찾을 수 없습니다.");
            error.status = 404;
            throw error;
        }
        const updates = [
            ["group_messages", "user_id"], ["group_reads", "user_id"],
            ["private_messages", "from_id"], ["private_messages", "to_id"], ["private_reads", "user_id"],
            ["group_rooms", "creator_id"], ["group_room_members", "user_id"],
            ["group_room_messages", "user_id"], ["group_room_reads", "user_id"],
            ["push_subscriptions", "user_id"], ["user_aliases", "owner_id"],
            ["user_aliases", "target_id"], ["user_preferences", "user_id"],
            ["game_runs", "user_id"], ["game_scores", "user_id"]
        ];
        for (const [table, column] of updates) {
            await client.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [oldId, newId]);
        }
        await client.query("DELETE FROM users WHERE id = $1", [oldId]);
    });
    await query(`
        UPDATE user_sessions
        SET sess = jsonb_set(sess::jsonb, '{user,id}', to_jsonb($2::text))::json
        WHERE sess->'user'->>'id' = $1
    `, [oldId, newId]).catch(() => {});
    io.to(`private:${oldId}`).emit("account id changed", { newId });
    io.emit("friends updated");
    res.json({ success: true });
}));

app.patch("/api/admin/users/:id/name", adminOnly, asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const name = safeText(req.body.name, 40);
    const adminId = process.env.ADMIN_ID || "leowon0406";
    if (userId === adminId || userId === req.session.user.id) {
        return res.status(400).json({ success: false, message: "현재 관리자 이름은 이 화면에서 변경할 수 없습니다." });
    }
    if (!name) return res.status(400).json({ success: false, message: "이름을 입력해주세요." });
    await transaction(async client => {
        const updated = await client.query("UPDATE users SET name = $1 WHERE id = $2 RETURNING id", [name, userId]);
        if (!updated.rowCount) {
            const error = new Error("사용자를 찾을 수 없습니다.");
            error.status = 404;
            throw error;
        }
        await client.query("UPDATE group_messages SET user_name = $1 WHERE user_id = $2", [name, userId]);
        await client.query("UPDATE private_messages SET from_name = $1 WHERE from_id = $2", [name, userId]);
        await client.query("UPDATE group_rooms SET creator_name = $1 WHERE creator_id = $2", [name, userId]);
        await client.query("UPDATE group_room_members SET user_name = $1 WHERE user_id = $2", [name, userId]);
        await client.query("UPDATE group_room_messages SET user_name = $1 WHERE user_id = $2", [name, userId]);
    });
    await query(`
        UPDATE user_sessions
        SET sess = jsonb_set(sess::jsonb, '{user,name}', to_jsonb($2::text))::json
        WHERE sess->'user'->>'id' = $1
    `, [userId, name]).catch(() => {});
    const connectedSockets = await io.in(`private:${userId}`).fetchSockets();
    connectedSockets.forEach(connected => {
        connected.user.name = name;
        if (connected.request.session && connected.request.session.user) connected.request.session.user.name = name;
    });
    io.to(`private:${userId}`).emit("profile updated", { userId, name });
    io.emit("friends updated");
    res.json({ success: true });
}));

app.patch("/api/admin/users/:id/password", adminOnly, asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
    const adminId = process.env.ADMIN_ID || "leowon0406";
    if (userId === adminId || userId === req.session.user.id) {
        return res.status(400).json({ success: false, message: "관리자 비밀번호는 Render 환경 변수에서 관리해주세요." });
    }
    if (newPassword.length < 6 || newPassword.length > 100) {
        return res.status(400).json({ success: false, message: "임시 비밀번호는 6~100자로 입력해주세요." });
    }
    const result = await query("UPDATE users SET password = $1 WHERE id = $2 RETURNING id", [await bcrypt.hash(newPassword, 12), userId]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "사용자를 찾을 수 없습니다." });
    await query("DELETE FROM user_sessions WHERE sess->'user'->>'id' = $1", [userId]).catch(() => {});
    io.in(`private:${userId}`).disconnectSockets(true);
    res.json({ success: true, message: "임시 비밀번호로 재설정했습니다." });
}));

app.delete("/api/admin/users/:id/profile-image", adminOnly, asyncHandler(async (req, res) => {
    const previous = await query(`SELECT profile_image AS "profileImage" FROM users WHERE id = $1`, [req.params.id]);
    const result = await query("UPDATE users SET profile_image = NULL WHERE id = $1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "사용자를 찾을 수 없습니다." });
    void destroyAttachment(previous.rows[0] && previous.rows[0].profileImage);
    io.emit("profile updated", { userId: req.params.id });
    res.json({ success: true });
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

app.post("/api/games/start", requireLogin, asyncHandler(async (req, res) => {
    const game = safeText(req.body.game, 20);
    if (!GAME_RULES[game]) return res.status(400).json({ success: false, message: "지원하지 않는 게임입니다." });
    const token = crypto.randomUUID();
    await transaction(async client => {
        await client.query("DELETE FROM game_runs WHERE started_at < NOW() - INTERVAL '1 day'");
        await client.query("DELETE FROM game_runs WHERE user_id = $1 AND completed_at IS NULL", [req.session.user.id]);
        await client.query("INSERT INTO game_runs (token, user_id, game) VALUES ($1, $2, $3)", [token, req.session.user.id, game]);
    });
    res.json({ success: true, token });
}));

app.post("/api/games/score", requireLogin, asyncHandler(async (req, res) => {
    const token = safeText(req.body.token, 80);
    const score = Number(req.body.score);
    if (!token || !Number.isInteger(score) || score < 0) {
        return res.status(400).json({ success: false, message: "올바른 게임 결과가 아닙니다." });
    }
    const saved = await transaction(async client => {
        const runResult = await client.query(`
            SELECT game, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 AS "elapsedMs"
            FROM game_runs
            WHERE token = $1 AND user_id = $2 AND completed_at IS NULL
            FOR UPDATE
        `, [token, req.session.user.id]);
        if (!runResult.rowCount) return null;
        const run = runResult.rows[0];
        const rule = GAME_RULES[run.game];
        const elapsedMs = Number(run.elapsedMs);
        if (!rule || elapsedMs < rule.minMs || elapsedMs > rule.maxMs || score > rule.maxScore) return false;
        await client.query("UPDATE game_runs SET completed_at = NOW() WHERE token = $1", [token]);
        await client.query("INSERT INTO game_scores (user_id, game, score) VALUES ($1, $2, $3)", [req.session.user.id, run.game, score]);
        return run.game;
    });
    if (saved === null) return res.status(409).json({ success: false, message: "이미 제출했거나 만료된 게임입니다." });
    if (saved === false) return res.status(400).json({ success: false, message: "게임 시간이나 점수가 올바르지 않아 저장하지 않았습니다." });
    res.json({ success: true });
}));

app.get("/api/games/rankings", requireLogin, asyncHandler(async (req, res) => {
    const game = safeText(req.query.game, 20) || "all";
    if (game !== "all" && !GAME_RULES[game]) return res.status(400).json({ success: false, message: "지원하지 않는 게임입니다." });
    const ranking = game === "all"
        ? await query(`
            WITH best AS (
                SELECT user_id, game, MAX(score)::int AS score
                FROM game_scores GROUP BY user_id, game
            )
            SELECT u.id AS "userId", u.name, SUM(best.score)::int AS score
            FROM best JOIN users u ON u.id = best.user_id
            GROUP BY u.id, u.name ORDER BY score DESC, u.name LIMIT 30
        `)
        : await query(`
            SELECT u.id AS "userId", u.name, MAX(scores.score)::int AS score
            FROM game_scores scores JOIN users u ON u.id = scores.user_id
            WHERE scores.game = $1
            GROUP BY u.id, u.name ORDER BY score DESC, u.name LIMIT 30
        `, [game]);
    const mine = await query(`
        SELECT game, MAX(score)::int AS score
        FROM game_scores WHERE user_id = $1 GROUP BY game
    `, [req.session.user.id]);
    res.json({ success: true, rankings: ranking.rows, bestScores: Object.fromEntries(mine.rows.map(row => [row.game, row.score])) });
}));

app.delete("/api/admin/game-scores", adminOnly, asyncHandler(async (req, res) => {
    await transaction(async client => {
        await client.query("DELETE FROM game_scores");
        await client.query("DELETE FROM game_runs");
    });
    res.json({ success: true });
}));

app.get("/api/group-messages", requireLogin, asyncHandler(async (req, res) => {
    const before = beforeId(req.query.before);
    const result = await query(`
        SELECT m.id::int, m.user_id AS "userId", m.user_name AS name,
               m.text, m.time, CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment,
               (m.edited_at IS NOT NULL) AS edited,
               (m.deleted_at IS NOT NULL) AS deleted,
               m.reply_to_id::int AS "replyToId",
               reply.user_name AS "replyToName",
               COALESCE(NULLIF(reply.text, ''), CASE WHEN reply.attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
        FROM group_messages m
        LEFT JOIN group_messages reply ON reply.id = m.reply_to_id
        WHERE ($1::bigint IS NULL OR m.id < $1)
        ORDER BY m.id DESC
        LIMIT 51
    `, [before]);
    res.json({ success: true, ...messagePage(result.rows) });
}));

app.get("/api/group-messages/search", requireLogin, asyncHandler(async (req, res) => {
    const term = safeText(req.query.q, 100);
    if (term.length < 1) return res.json({ success: true, messages: [] });
    const result = await query(`
        SELECT m.id::int, COALESCE(a.alias, m.user_name) AS "senderName", m.text, m.time,
               CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment
        FROM group_messages m
        LEFT JOIN user_aliases a ON a.owner_id = $2 AND a.target_id = m.user_id
        WHERE m.deleted_at IS NULL
          AND (m.text ILIKE $1 OR m.user_name ILIKE $1 OR COALESCE(a.alias, '') ILIKE $1
               OR COALESCE(m.attachment->>'fileName', '') ILIKE $1)
        ORDER BY m.id DESC
        LIMIT 50
    `, [`%${term}%`, req.session.user.id]);
    res.json({ success: true, messages: result.rows });
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
        const userResult = await query(`
            SELECT u.id, u.name, COALESCE(a.alias, u.name) AS "displayName", u.role,
                   u.profile_image AS "profileImage"
            FROM users u LEFT JOIN user_aliases a ON a.owner_id = $2 AND a.target_id = u.id
            WHERE u.id = $1
        `, [other, me]);
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
                   CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment,
                   (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   m.reply_to_id::int AS "replyToId",
                   reply.from_name AS "replyToName",
                   COALESCE(NULLIF(reply.text, ''), CASE WHEN reply.attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
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

app.get("/api/private-messages/:userId/search", requireLogin,
    asyncHandler(async (req, res) => {
        const me = req.session.user.id;
        const other = req.params.userId;
        const term = safeText(req.query.q, 100);
        if (term.length < 1) return res.json({ success: true, messages: [] });
        const result = await query(`
            SELECT m.id::int, COALESCE(a.alias, m.from_name) AS "senderName", m.text, m.time,
                   CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment
            FROM private_messages m
            LEFT JOIN user_aliases a ON a.owner_id = $1 AND a.target_id = m.from_id
            WHERE ((m.from_id = $1 AND m.to_id = $2)
               OR (m.from_id = $2 AND m.to_id = $1))
              AND m.deleted_at IS NULL
              AND (m.text ILIKE $3 OR m.from_name ILIKE $3
                   OR COALESCE(m.attachment->>'fileName', '') ILIKE $3)
            ORDER BY m.id DESC
            LIMIT 50
        `, [me, other, `%${term}%`]);
        res.json({ success: true, messages: result.rows });
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
                SELECT id::int, from_name AS "replyToName",
                       COALESCE(NULLIF(text, ''), CASE WHEN attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
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
                   COALESCE(a.alias, r.creator_name) AS "creatorName", r.created_at AS "createdAt"
            FROM group_rooms r
            JOIN group_room_members m
              ON m.room_id = r.id AND m.user_id = $2
            LEFT JOIN user_aliases a ON a.owner_id = $2 AND a.target_id = r.creator_id
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
            SELECT members.user_id AS id, members.user_name AS name,
                   COALESCE(a.alias, members.user_name) AS "displayName"
            FROM group_room_members members
            LEFT JOIN user_aliases a ON a.owner_id = $2 AND a.target_id = members.user_id
            WHERE members.room_id = $1
            ORDER BY COALESCE(a.alias, members.user_name)
        `, [roomId, req.session.user.id]);
        res.json({ success: true, room, members: members.rows });
    })
);

app.patch("/api/chat-rooms/:roomId", requireLogin, asyncHandler(async (req, res) => {
    const roomId = Number(req.params.roomId);
    const name = safeText(req.body.name, 50);
    if (!Number.isInteger(roomId) || !name) {
        return res.status(400).json({ success: false, message: "채팅방 이름을 입력해주세요." });
    }
    const result = await query(`
        UPDATE group_rooms SET name = $1
        WHERE id = $2 AND (creator_id = $3 OR $4 = 'admin')
        RETURNING id::int, name
    `, [name, roomId, req.session.user.id, req.session.user.role]);
    if (!result.rowCount) return res.status(403).json({ success: false, message: "방장 또는 관리자만 이름을 변경할 수 있습니다." });
    io.to(`chatroom:${roomId}`).emit("chat room updated", { roomId });
    res.json({ success: true, room: result.rows[0] });
}));

app.post("/api/chat-rooms/:roomId/members", requireLogin, asyncHandler(async (req, res) => {
    const roomId = Number(req.params.roomId);
    const memberId = safeText(req.body.userId, 80);
    const owner = await query("SELECT 1 FROM group_rooms WHERE id = $1 AND (creator_id = $2 OR $3 = 'admin')", [roomId, req.session.user.id, req.session.user.role]);
    if (!owner.rowCount) return res.status(403).json({ success: false, message: "방장 또는 관리자만 친구를 초대할 수 있습니다." });
    const user = await query("SELECT id, name FROM users WHERE id = $1", [memberId]);
    if (!user.rowCount) return res.status(404).json({ success: false, message: "사용자를 찾을 수 없습니다." });
    const added = await query(`
        INSERT INTO group_room_members (room_id, user_id, user_name)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
        RETURNING user_id
    `, [roomId, user.rows[0].id, user.rows[0].name]);
    if (!added.rowCount) return res.status(409).json({ success: false, message: "이미 참여 중인 친구입니다." });
    io.to(`chatroom:${roomId}`).emit("chat room updated", { roomId });
    io.to(`private:${memberId}`).emit("chat room invitation", { roomId });
    res.json({ success: true });
}));

app.delete("/api/chat-rooms/:roomId/members/:userId", requireLogin, asyncHandler(async (req, res) => {
    const roomId = Number(req.params.roomId);
    const memberId = req.params.userId;
    const owner = await query("SELECT creator_id FROM group_rooms WHERE id = $1 AND (creator_id = $2 OR $3 = 'admin')", [roomId, req.session.user.id, req.session.user.role]);
    if (!owner.rowCount) return res.status(403).json({ success: false, message: "방장 또는 관리자만 멤버를 내보낼 수 있습니다." });
    if (memberId === owner.rows[0].creator_id) return res.status(400).json({ success: false, message: "방장은 권한을 넘긴 후 내보낼 수 있습니다." });
    if (memberId === req.session.user.id) return res.status(400).json({ success: false, message: "자신은 나가기 버튼을 이용해주세요." });
    const removed = await query(
        "DELETE FROM group_room_members WHERE room_id = $1 AND user_id = $2 RETURNING user_id",
        [roomId, memberId]
    );
    if (!removed.rowCount) return res.status(404).json({ success: false, message: "멤버를 찾을 수 없습니다." });
    io.in(`private:${memberId}`).socketsLeave(`chatroom:${roomId}`);
    io.to(`private:${memberId}`).emit("chat room removed", { roomId });
    io.to(`chatroom:${roomId}`).emit("chat room updated", { roomId });
    res.json({ success: true });
}));

app.patch("/api/chat-rooms/:roomId/owner", requireLogin, asyncHandler(async (req, res) => {
    const roomId = Number(req.params.roomId);
    const newOwnerId = safeText(req.body.userId, 80);
    const result = await query(`
        UPDATE group_rooms rooms
        SET creator_id = members.user_id, creator_name = members.user_name
        FROM group_room_members members
        WHERE rooms.id = $1 AND (rooms.creator_id = $2 OR $4 = 'admin')
          AND members.room_id = rooms.id AND members.user_id = $3
        RETURNING rooms.id::int, rooms.creator_id AS "creatorId", rooms.creator_name AS "creatorName"
    `, [roomId, req.session.user.id, newOwnerId, req.session.user.role]);
    if (!result.rowCount) return res.status(400).json({ success: false, message: "방장 권한을 넘길 멤버를 찾을 수 없습니다." });
    io.to(`chatroom:${roomId}`).emit("chat room updated", { roomId });
    res.json({ success: true, room: result.rows[0] });
}));

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
                   m.text, m.time, CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment,
                   (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   m.reply_to_id::int AS "replyToId", reply.user_name AS "replyToName",
                   COALESCE(NULLIF(reply.text, ''), CASE WHEN reply.attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
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

app.get("/api/chat-rooms/:roomId/messages/search", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const term = safeText(req.query.q, 100);
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, req.session.user.id]
        );
        if (!member.rowCount) return res.status(403).json({ success: false, message: "채팅방 멤버가 아닙니다." });
        if (term.length < 1) return res.json({ success: true, messages: [] });
        const result = await query(`
            SELECT m.id::int, COALESCE(a.alias, m.user_name) AS "senderName", m.text, m.time,
                   CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment
            FROM group_room_messages m
            LEFT JOIN user_aliases a ON a.owner_id = $3 AND a.target_id = m.user_id
            WHERE m.room_id = $1 AND m.deleted_at IS NULL
              AND (m.text ILIKE $2 OR m.user_name ILIKE $2 OR COALESCE(a.alias, '') ILIKE $2
                   OR COALESCE(m.attachment->>'fileName', '') ILIKE $2)
            ORDER BY m.id DESC
            LIMIT 50
        `, [roomId, `%${term}%`, req.session.user.id]);
        res.json({ success: true, messages: result.rows });
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
                       (SELECT COUNT(*) FROM group_room_members
                        WHERE room_id = $1 AND joined_at <= m.created_at)
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
              AND members.joined_at <= m.created_at
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
               AND m.created_at >= member.joined_at
               AND NOT EXISTS (
                   SELECT 1 FROM group_room_reads r
                   WHERE r.message_id = m.id AND r.user_id = $1
               )) AS "roomCount",
            (SELECT COUNT(*)::int FROM users friend
             JOIN users me ON me.id = $1
             LEFT JOIN user_preferences pref ON pref.user_id = me.id
             WHERE friend.id <> $1
               AND friend.created_at > COALESCE(pref.friends_seen_at, me.created_at)) AS "newFriendCount"
    `, [userId]);
    const counts = result.rows[0];
    const pendingRegistrationCount = req.session.user.role === "admin"
        ? Number((await query("SELECT COUNT(*)::int AS count FROM registration_requests WHERE status = 'pending'")).rows[0].count)
        : 0;
    res.json({
        success: true,
        ...counts,
        hasUnread: counts.globalCount + counts.privateCount + counts.roomCount > 0,
        hasAttention: counts.globalCount + counts.privateCount + counts.roomCount + counts.newFriendCount + pendingRegistrationCount > 0,
        pendingRegistrationCount
    });
}));

app.delete("/api/chat-rooms/:roomId/leave", requireLogin,
    asyncHandler(async (req, res) => {
        const roomId = Number(req.params.roomId);
        const room = await query(`
            SELECT creator_id AS "creatorId",
                   (SELECT COUNT(*)::int FROM group_room_members WHERE room_id = $1) AS "memberCount"
            FROM group_rooms WHERE id = $1
        `, [roomId]);
        if (!room.rowCount) return res.status(404).json({ success: false, message: "채팅방을 찾을 수 없습니다." });
        if (room.rows[0].creatorId === req.session.user.id && room.rows[0].memberCount > 1) {
            return res.status(400).json({ success: false, message: "다른 멤버에게 방장 권한을 넘긴 후 나가주세요." });
        }
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
        io.in(`private:${req.session.user.id}`).socketsLeave(`chatroom:${roomId}`);
        io.to(`chatroom:${roomId}`).emit("chat room updated", { roomId });
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
    onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);
    void query("UPDATE users SET last_active_at = NOW() WHERE id = $1", [userId]);
    socket.join(`private:${userId}`);

    const guard = handler => async (...args) => {
        try {
            await handler(...args);
        } catch (error) {
            console.error("Socket 오류:", error);
            socket.emit("server error", "요청을 처리하지 못했습니다.");
        }
    };

    socket.on("group typing", value => {
        socket.to("group").emit("group typing", { userId, name: socket.user.name, typing: Boolean(value) });
    });

    socket.on("private typing", data => {
        const toId = data && typeof data.toId === "string" ? data.toId : "";
        if (!toId || toId === userId) return;
        socket.to(`private:${toId}`).emit("private typing", { userId, name: socket.user.name, typing: Boolean(data.typing) });
    });

    socket.on("chat room typing", guard(async data => {
        const roomId = Number(data && data.roomId);
        if (!Number.isInteger(roomId)) return;
        const member = await query("SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2", [roomId, userId]);
        if (member.rowCount) socket.to(`chatroom:${roomId}`).emit("chat room typing", { roomId, userId, name: socket.user.name, typing: Boolean(data.typing) });
    }));

    socket.on("join group", guard(async () => {
        socket.join("group");
        const result = await query(`
            SELECT m.id::int, m.user_id AS "userId", m.user_name AS name,
                   m.text, m.time, CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment,
                   (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   m.reply_to_id::int AS "replyToId",
                   reply.user_name AS "replyToName",
                   COALESCE(NULLIF(reply.text, ''), CASE WHEN reply.attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
            FROM group_messages m
            LEFT JOIN group_messages reply ON reply.id = m.reply_to_id
            ORDER BY m.id DESC
            LIMIT 51
        `);
        const unread = await query(`
            SELECT MIN(m.id)::int AS "firstUnreadId"
            FROM group_messages m
            JOIN users u ON u.id = $1
            WHERE m.user_id <> $1 AND m.created_at >= u.created_at
              AND NOT EXISTS (
                  SELECT 1 FROM group_reads r
                  WHERE r.message_id = m.id AND r.user_id = $1
              )
        `, [userId]);
        socket.emit("group history", {
            ...messagePage(result.rows),
            firstUnreadId: unread.rows[0].firstUnreadId
        });
    }));

    socket.on("group message", guard(async value => {
        const data = typeof value === "string" ? { text: value } : value;
        const text = safeText(data && data.text);
        const attachment = safeAttachment(data && data.attachment, userId);
        const clientId = safeText(data && data.clientId, 80) || null;
        if (!text && !attachment) return;
        const requestedReplyId = Number(data && data.replyToId);
        let reply = null;
        if (Number.isInteger(requestedReplyId)) {
            const replyResult = await query(`
                SELECT id::int, user_name AS "replyToName",
                       COALESCE(NULLIF(text, ''), CASE WHEN attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
                FROM group_messages WHERE id = $1
            `, [requestedReplyId]);
            reply = replyResult.rows[0] || null;
        }
        const time = chatTime();
        const result = await query(`
            INSERT INTO group_messages
                (user_id, user_name, text, time, reply_to_id, client_id, attachment)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL
            DO UPDATE SET client_id = EXCLUDED.client_id
            RETURNING id::int, time, (xmax = 0) AS inserted
        `, [userId, socket.user.name, text, time, reply && reply.id, clientId, attachment]);
        io.to("group").emit("group message", {
            id: result.rows[0].id,
            userId,
            name: socket.user.name,
            text,
            attachment,
            time: result.rows[0].time,
            replyToId: reply && reply.id,
            replyToName: reply && reply.replyToName,
            replyToText: reply && reply.replyToText,
            clientId
        });
        io.emit("unread changed");
        if (result.rows[0].inserted) void pushToAllExcept(userId, {
            title: "OURCOM 전체 채팅",
            body: pushMessageBody(socket.user.name, text, attachment),
            url: "/chat.html",
            tag: "ourcom-global"
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
        const otherResult = await query(`
            SELECT u.id, u.name, COALESCE(a.alias, u.name) AS "displayName",
                   u.profile_image AS "profileImage"
            FROM users u LEFT JOIN user_aliases a ON a.owner_id = $2 AND a.target_id = u.id
            WHERE u.id = $1
        `, [otherId, userId]);
        if (!otherResult.rowCount) return;
        const result = await query(`
            SELECT m.id::int, m.from_id AS "fromId", m.from_name AS "fromName",
                   m.to_id AS "toId", m.text, m.time,
                   CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment,
                   (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   m.reply_to_id::int AS "replyToId",
                   reply.from_name AS "replyToName",
                   COALESCE(NULLIF(reply.text, ''), CASE WHEN reply.attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
            FROM private_messages m
            LEFT JOIN private_messages reply ON reply.id = m.reply_to_id
            WHERE (m.from_id = $1 AND m.to_id = $2)
               OR (m.from_id = $2 AND m.to_id = $1)
            ORDER BY m.id DESC
            LIMIT 51
        `, [userId, otherId]);
        const page = messagePage(result.rows);
        const unread = await query(`
            SELECT MIN(m.id)::int AS "firstUnreadId"
            FROM private_messages m
            WHERE m.from_id = $2 AND m.to_id = $1
              AND NOT EXISTS (
                  SELECT 1 FROM private_reads r
                  WHERE r.message_id = m.id AND r.user_id = $1
              )
        `, [userId, otherId]);
        socket.emit("private history", {
            user: otherResult.rows[0],
            firstUnreadId: unread.rows[0].firstUnreadId,
            ...page
        });
    }));

    socket.on("private message", guard(async data => {
        if (!data || typeof data.toId !== "string") return;
        const toId = data.toId;
        const text = safeText(data.text);
        const attachment = safeAttachment(data.attachment, userId);
        const clientId = safeText(data.clientId, 80) || null;
        if ((!text && !attachment) || toId === userId) return;
        const target = await query("SELECT 1 FROM users WHERE id = $1", [toId]);
        if (!target.rowCount) return;
        const requestedReplyId = Number(data.replyToId);
        let reply = null;
        if (Number.isInteger(requestedReplyId)) {
            const replyResult = await query(`
                SELECT id::int, from_name AS "replyToName",
                       COALESCE(NULLIF(text, ''), CASE WHEN attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
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
                (from_id, from_name, to_id, text, time, reply_to_id, client_id, attachment)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (from_id, client_id) WHERE client_id IS NOT NULL
            DO UPDATE SET client_id = EXCLUDED.client_id
            RETURNING id::int, time, (xmax = 0) AS inserted
        `, [userId, socket.user.name, toId, text, time, reply && reply.id, clientId, attachment]);
        const message = {
            id: result.rows[0].id,
            fromId: userId,
            fromName: socket.user.name,
            toId,
            text,
            attachment,
            time: result.rows[0].time,
            replyToId: reply && reply.id,
            replyToName: reply && reply.replyToName,
            replyToText: reply && reply.replyToText,
            clientId
        };
        io.to(`private:${userId}`).to(`private:${toId}`)
            .emit("private message", message);
        io.to(`private:${toId}`).emit("unread changed");
        if (result.rows[0].inserted) void sendPushToUsers([toId], {
            title: socket.user.name,
            body: text || (attachment ? `📎 ${attachment.fileName || "파일"}` : "새 메시지"),
            url: `/private.html?id=${encodeURIComponent(userId)}`,
            tag: `ourcom-private-${userId}`
        });
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
                   m.text, m.time, CASE WHEN m.deleted_at IS NULL THEN m.attachment END AS attachment,
                   (m.edited_at IS NOT NULL) AS edited,
                   (m.deleted_at IS NOT NULL) AS deleted,
                   m.reply_to_id::int AS "replyToId", reply.user_name AS "replyToName",
                   COALESCE(NULLIF(reply.text, ''), CASE WHEN reply.attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
            FROM group_room_messages m
            LEFT JOIN group_room_messages reply ON reply.id = m.reply_to_id
            WHERE m.room_id = $1
            ORDER BY m.id DESC
            LIMIT 51
        `, [roomId]);
        const unread = await query(`
            SELECT MIN(m.id)::int AS "firstUnreadId"
            FROM group_room_messages m
            JOIN group_room_members member
              ON member.room_id = m.room_id AND member.user_id = $2
            WHERE m.room_id = $1 AND m.user_id <> $2
              AND m.created_at >= member.joined_at
              AND NOT EXISTS (
                  SELECT 1 FROM group_room_reads r
                  WHERE r.message_id = m.id AND r.user_id = $2
              )
        `, [roomId, userId]);
        socket.emit("chat room history", {
            roomId,
            ...messagePage(result.rows),
            firstUnreadId: unread.rows[0].firstUnreadId
        });
    }));

    socket.on("chat room message", guard(async data => {
        const roomId = Number(data && data.roomId);
        const text = safeText(data && data.text);
        const attachment = safeAttachment(data && data.attachment, userId);
        const clientId = safeText(data && data.clientId, 80) || null;
        const requestedReplyId = Number(data && data.replyToId);
        if (!Number.isInteger(roomId) || (!text && !attachment)) return;
        const member = await query(
            "SELECT 1 FROM group_room_members WHERE room_id = $1 AND user_id = $2",
            [roomId, userId]
        );
        if (!member.rowCount) return;
        let reply = null;
        if (Number.isInteger(requestedReplyId) && requestedReplyId > 0) {
            const replyResult = await query(`
                SELECT id::int, user_name AS "replyToName",
                       COALESCE(NULLIF(text, ''), CASE WHEN attachment IS NOT NULL THEN '📎 파일' END) AS "replyToText"
                FROM group_room_messages
                WHERE id = $1 AND room_id = $2
            `, [requestedReplyId, roomId]);
            reply = replyResult.rows[0] || null;
            if (!reply) return;
        }
        const time = chatTime();
        const result = await query(`
            INSERT INTO group_room_messages
                (room_id, user_id, user_name, text, time, reply_to_id, client_id, attachment)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (room_id, user_id, client_id) WHERE client_id IS NOT NULL
            DO UPDATE SET client_id = EXCLUDED.client_id
            RETURNING id::int, time, (xmax = 0) AS inserted
        `, [roomId, userId, socket.user.name, text, time, reply && reply.id, clientId, attachment]);
        io.to(`chatroom:${roomId}`).emit("chat room message", {
            id: result.rows[0].id,
            roomId,
            userId,
            userName: socket.user.name,
            text,
            attachment,
            time: result.rows[0].time,
            replyToId: reply && reply.id,
            replyToName: reply && reply.replyToName,
            replyToText: reply && reply.replyToText,
            clientId
        });
        void notifyRoomMembers(roomId, "unread changed");
        if (result.rows[0].inserted) void pushToRoom(roomId, userId, {
            title: "OURCOM 단체 채팅",
            body: pushMessageBody(socket.user.name, text, attachment),
            url: `/group-room.html?id=${roomId}`,
            tag: `ourcom-room-${roomId}`
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
            WHERE id = $1 AND (user_id = $2 OR $3 = 'admin') AND deleted_at IS NULL
            RETURNING id::int, attachment
        `, [messageId, userId, socket.user.role]);
        if (!result.rowCount) return;
        void destroyAttachment(result.rows[0].attachment);
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
            RETURNING id::int, from_id, to_id, attachment
        `, [messageId, userId]);
        if (!result.rowCount) return;
        const row = result.rows[0];
        void destroyAttachment(row.attachment);
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
            RETURNING id::int, attachment
        `, [messageId, roomId, userId]);
        if (!result.rowCount) return;
        void destroyAttachment(result.rows[0].attachment);
        io.to(`chatroom:${roomId}`).emit("chat room message updated", {
            id: result.rows[0].id,
            roomId,
            text: "삭제된 메시지",
            edited: false,
            deleted: true
        });
    }));

    socket.on("disconnect", () => {
        const remaining = Math.max((onlineUsers.get(userId) || 1) - 1, 0);
        if (remaining) onlineUsers.set(userId, remaining);
        else onlineUsers.delete(userId);
        void query("UPDATE users SET last_active_at = NOW() WHERE id = $1", [userId]);
    });
});

app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    res.status(Number.isInteger(error.status) ? error.status : 500).json({
        success: false,
        message: Number.isInteger(error.status) ? error.message : "서버 오류가 발생했습니다."
    });
});

async function start() {
    await initializeDatabase();
    await initializePushNotifications();
    await createAdmin();
    server.listen(PORT, () => {
        console.log(`OURCOM 서버 실행: ${PORT}번 포트`);
    });
}

start().catch(error => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
