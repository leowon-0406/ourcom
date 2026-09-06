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
            joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            subscription JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS user_aliases (
            owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
            target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
            alias TEXT NOT NULL,
            PRIMARY KEY (owner_id, target_id)
        );

        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
            friends_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS registration_requests (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            password TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ
        );

        CREATE INDEX IF NOT EXISTS private_messages_to_from_idx
            ON private_messages (to_id, from_id, id);
        CREATE INDEX IF NOT EXISTS private_reads_user_idx
            ON private_reads (user_id, message_id);
        CREATE INDEX IF NOT EXISTS group_room_members_user_idx
            ON group_room_members (user_id, room_id);
        CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
            ON push_subscriptions (user_id);

        ALTER TABLE group_messages
            ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;
        ALTER TABLE private_messages
            ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;
        ALTER TABLE group_room_messages
            ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS profile_image JSONB;
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        ALTER TABLE group_messages
            ADD COLUMN IF NOT EXISTS client_id TEXT;
        ALTER TABLE private_messages
            ADD COLUMN IF NOT EXISTS client_id TEXT;
        ALTER TABLE group_room_messages
            ADD COLUMN IF NOT EXISTS client_id TEXT;
        ALTER TABLE group_messages
            ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
        ALTER TABLE group_messages
            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE private_messages
            ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
        ALTER TABLE private_messages
            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE group_room_messages
            ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
        ALTER TABLE group_room_messages
            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE group_messages
            ADD COLUMN IF NOT EXISTS attachment JSONB;
        ALTER TABLE private_messages
            ADD COLUMN IF NOT EXISTS attachment JSONB;
        ALTER TABLE group_room_messages
            ADD COLUMN IF NOT EXISTS attachment JSONB;
        ALTER TABLE group_room_members
            ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;
        UPDATE group_room_members members
        SET joined_at = rooms.created_at
        FROM group_rooms rooms
        WHERE members.room_id = rooms.id AND members.joined_at IS NULL;
        ALTER TABLE group_room_members
            ALTER COLUMN joined_at SET DEFAULT NOW();
        ALTER TABLE group_room_members
            ALTER COLUMN joined_at SET NOT NULL;

        CREATE INDEX IF NOT EXISTS group_messages_reply_idx
            ON group_messages (reply_to_id);
        CREATE INDEX IF NOT EXISTS private_messages_reply_idx
            ON private_messages (reply_to_id);
        CREATE INDEX IF NOT EXISTS group_room_messages_reply_idx
            ON group_room_messages (reply_to_id);
        CREATE INDEX IF NOT EXISTS group_messages_page_idx
            ON group_messages (id DESC);
        CREATE INDEX IF NOT EXISTS private_messages_conversation_idx
            ON private_messages (from_id, to_id, id DESC);
        CREATE INDEX IF NOT EXISTS private_messages_from_recent_idx
            ON private_messages (from_id, id DESC);
        CREATE INDEX IF NOT EXISTS private_messages_to_recent_idx
            ON private_messages (to_id, id DESC);
        CREATE INDEX IF NOT EXISTS group_room_messages_page_idx
            ON group_room_messages (room_id, id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS group_messages_client_idx
            ON group_messages (user_id, client_id) WHERE client_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS private_messages_client_idx
            ON private_messages (from_id, client_id) WHERE client_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS group_room_messages_client_idx
            ON group_room_messages (room_id, user_id, client_id) WHERE client_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at DESC);
        CREATE INDEX IF NOT EXISTS users_active_idx ON users (last_active_at DESC);
        CREATE INDEX IF NOT EXISTS registration_requests_status_idx
            ON registration_requests (status, created_at DESC);
    `);
}

module.exports = {
    pool,
    query,
    transaction,
    initializeDatabase
};
