const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const { Server } = require("socket.io");
const db = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;


// ==================================================
// 기본 설정
// ==================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
    secret: "OURCOM_SECRET_2026",
    resave: false,
    saveUninitialized: false,

    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 30
    }
});

app.use(sessionMiddleware);

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


// ==================================================
// 단체 채팅 DB
// ==================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS group_rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_room_members (
        room_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        PRIMARY KEY(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_room_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_room_reads (
        message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY(message_id, user_id)
    );
`);


// ==================================================
// 초기 관리자
// ==================================================

const ADMIN = {
    id: "leowon0406",
    name: "원준영",
    password: "3612asdf!!",
    role: "admin"
};


function createAdmin() {

    const exists = db.prepare(`
        SELECT id
        FROM users
        WHERE id = ?
    `).get(ADMIN.id);

    if (!exists) {

        db.prepare(`
            INSERT INTO users
            (
                id,
                name,
                password,
                role
            )
            VALUES (?, ?, ?, ?)
        `).run(
            ADMIN.id,
            ADMIN.name,
            ADMIN.password,
            ADMIN.role
        );

        console.log("초기 관리자 계정 생성 완료");
    }
}

createAdmin();


// ==================================================
// 로그인 확인
// ==================================================

function requireLogin(req, res, next) {

    if (!req.session.user) {

        return res.status(401).json({
            success: false,
            message: "로그인이 필요합니다."
        });

    }

    next();
}


// ==================================================
// 관리자 확인
// ==================================================

function adminOnly(req, res, next) {

    if (
        !req.session.user ||
        req.session.user.role !== "admin"
    ) {

        return res.status(403).json({
            success: false,
            message: "관리자만 사용할 수 있습니다."
        });

    }

    next();
}


// ==================================================
// 사용자 목록
// ==================================================

function getUsers() {

    return db.prepare(`
        SELECT
            id,
            name,
            role
        FROM users
        ORDER BY name
    `).all();

}


// ==================================================
// 로그인
// ==================================================

app.post("/api/login", (req, res) => {

    const {
        id,
        password
    } = req.body;

    if (!id || !password) {

        return res.status(400).json({
            success: false,
            message: "아이디와 비밀번호를 입력해주세요."
        });

    }

    const user = db.prepare(`
        SELECT
            id,
            name,
            role
        FROM users
        WHERE id = ?
        AND password = ?
    `).get(id, password);

    if (!user) {

        return res.status(401).json({
            success: false,
            message:
                "아이디 또는 비밀번호가 올바르지 않습니다."
        });

    }

    req.session.user = user;

    res.json({
        success: true,
        user
    });

});


// ==================================================
// 현재 사용자
// ==================================================

app.get("/api/me", (req, res) => {

    if (!req.session.user) {

        return res.json({
            loggedIn: false
        });

    }

    res.json({
        loggedIn: true,
        user: req.session.user
    });

});


// ==================================================
// 사용자 목록
// ==================================================

app.get(
    "/api/users",
    requireLogin,
    (req, res) => {

        const users =
            getUsers().filter(
                user =>
                    user.id !==
                    req.session.user.id
            );

        res.json({
            success: true,
            users
        });

    }
);


// ==================================================
// 관리자 사용자 목록
// ==================================================

app.get(
    "/api/admin/users",
    adminOnly,
    (req, res) => {

        const users = db.prepare(`
            SELECT
                id,
                name
            FROM users
            WHERE id != ?
            ORDER BY name
        `).all(ADMIN.id);

        res.json({
            success: true,
            users
        });

    }
);


// ==================================================
// 관리자 사용자 생성
// ==================================================

app.post(
    "/api/admin/users",
    adminOnly,
    (req, res) => {

        const {
            id,
            name,
            password
        } = req.body;

        if (!id || !name || !password) {

            return res.status(400).json({
                success: false,
                message: "모든 항목을 입력해주세요."
            });

        }

        const exists = db.prepare(`
            SELECT id
            FROM users
            WHERE id = ?
        `).get(id);

        if (exists) {

            return res.status(400).json({
                success: false,
                message:
                    "이미 존재하는 아이디입니다."
            });

        }

        db.prepare(`
            INSERT INTO users
            (
                id,
                name,
                password,
                role
            )
            VALUES (?, ?, ?, 'user')
        `).run(
            id,
            name,
            password
        );

        res.json({
            success: true,
            message:
                `${name}님의 계정이 생성되었습니다.`
        });

    }
);


// ==================================================
// 관리자 사용자 삭제
// ==================================================

app.delete(
    "/api/admin/users/:id",
    adminOnly,
    (req, res) => {

        const userId =
            req.params.id;

        if (userId === ADMIN.id) {

            return res.status(400).json({
                success: false,
                message:
                    "초기 관리자는 삭제할 수 없습니다."
            });

        }

        db.prepare(`
            DELETE FROM users
            WHERE id = ?
        `).run(userId);

        res.json({
            success: true
        });

    }
);


// ==================================================
// 전체 채팅
// ==================================================

app.get(
    "/api/group-messages",
    requireLogin,
    (req, res) => {

        const messages =
            db.prepare(`
                SELECT
                    id,
                    user_id AS userId,
                    user_name AS name,
                    text,
                    time
                FROM group_messages
                ORDER BY id ASC
            `).all();

        res.json({
            success: true,
            messages
        });

    }
);


app.post(
    "/api/group-read",
    requireLogin,
    (req, res) => {

        const {
            messageIds
        } = req.body;

        if (!Array.isArray(messageIds)) {

            return res.status(400).json({
                success: false
            });

        }

        const insert =
            db.prepare(`
                INSERT OR IGNORE INTO
                group_reads
                (
                    message_id,
                    user_id
                )
                VALUES (?, ?)
            `);

        const transaction =
            db.transaction(ids => {

                for (const id of ids) {

                    insert.run(
                        Number(id),
                        req.session.user.id
                    );

                }

            });

        transaction(messageIds);

        io.emit(
            "read-status-update"
        );

        res.json({
            success: true
        });

    }
);


app.get(
    "/api/group-unread-counts",
    requireLogin,
    (req, res) => {

        const users =
            getUsers();

        const messages =
            db.prepare(`
                SELECT
                    id,
                    user_id
                FROM group_messages
            `).all();

        const counts = {};

        for (const message of messages) {

            const reads =
                db.prepare(`
                    SELECT user_id
                    FROM group_reads
                    WHERE message_id = ?
                `).all(message.id);

            const readSet =
                new Set(
                    reads.map(
                        row => row.user_id
                    )
                );

            readSet.add(
                message.user_id
            );

            let count = 0;

            for (const user of users) {

                if (!readSet.has(user.id)) {
                    count++;
                }

            }

            counts[message.id] =
                count;
        }

        res.json({
            success: true,
            counts
        });

    }
);


// ==================================================
// 1:1 채팅
// ==================================================

app.get(
    "/api/private-messages/:userId",
    requireLogin,
    (req, res) => {

        const me =
            req.session.user.id;

        const other =
            req.params.userId;

        const otherUser =
            db.prepare(`
                SELECT
                    id,
                    name,
                    role
                FROM users
                WHERE id = ?
            `).get(other);

        if (!otherUser) {

            return res.status(404).json({
                success: false,
                message:
                    "사용자를 찾을 수 없습니다."
            });

        }

        const messages =
            db.prepare(`
                SELECT
                    id,
                    from_id AS fromId,
                    from_name AS fromName,
                    to_id AS toId,
                    text,
                    time
                FROM private_messages
                WHERE
                    (
                        from_id = ?
                        AND to_id = ?
                    )
                    OR
                    (
                        from_id = ?
                        AND to_id = ?
                    )
                ORDER BY id ASC
            `).all(
                me,
                other,
                other,
                me
            );

        res.json({
            success: true,
            user: otherUser,
            messages
        });

    }
);


app.post(
    "/api/private-messages/:userId",
    requireLogin,
    (req, res) => {

        const from =
            req.session.user;

        const toId =
            req.params.userId;

        const text =
            typeof req.body.text === "string"
                ? req.body.text.trim()
                : "";

        if (!text) {

            return res.status(400).json({
                success: false,
                message:
                    "메시지를 입력해주세요."
            });

        }

        const target =
            db.prepare(`
                SELECT id, name
                FROM users
                WHERE id = ?
            `).get(toId);

        if (!target) {

            return res.status(404).json({
                success: false,
                message:
                    "상대방을 찾을 수 없습니다."
            });

        }

        const time =
            new Date().toLocaleTimeString(
                "ko-KR",
                {
                    hour: "2-digit",
                    minute: "2-digit"
                }
            );

        const result =
            db.prepare(`
                INSERT INTO private_messages
                (
                    from_id,
                    from_name,
                    to_id,
                    text,
                    time
                )
                VALUES (?, ?, ?, ?, ?)
            `).run(
                from.id,
                from.name,
                toId,
                text,
                time
            );

        const message = {

            id:
                Number(
                    result.lastInsertRowid
                ),

            fromId:
                from.id,

            fromName:
                from.name,

            toId,

            text,

            time
        };

        io.to(`private:${from.id}`)
            .to(`private:${toId}`)
            .emit(
                "private message",
                message
            );

        res.json({
            success: true,
            message
        });

    }
);


app.post(
    "/api/private-read",
    requireLogin,
    (req, res) => {

        const {
            messageIds
        } = req.body;

        if (!Array.isArray(messageIds)) {

            return res.status(400).json({
                success: false
            });

        }

        const insert =
            db.prepare(`
                INSERT OR IGNORE INTO
                private_reads
                (
                    message_id,
                    user_id
                )
                VALUES (?, ?)
            `);

        const transaction =
            db.transaction(ids => {

                for (const id of ids) {

                    insert.run(
                        Number(id),
                        req.session.user.id
                    );

                }

            });

        transaction(messageIds);

        io.emit(
            "private-read-update"
        );

        res.json({
            success: true
        });

    }
);


app.get(
    "/api/private-unread-counts",
    requireLogin,
    (req, res) => {

        const me =
            req.session.user.id;

        const users =
            getUsers().filter(
                user =>
                    user.id !== me
            );

        const counts = {};

        for (const user of users) {

            const result =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM private_messages AS message
                    WHERE
                        message.from_id = ?
                        AND message.to_id = ?
                        AND NOT EXISTS (
                            SELECT 1
                            FROM private_reads AS read
                            WHERE
                                read.message_id =
                                    message.id
                                AND
                                read.user_id = ?
                        )
                `).get(
                    user.id,
                    me,
                    me
                );

            counts[user.id] =
                result.count;
        }

        res.json({
            success: true,
            counts
        });

    }
);


// ==================================================
// ⭐ 단체 채팅 - 방 목록
// ==================================================

app.get(
    "/api/chat-rooms",
    requireLogin,
    (req, res) => {

        const me =
            req.session.user.id;

        const rooms =
            db.prepare(`
                SELECT
                    r.id,
                    r.name,
                    r.creator_id AS creatorId,
                    r.creator_name AS creatorName,
                    r.created_at AS createdAt,

                    (
                        SELECT COUNT(*)
                        FROM group_room_members m
                        WHERE m.room_id = r.id
                    ) AS memberCount

                FROM group_rooms r

                WHERE EXISTS (
                    SELECT 1
                    FROM group_room_members m
                    WHERE
                        m.room_id = r.id
                        AND m.user_id = ?
                )

                ORDER BY r.id DESC
            `).all(me);

        res.json({
            success: true,
            rooms
        });

    }
);


// ==================================================
// ⭐ 단체 채팅 - 방 생성
// ==================================================

app.post(
    "/api/chat-rooms",
    requireLogin,
    (req, res) => {

        const user =
            req.session.user;

        const name =
            typeof req.body.name === "string"
                ? req.body.name.trim()
                : "";

        const memberIds =
            Array.isArray(req.body.memberIds)
                ? req.body.memberIds
                : [];

        if (!name) {

            return res.status(400).json({
                success: false,
                message:
                    "채팅방 이름을 입력해주세요."
            });

        }

        if (name.length > 50) {

            return res.status(400).json({
                success: false,
                message:
                    "채팅방 이름은 50자 이하로 해주세요."
            });

        }


        // 중복 제거
        const uniqueIds =
            [
                user.id,
                ...memberIds
            ];

        const ids =
            [...new Set(uniqueIds)]
                .filter(
                    id =>
                        typeof id === "string" &&
                        id.trim() !== ""
                );


        if (ids.length < 2) {

            return res.status(400).json({
                success: false,
                message:
                    "최소 1명 이상의 친구를 선택해주세요."
            });

        }


        // 실제 존재하는 사용자만 허용
        const placeholders =
            ids.map(() => "?").join(",");

        const users =
            db.prepare(`
                SELECT
                    id,
                    name
                FROM users
                WHERE id IN (${placeholders})
            `).all(...ids);


        if (users.length !== ids.length) {

            return res.status(400).json({
                success: false,
                message:
                    "존재하지 않는 사용자가 포함되어 있습니다."
            });

        }


        const time =
            new Date().toISOString();


        const createRoom =
            db.transaction(() => {

                const result =
                    db.prepare(`
                        INSERT INTO group_rooms
                        (
                            name,
                            creator_id,
                            creator_name,
                            created_at
                        )
                        VALUES (?, ?, ?, ?)
                    `).run(
                        name,
                        user.id,
                        user.name,
                        time
                    );


                const roomId =
                    Number(
                        result.lastInsertRowid
                    );


                const insertMember =
                    db.prepare(`
                        INSERT INTO
                        group_room_members
                        (
                            room_id,
                            user_id,
                            user_name
                        )
                        VALUES (?, ?, ?)
                    `);


                for (const member of users) {

                    insertMember.run(
                        roomId,
                        member.id,
                        member.name
                    );

                }


                return roomId;

            });


        const room =
            db.prepare(`
                SELECT
                    id,
                    name,
                    creator_id AS creatorId,
                    creator_name AS creatorName,
                    created_at AS createdAt
                FROM group_rooms
                WHERE id = ?
            `).get(createRoom);


        res.json({
            success: true,
            room
        });

    }
);


// ==================================================
// ⭐ 단체 채팅 - 방 정보
// ==================================================

app.get(
    "/api/chat-rooms/:roomId",
    requireLogin,
    (req, res) => {

        const roomId =
            Number(req.params.roomId);

        const me =
            req.session.user.id;


        const room =
            db.prepare(`
                SELECT
                    id,
                    name,
                    creator_id AS creatorId,
                    creator_name AS creatorName,
                    created_at AS createdAt
                FROM group_rooms
                WHERE id = ?
            `).get(roomId);


        if (!room) {

            return res.status(404).json({
                success: false,
                message:
                    "채팅방을 찾을 수 없습니다."
            });

        }


        const member =
            db.prepare(`
                SELECT 1
                FROM group_room_members
                WHERE
                    room_id = ?
                    AND user_id = ?
            `).get(
                roomId,
                me
            );


        if (!member) {

            return res.status(403).json({
                success: false,
                message:
                    "이 채팅방의 멤버가 아닙니다."
            });

        }


        const members =
            db.prepare(`
                SELECT
                    user_id AS id,
                    user_name AS name
                FROM group_room_members
                WHERE room_id = ?
                ORDER BY rowid ASC
            `).all(roomId);


        res.json({
            success: true,
            room,
            members
        });

    }
);


// ==================================================
// ⭐ 단체 채팅 - 메시지 불러오기
// ==================================================

app.get(
    "/api/chat-rooms/:roomId/messages",
    requireLogin,
    (req, res) => {

        const roomId =
            Number(req.params.roomId);

        const me =
            req.session.user.id;


        const member =
            db.prepare(`
                SELECT 1
                FROM group_room_members
                WHERE
                    room_id = ?
                    AND user_id = ?
            `).get(
                roomId,
                me
            );


        if (!member) {

            return res.status(403).json({
                success: false,
                message:
                    "채팅방 멤버가 아닙니다."
            });

        }


        const messages =
            db.prepare(`
                SELECT
                    id,
                    user_id AS userId,
                    user_name AS userName,
                    text,
                    time
                FROM group_room_messages
                WHERE room_id = ?
                ORDER BY id ASC
            `).all(roomId);


        res.json({
            success: true,
            messages
        });

    }
);


// ==================================================
// ⭐ 단체 채팅 - 방 나가기
// ==================================================

app.delete(
    "/api/chat-rooms/:roomId/leave",
    requireLogin,
    (req, res) => {

        const roomId =
            Number(req.params.roomId);

        const me =
            req.session.user.id;


        const room =
            db.prepare(`
                SELECT *
                FROM group_rooms
                WHERE id = ?
            `).get(roomId);


        if (!room) {

            return res.status(404).json({
                success: false,
                message:
                    "채팅방을 찾을 수 없습니다."
            });

        }


        db.prepare(`
            DELETE FROM group_room_members
            WHERE
                room_id = ?
                AND user_id = ?
        `).run(
            roomId,
            me
        );


        // 멤버가 하나도 없으면 방 삭제
        const remaining =
            db.prepare(`
                SELECT COUNT(*) AS count
                FROM group_room_members
                WHERE room_id = ?
            `).get(roomId);


        if (remaining.count === 0) {

            db.prepare(`
                DELETE FROM group_room_messages
                WHERE room_id = ?
            `).run(roomId);

            db.prepare(`
                DELETE FROM group_room_reads
                WHERE message_id IN (
                    SELECT id
                    FROM group_room_messages
                    WHERE room_id = ?
                )
            `).run(roomId);

            db.prepare(`
                DELETE FROM group_rooms
                WHERE id = ?
            `).run(roomId);

        }


        res.json({
            success: true
        });

    }
);


// ==================================================
// 로그아웃
// ==================================================

app.post(
    "/api/logout",
    (req, res) => {

        req.session.destroy(() => {

            res.json({
                success: true
            });

        });

    }
);


// ==================================================
// Socket.IO 세션
// ==================================================

io.engine.use(
    sessionMiddleware
);


io.use(
    (socket, next) => {

        const socketSession =
            socket.request.session;

        if (
            !socketSession ||
            !socketSession.user
        ) {

            return next(
                new Error(
                    "로그인이 필요합니다."
                )
            );

        }

        socket.user =
            socketSession.user;

        next();

    }
);


// ==================================================
// Socket.IO
// ==================================================

io.on(
    "connection",
    socket => {

        const userId =
            socket.user.id;


        console.log(
            `🟢 ${socket.user.name}님 접속`
        );


        // 개인 방
        socket.join(
            `private:${userId}`
        );


        // ==========================================
        // 전체 채팅
        // ==========================================

        socket.on(
            "join group",
            () => {

                socket.join("group");

                const messages =
                    db.prepare(`
                        SELECT
                            id,
                            user_id AS userId,
                            user_name AS name,
                            text,
                            time
                        FROM group_messages
                        ORDER BY id ASC
                    `).all();

                socket.emit(
                    "group history",
                    messages
                );

            }
        );


        socket.on(
            "group message",
            text => {

                if (
                    typeof text !== "string"
                ) {
                    return;
                }

                text =
                    text.trim();

                if (!text) {
                    return;
                }

                const time =
                    new Date().toLocaleTimeString(
                        "ko-KR",
                        {
                            hour: "2-digit",
                            minute: "2-digit"
                        }
                    );


                const result =
                    db.prepare(`
                        INSERT INTO group_messages
                        (
                            user_id,
                            user_name,
                            text,
                            time
                        )
                        VALUES (?, ?, ?, ?)
                    `).run(
                        userId,
                        socket.user.name,
                        text,
                        time
                    );


                const message = {

                    id:
                        Number(
                            result.lastInsertRowid
                        ),

                    userId,

                    name:
                        socket.user.name,

                    text,

                    time

                };


                io.to("group").emit(
                    "group message",
                    message
                );

            }
        );


        // ==========================================
        // 1:1
        // ==========================================

        socket.on(
            "join private",
            otherId => {

                if (
                    typeof otherId !== "string" ||
                    otherId === userId
                ) {
                    return;
                }


                const otherUser =
                    db.prepare(`
                        SELECT
                            id,
                            name
                        FROM users
                        WHERE id = ?
                    `).get(otherId);


                if (!otherUser) {
                    return;
                }


                const messages =
                    db.prepare(`
                        SELECT
                            id,
                            from_id AS fromId,
                            from_name AS fromName,
                            to_id AS toId,
                            text,
                            time
                        FROM private_messages
                        WHERE
                            (
                                from_id = ?
                                AND to_id = ?
                            )
                            OR
                            (
                                from_id = ?
                                AND to_id = ?
                            )
                        ORDER BY id ASC
                    `).all(
                        userId,
                        otherId,
                        otherId,
                        userId
                    );


                socket.emit(
                    "private history",
                    {
                        user: otherUser,
                        messages
                    }
                );

            }
        );


        socket.on(
            "private message",
            data => {

                if (
                    !data ||
                    typeof data.toId !== "string" ||
                    typeof data.text !== "string"
                ) {
                    return;
                }


                const toId =
                    data.toId;

                const text =
                    data.text.trim();


                if (!text) {
                    return;
                }

                if (toId === userId) {
                    return;
                }


                const target =
                    db.prepare(`
                        SELECT id, name
                        FROM users
                        WHERE id = ?
                    `).get(toId);


                if (!target) {
                    return;
                }


                const time =
                    new Date().toLocaleTimeString(
                        "ko-KR",
                        {
                            hour: "2-digit",
                            minute: "2-digit"
                        }
                    );


                const result =
                    db.prepare(`
                        INSERT INTO private_messages
                        (
                            from_id,
                            from_name,
                            to_id,
                            text,
                            time
                        )
                        VALUES (?, ?, ?, ?, ?)
                    `).run(
                        userId,
                        socket.user.name,
                        toId,
                        text,
                        time
                    );


                const message = {

                    id:
                        Number(
                            result.lastInsertRowid
                        ),

                    fromId:
                        userId,

                    fromName:
                        socket.user.name,

                    toId,

                    text,

                    time

                };


                io.to(`private:${userId}`)
                    .to(`private:${toId}`)
                    .emit(
                        "private message",
                        message
                    );

            }
        );


        // ==========================================
        // ⭐ 단체 채팅방 입장
        // ==========================================

        socket.on(
            "join chat room",
            roomId => {

                roomId =
                    Number(roomId);


                if (
                    !Number.isInteger(roomId)
                ) {
                    return;
                }


                const member =
                    db.prepare(`
                        SELECT 1
                        FROM group_room_members
                        WHERE
                            room_id = ?
                            AND user_id = ?
                    `).get(
                        roomId,
                        userId
                    );


                if (!member) {

                    socket.emit(
                        "chat room error",
                        "이 채팅방의 멤버가 아닙니다."
                    );

                    return;
                }


                const room =
                    `chatroom:${roomId}`;


                socket.join(room);


                const messages =
                    db.prepare(`
                        SELECT
                            id,
                            user_id AS userId,
                            user_name AS userName,
                            text,
                            time
                        FROM group_room_messages
                        WHERE room_id = ?
                        ORDER BY id ASC
                    `).all(roomId);


                socket.emit(
                    "chat room history",
                    {
                        roomId,
                        messages
                    }
                );

            }
        );


        // ==========================================
        // ⭐ 단체 채팅 메시지
        // ==========================================

        socket.on(
            "chat room message",
            data => {

                if (!data) {
                    return;
                }


                const roomId =
                    Number(data.roomId);


                const text =
                    typeof data.text === "string"
                        ? data.text.trim()
                        : "";


                if (
                    !Number.isInteger(roomId) ||
                    !text
                ) {
                    return;
                }


                const member =
                    db.prepare(`
                        SELECT 1
                        FROM group_room_members
                        WHERE
                            room_id = ?
                            AND user_id = ?
                    `).get(
                        roomId,
                        userId
                    );


                if (!member) {
                    return;
                }


                const time =
                    new Date().toLocaleTimeString(
                        "ko-KR",
                        {
                            hour: "2-digit",
                            minute: "2-digit"
                        }
                    );


                const result =
                    db.prepare(`
                        INSERT INTO group_room_messages
                        (
                            room_id,
                            user_id,
                            user_name,
                            text,
                            time
                        )
                        VALUES (?, ?, ?, ?, ?)
                    `).run(
                        roomId,
                        userId,
                        socket.user.name,
                        text,
                        time
                    );


                const message = {

                    id:
                        Number(
                            result.lastInsertRowid
                        ),

                    roomId,

                    userId,

                    userName:
                        socket.user.name,

                    text,

                    time

                };


                io.to(
                    `chatroom:${roomId}`
                ).emit(
                    "chat room message",
                    message
                );

            }
        );


        // ==========================================
        // 연결 종료
        // ==========================================

        socket.on(
            "disconnect",
            () => {

                console.log(
                    `🔴 ${socket.user.name}님 접속 종료`
                );

            }
        );

    }
);


// ==================================================
// 서버 실행
// ==================================================

server.listen(
    PORT,
    () => {

        console.log("");
        console.log("================================");
        console.log("            OURCOM");
        console.log("        우리들만의 소통망");
        console.log("================================");
        console.log(
            `http://localhost:${PORT}`
        );
        console.log("================================");
        console.log("");

    }
);