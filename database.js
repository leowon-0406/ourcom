const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL 환경 변수가 없습니다. Render PostgreSQL 연결 주소를 설정해주세요.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});

async function query(text, params = []) {
    return pool.query(text, params);
}

async function transaction(callback) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function initializeDatabase() {
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user'
        );

        CREATE TABLE IF NOT EXISTS group_messages (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            text TEXT NOT NULL,
            time TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS private_messages (
            id BIGSERIAL PRIMARY KEY,
            from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            from_name TEXT NOT NULL,
            to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            time TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS group_reads (
            message_id BIGINT NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (message_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS private_reads (
            message_id BIGINT NOT NULL REFERENCES private_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (message_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS group_rooms (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            creator_name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS group_room_members (
            room_id BIGINT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            PRIMARY KEY (room_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS group_room_messages (
            id BIGSERIAL PRIMARY KEY,
            room_id BIGINT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            text TEXT NOT NULL,
            time TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS group_room_reads (
            message_id BIGINT NOT NULL REFERENCES group_room_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (message_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS private_messages_to_from_idx
            ON private_messages (to_id, from_id, id);
        CREATE INDEX IF NOT EXISTS private_reads_user_idx
            ON private_reads (user_id, message_id);
        CREATE INDEX IF NOT EXISTS group_room_members_user_idx
            ON group_room_members (user_id, room_id);
    `);
}

module.exports = {
    pool,
    query,
    transaction,
    initializeDatabase
};
