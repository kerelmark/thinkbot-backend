"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const promise_1 = __importDefault(require("mysql2/promise"));
const dotenv_1 = __importDefault(require("dotenv"));
const web3_js_1 = require("@solana/web3.js");
const bs58_1 = __importDefault(require("bs58"));
const genai_1 = require("@google/genai");
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
dotenv_1.default.config();
/* -------------------------------------------------------------------------- */
/*                                EXPRESS SETUP                               */
/* -------------------------------------------------------------------------- */
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
app.use((0, cors_1.default)({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express_1.default.json());
/* -------------------------------------------------------------------------- */
/*                             GOOGLE GEN AI CLIENT                            */
/* -------------------------------------------------------------------------- */
const ai = new genai_1.GoogleGenAI({ apiKey: process.env.API_KEY });
/* -------------------------------------------------------------------------- */
/*                                RATE LIMITER                                */
/* -------------------------------------------------------------------------- */
const rateLimitMap = new Map();
const rateLimitMiddleware = (req, res, next) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const WINDOW_MS = 15 * 60 * 1000;
    const MAX_REQUESTS = 300;
    const record = rateLimitMap.get(ip) || { count: 0, lastReset: now };
    if (now - record.lastReset > WINDOW_MS) {
        record.count = 0;
        record.lastReset = now;
    }
    if (record.count >= MAX_REQUESTS) {
        return res
            .status(429)
            .json({ error: "Too many requests, try again later." });
    }
    record.count++;
    rateLimitMap.set(ip, record);
    next();
};
app.use(rateLimitMiddleware);
/* -------------------------------------------------------------------------- */
/*                                DATABASE SETUP                               */
/* -------------------------------------------------------------------------- */
const pool = promise_1.default.createPool({
    uri: process.env.DATABASE_URL,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
});
pool.getConnection()
    .then((conn) => {
    console.log("✅ MySQL Connected");
    conn.release();
})
    .catch((err) => {
    console.error("❌ MySQL Connection Failed:", err.message);
});
/* -------------------------------------------------------------------------- */
/*                            SOLANA RPC / WALLET                              */
/* -------------------------------------------------------------------------- */
const RPC_ENDPOINTS = [
    process.env.SOLANA_RPC,
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/solana",
].filter(Boolean);
let connection;
async function getConnection() {
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const conn = new web3_js_1.Connection(rpc, "confirmed");
            await conn.getSlot();
            console.log(`Connected to RPC: ${rpc}`);
            return conn;
        }
        catch {
            console.warn(`RPC failed: ${rpc}`);
        }
    }
    return new web3_js_1.Connection("https://api.mainnet-beta.solana.com", "confirmed");
}
getConnection().then((c) => (connection = c));
const TBOT_MINT = new web3_js_1.PublicKey("7zsocfctvwecd4y4rpehzhweeoftzu7rgjikfjnstbe2");
const NEUTS_MINT = new web3_js_1.PublicKey("GyekgaVcTKiAk2VLgPa1UwMx8a5PMF4ssfqfcev9pump");
const TOKEN_PROGRAM_ID = new web3_js_1.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
let hotWalletKeypair;
let TREASURY_WALLET;
try {
    if (process.env.SOLANA_PRIVATE_KEY) {
        const secret = process.env.SOLANA_PRIVATE_KEY.includes("[")
            ? Uint8Array.from(JSON.parse(process.env.SOLANA_PRIVATE_KEY))
            : bs58_1.default.decode(process.env.SOLANA_PRIVATE_KEY);
        hotWalletKeypair = web3_js_1.Keypair.fromSecretKey(secret);
        TREASURY_WALLET = hotWalletKeypair.publicKey.toString();
        console.log("🔥 Treasury Wallet:", TREASURY_WALLET);
    }
    else {
        console.warn("⚠ Missing SOLANA_PRIVATE_KEY — bridge disabled.");
    }
}
catch (e) {
    console.error("❌ Failed to load treasury wallet:", e);
}
/* -------------------------------------------------------------------------- */
/*                              WEBSOCKET SERVER                               */
/* -------------------------------------------------------------------------- */
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
let lastActiveCount = 0;
function wsBroadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach((client) => {
        if (client.readyState === 1)
            client.send(msg);
    });
}
function broadcastActiveUsers(count) {
    const delta = count - lastActiveCount;
    lastActiveCount = count;
    wsBroadcast({ type: "activeUsers", count, delta });
}
function broadcastLeaderboardUpdate() {
    wsBroadcast({ type: "leaderboardUpdate" });
}
function broadcastNewMeme(meme) {
    wsBroadcast({ type: "newMeme", meme });
}
function broadcastBattleUpdate(entryId, votes) {
    wsBroadcast({ type: "battleUpdate", entryId, votes });
}
/* -------------------------------------------------------------------------- */
/*                               ROUTE HANDLERS                               */
/* -------------------------------------------------------------------------- */
app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date() }));
/* --------------------------- Stats Handler --------------------------- */
app.get("/api/stats", async (req, res) => {
    try {
        const [memeRows] = await pool.query("SELECT COUNT(*) AS count FROM memes");
        const [nftRows] = await pool.query("SELECT COUNT(*) AS count FROM nfts");
        const [activeRows] = await pool.query("SELECT COUNT(*) AS count FROM users WHERE is_online = 1");
        res.json({
            memesForged: memeRows[0].count || 0,
            nftsMinted: nftRows[0].count || 0,
            activeUsers: activeRows[0].count || 0,
        });
    }
    catch (err) {
        console.error("Stats error:", err);
        res.json({ memesForged: 0, nftsMinted: 0, activeUsers: 0 });
    }
});
/* --------------------------- Login / Logout --------------------------- */
app.post("/api/auth/login", async (req, res) => {
    const { walletAddress } = req.body;
    if (!walletAddress)
        return res.status(400).json({ error: "Wallet required" });
    try {
        await pool.query("INSERT INTO users (wallet_address, last_login) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_login = NOW()", [walletAddress]);
        await pool.query("UPDATE users SET is_online = 1 WHERE wallet_address = ?", [walletAddress]);
        const [rows] = await pool.query("SELECT COUNT(*) AS count FROM users WHERE is_online = 1");
        broadcastActiveUsers(rows[0].count);
        res.json({ success: true });
    }
    catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "DB error" });
    }
});
app.post("/api/auth/logout", async (req, res) => {
    const { walletAddress } = req.body;
    if (!walletAddress)
        return res.status(400).json({ error: "Wallet required" });
    try {
        await pool.query("UPDATE users SET is_online = 0 WHERE wallet_address = ?", [walletAddress]);
        const [rows] = await pool.query("SELECT COUNT(*) AS count FROM users WHERE is_online = 1");
        broadcastActiveUsers(rows[0].count);
        res.json({ success: true });
    }
    catch (err) {
        console.error("Logout error:", err);
        res.status(500).json({ error: "DB error" });
    }
});
/* --------------------------- Meme Creation --------------------------- */
app.post("/api/memes", async (req, res) => {
    const { wallet, imageUrl, caption, isRegeneration } = req.body;
    if (!wallet || !imageUrl)
        return res.status(400).json({ error: "Missing fields" });
    try {
        const cost = isRegeneration ? 2.5 : 5;
        const [rows] = await pool.query("UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?", [cost, wallet, cost]);
        if (rows.affectedRows === 0) {
            return res.status(400).json({ error: "Insufficient TBOT" });
        }
        await pool.query("INSERT INTO memes (creator_wallet, image_url, caption) VALUES (?, ?, ?)", [wallet, imageUrl, caption]);
        broadcastNewMeme({ wallet, imageUrl, caption });
        broadcastLeaderboardUpdate();
        res.json({ success: true });
    }
    catch (err) {
        console.error("Meme error:", err);
        res.status(500).json({ error: "Server error" });
    }
});
/* --------------------------- AI Image Gen --------------------------- */
app.post("/api/ai/generate-image", async (req, res) => {
    const { prompt } = req.body;
    if (!prompt)
        return res.status(400).json({ error: "Prompt required" });
    try {
        const response = await ai.models.generateImages({
            model: "imagen-3.0-generate-002",
            prompt: `A funny meme about ${prompt}. High quality, digital art style.`,
            config: { numberOfImages: 1, aspectRatio: "1:1" },
        });
        const b64 = response.generatedImages?.[0]?.image?.imageBytes;
        if (!b64)
            throw new Error("No image");
        res.json({ imageUrl: `data:image/png;base64,${b64}` });
    }
    catch (err) {
        console.error("AI error:", err);
        res.status(500).json({ error: err.message });
    }
});
/* --------------------------- Chat AI --------------------------- */
app.post("/api/ai/chat", async (req, res) => {
    const { message } = req.body;
    if (!message)
        return res.status(400).json({ error: "Message required" });
    try {
        const output = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: message,
            config: {
                systemInstruction: "You are ThinkBot. Be funny, helpful, sarcastic, keep answers short.",
            },
        });
        res.json({ response: output.text });
    }
    catch (err) {
        res.status(500).json({ error: "AI error" });
    }
});
/* -------------------------- Leaderboards -------------------------- */
app.get("/api/leaderboard", async (req, res) => {
    const [rows] = await pool.query("SELECT wallet_address AS wallet, leaderboard_score AS score FROM users ORDER BY score DESC LIMIT 10");
    res.json(rows);
});
app.get("/api/heist/leaderboard", async (req, res) => {
    const [rows] = await pool.query(`SELECT player_wallet AS wallet, MAX(score) as score
         FROM heist_scores
         GROUP BY player_wallet
         ORDER BY score DESC
         LIMIT 10`);
    res.json(rows);
});
/* ------------------------ Battle Voting ------------------------- */
app.post("/api/battle/enter", async (req, res) => {
    const { wallet, memeId } = req.body;
    const cost = 5;
    const [rows] = await pool.query("UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?", [cost, wallet, cost]);
    if (rows.affectedRows === 0)
        return res.status(400).json({ error: "Insufficient funds" });
    await pool.query("INSERT INTO battle_entries (submitter_wallet, meme_id) VALUES (?, ?)", [wallet, memeId]);
    res.json({ success: true });
});
app.post("/api/battle/vote", async (req, res) => {
    const { wallet, entryId } = req.body;
    try {
        await pool.query("INSERT INTO battle_votes (voter_wallet, battle_entry_id) VALUES (?, ?)", [wallet, entryId]);
        const [rows] = await pool.query("SELECT COUNT(*) AS votes FROM battle_votes WHERE battle_entry_id = ?", [entryId]);
        const votes = rows[0].votes;
        broadcastBattleUpdate(entryId, votes);
        broadcastLeaderboardUpdate();
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ error: "Vote failed" });
    }
});
/* -------------------------------------------------------------------------- */
/*                              START THE SERVER                              */
/* -------------------------------------------------------------------------- */
server.listen(PORT, () => {
    console.log(`🚀 Server + WebSocket running on port ${PORT}`);
});
