const Database = require("better-sqlite3");

const db = new Database("ourcom.db");

db.pragma("journal_mode = WAL");

// ==================================================
// 사용자
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user'
    )
`).run();


// ==================================================
// 전체 채팅
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL
    )
`).run();


// ==================================================
// 1:1 채팅
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_id TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL
    )
`).run();


// ==================================================
// 전체 채팅 읽음
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS group_reads (
        message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY(message_id, user_id)
    )
`).run();


// ==================================================
// 1:1 읽음
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS private_reads (
        message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY(message_id, user_id)
    )
`).run();


// ==================================================
// 전체 채팅 공감
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS group_reactions (
        message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        reaction TEXT NOT NULL DEFAULT '❤️',

        PRIMARY KEY(message_id, user_id, reaction)
    )
`).run();


// ==================================================
// 단톡방
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS chat_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
`).run();


// ==================================================
// 단톡방 멤버
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS chat_group_members (
        group_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,

        PRIMARY KEY(group_id, user_id)
    )
`).run();


// ==================================================
// 단톡방 메시지
// ==================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS chat_group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL
    )
`).run();


console.log("OURCOM 데이터베이스 준비 완료");

module.exports = db;