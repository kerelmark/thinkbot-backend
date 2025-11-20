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
const spl_token_1 = require("@solana/spl-token");
const bs58_1 = __importDefault(require("bs58"));
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const genai_1 = require("@google/genai");
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// Google GenAI Client
const ai = new genai_1.GoogleGenAI({ apiKey: process.env.API_KEY });
// Middlewares
app.use((0, cors_1.default)({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express_1.default.json());
// Simple Rate Limiter
const rateLimitMap = new Map();
app.use((req, res, next) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const WINDOW = 15 * 60 * 1000;
    const LIMIT = 300;
    const record = rateLimitMap.get(ip) || {
        count: 0,
        lastReset: now,
    };
    if (now - record.lastReset > WINDOW) {
        record.count = 0;
        record.lastReset = now;
    }
    if (record.count >= LIMIT) {
        return res.status(429).json({
            error: "Too many requests, slow down.",
        });
    }
    record.count++;
    rateLimitMap.set(ip, record);
    next();
});
// MySQL
const pool = promise_1.default.createPool({
    uri: process.env.DATABASE_URL,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
});
// Test DB
pool
    .getConnection()
    .then((c) => {
    console.log("✅ MySQL OK");
    c.release();
})
    .catch((e) => {
    console.error("❌ DB error", e.message);
});
// RPC Fallbacks
const RPC_ENDPOINTS = [
    process.env.SOLANA_RPC,
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/solana",
].filter(Boolean);
const getConnection = async () => {
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const conn = new web3_js_1.Connection(rpc, "confirmed");
            await conn.getSlot();
            console.log("Connected RPC:", rpc);
            return conn;
        }
        catch (_) { }
    }
    return new web3_js_1.Connection("https://api.mainnet-beta.solana.com", "confirmed");
};
let connection;
getConnection().then((c) => (connection = c));
const TBOT_MINT = new web3_js_1.PublicKey("7zsocfctvwecd4y4rpehzhweeoftzu7rgjikfjnstbe2");
const NEUTS_MINT = new web3_js_1.PublicKey("GyekgaVcTKiAk2VLgPa1UwMx8a5PMF4ssfqfcev9pump");
const TOKEN_PROGRAM_ID = new web3_js_1.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
// Hot Wallet
let hotWalletKeypair = null;
let TREASURY_WALLET = null;
if (process.env.SOLANA_PRIVATE_KEY) {
    const secret = process.env.SOLANA_PRIVATE_KEY.includes("[")
        ? Uint8Array.from(JSON.parse(process.env.SOLANA_PRIVATE_KEY))
        : bs58_1.default.decode(process.env.SOLANA_PRIVATE_KEY);
    hotWalletKeypair = web3_js_1.Keypair.fromSecretKey(secret);
    TREASURY_WALLET = hotWalletKeypair.publicKey.toString();
    console.log("🔥 Treasury Wallet:", TREASURY_WALLET);
}
else {
    console.log("⚠️ No private key — bridge withdrawals disabled");
}
// -----------------------------
// ACTIVE USER FIX (NEW SYSTEM)
// -----------------------------
async function setUserOnline(wallet) {
    await pool.query(`
    INSERT INTO active_users (wallet_address)
    VALUES (?)
    ON DUPLICATE KEY UPDATE last_active = NOW()
  `, [wallet]);
    updateActiveUserBroadcast();
}
async function setUserOffline(wallet) {
    await pool.query(`DELETE FROM active_users WHERE wallet_address = ?`, [wallet]);
    updateActiveUserBroadcast();
}
let lastActiveCount = 0;
async function updateActiveUserBroadcast() {
    const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM active_users`);
    const count = rows[0].count;
    const delta = count - lastActiveCount;
    lastActiveCount = count;
    const msg = JSON.stringify({
        type: "activeUsers",
        count,
        delta,
    });
    wss.clients.forEach((client) => {
        if (client.readyState === 1)
            client.send(msg);
    });
    console.log("📡 Active Users:", count, "Δ", delta);
}
// ------------------------------------------------------
//                  API HANDLERS
// ------------------------------------------------------
const healthHandler = (req, res) => {
    res.json({ status: "ok", time: new Date() });
};
const statsHandler = async (req, res) => {
    try {
        const [[memes]] = await pool.query("SELECT COUNT(*) AS count FROM memes");
        const [[nfts]] = await pool.query("SELECT COUNT(*) AS count FROM nfts");
        const [[active]] = await pool.query("SELECT COUNT(*) AS count FROM active_users");
        res.json({
            memesForged: memes.count,
            nftsMinted: nfts.count,
            activeUsers: active.count,
        });
    }
    catch (e) {
        res.json({ memesForged: 0, nftsMinted: 0, activeUsers: 0 });
    }
};
// ---------------- AUTH -----------------
const loginHandler = async (req, res) => {
    const { walletAddress } = req.body;
    if (!walletAddress)
        return res.status(400).json({ error: "Wallet required" });
    try {
        await pool.query(`
      INSERT INTO users (wallet_address, last_login)
      VALUES (?, NOW())
      ON DUPLICATE KEY UPDATE last_login = NOW()
    `, [walletAddress]);
        await setUserOnline(walletAddress);
        res.json({ success: true });
    }
    catch (e) {
        console.error("Login error:", e);
        res.status(500).json({ error: "DB error" });
    }
};
const logoutHandler = async (req, res) => {
    const { walletAddress } = req.body;
    if (!walletAddress)
        return res.status(400).json({ error: "Wallet required" });
    try {
        await setUserOffline(walletAddress);
        res.json({ success: true });
    }
    catch (e) {
        console.error("Logout error:", e);
        res.status(500).json({ error: "DB error" });
    }
};
// ---------------- BALANCE -----------------
const balanceHandler = async (req, res) => {
    const { wallet } = req.body;
    if (!wallet)
        return res.status(400).json({ error: "Wallet required" });
    try {
        const pk = new web3_js_1.PublicKey(wallet);
        let solBalance = 0;
        let walletTbotBalance = 0;
        let walletNeutsBalance = 0;
        try {
            if (!connection)
                connection = await getConnection();
            solBalance = (await connection.getBalance(pk)) / 1e9;
            const accounts = await connection.getParsedTokenAccountsByOwner(pk, {
                programId: TOKEN_PROGRAM_ID,
            });
            for (const acc of accounts.value) {
                const info = acc.account.data.parsed.info;
                const mint = info.mint;
                const amount = info.tokenAmount.uiAmount;
                if (mint === TBOT_MINT.toString())
                    walletTbotBalance = amount;
                if (mint === NEUTS_MINT.toString())
                    walletNeutsBalance = amount;
            }
        }
        catch (_) { }
        const [rows] = await pool.query("SELECT tbot_balance, neuts_balance FROM users WHERE wallet_address = ?", [wallet]);
        const row = rows[0] || {
            tbot_balance: 0,
            neuts_balance: 0,
        };
        res.json({
            solBalance,
            walletTbotBalance,
            walletNeutsBalance,
            tbotBalance: parseFloat(row.tbot_balance),
            neutsBalance: parseFloat(row.neuts_balance),
        });
    }
    catch (e) {
        res.json({
            solBalance: 0,
            walletTbotBalance: 0,
            walletNeutsBalance: 0,
            tbotBalance: 0,
            neutsBalance: 0,
        });
    }
};
// ---------------- DEPOSIT VERIFY -----------------
const depositVerifyHandler = async (req, res) => {
    const { wallet, txHash } = req.body;
    if (!wallet || !txHash)
        return res.status(400).json({ error: "Missing fields" });
    try {
        const [existing] = await pool.query("SELECT id FROM deposits WHERE tx_hash = ?", [txHash]);
        if (existing.length > 0)
            return res.status(400).json({ error: "Already processed" });
        if (!connection)
            connection = await getConnection();
        const tx = await connection.getParsedTransaction(txHash, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        if (!tx)
            return res.status(400).json({ error: "TX not found" });
        if (tx.meta?.err)
            return res.status(400).json({ error: "TX failed" });
        if (!TREASURY_WALLET)
            return res.status(500).json({ error: "Treasury missing" });
        const pre = tx.meta?.preTokenBalances || [];
        const post = tx.meta?.postTokenBalances || [];
        const treasuryPre = pre.find((b) => b.owner === TREASURY_WALLET &&
            b.mint === TBOT_MINT.toString());
        const treasuryPost = post.find((b) => b.owner === TREASURY_WALLET &&
            b.mint === TBOT_MINT.toString());
        const before = treasuryPre?.uiTokenAmount?.uiAmount || 0;
        const after = treasuryPost?.uiTokenAmount?.uiAmount || 0;
        const diff = after - before;
        if (diff <= 0)
            return res.status(400).json({ error: "No deposit detected" });
        await pool.query("INSERT INTO deposits (tx_hash, wallet, amount) VALUES (?, ?, ?)", [txHash, wallet, diff]);
        await pool.query("UPDATE users SET tbot_balance = tbot_balance + ? WHERE wallet_address = ?", [diff, wallet]);
        res.json({ success: true, added: diff });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
};
// ---------------- WITHDRAW -----------------
const withdrawHandler = async (req, res) => {
    const { wallet, amount, signature, message } = req.body;
    if (!wallet || !amount || !signature || !message)
        return res.status(400).json({ error: "Missing fields" });
    try {
        const msgBytes = new TextEncoder().encode(message);
        const sigBytes = bs58_1.default.decode(signature);
        const pubBytes = new web3_js_1.PublicKey(wallet).toBytes();
        if (!tweetnacl_1.default.sign.detached.verify(msgBytes, sigBytes, pubBytes))
            return res.status(400).json({ error: "Invalid signature" });
        const [rows] = await pool.query("SELECT tbot_balance FROM users WHERE wallet_address = ?", [wallet]);
        const user = rows[0];
        if (!user || user.tbot_balance < amount)
            return res.status(400).json({ error: "Insufficient balance" });
        if (!hotWalletKeypair)
            return res.status(503).json({ error: "Treasury unavailable" });
        if (!connection)
            connection = await getConnection();
        await pool.query("UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ?", [amount, wallet]);
        try {
            const mintInfo = await (0, spl_token_1.getMint)(connection, TBOT_MINT);
            const raw = BigInt(Math.floor(amount * 10 ** mintInfo.decimals));
            const fromAcc = await (0, spl_token_1.getOrCreateAssociatedTokenAccount)(connection, hotWalletKeypair, TBOT_MINT, hotWalletKeypair.publicKey);
            const toAcc = await (0, spl_token_1.getOrCreateAssociatedTokenAccount)(connection, hotWalletKeypair, TBOT_MINT, new web3_js_1.PublicKey(wallet));
            await (0, spl_token_1.transfer)(connection, hotWalletKeypair, fromAcc.address, toAcc.address, hotWalletKeypair.publicKey, raw);
        }
        catch (err) {
            await pool.query("UPDATE users SET tbot_balance = tbot_balance + ? WHERE wallet_address = ?", [amount, wallet]);
            throw err;
        }
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: "Withdraw failed" });
    }
};
// ---------------- MEMES -----------------
const createMemeHandler = async (req, res) => {
    const { wallet, imageUrl, caption, isRegeneration } = req.body;
    if (!wallet || !imageUrl)
        return res.status(400).json({ error: "Missing fields" });
    try {
        const cost = isRegeneration ? 2.5 : 5;
        const [result] = await pool.query(`
      UPDATE users 
      SET tbot_balance = tbot_balance - ? 
      WHERE wallet_address = ? AND tbot_balance >= ?
    `, [cost, wallet, cost]);
        if (result.affectedRows === 0)
            return res
                .status(400)
                .json({ error: "Insufficient TBOT balance" });
        await pool.query("INSERT INTO memes (creator_wallet, image_url, caption) VALUES (?, ?, ?)", [wallet, imageUrl, caption]);
        broadcastNewMeme({ wallet, imageUrl, caption });
        broadcastLeaderboardUpdate();
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: "Server error" });
    }
};
// ---------------- AI ENDPOINTS -----------------
const generateImageHandler = async (req, res) => {
    const { prompt } = req.body;
    if (!prompt)
        return res.status(400).json({ error: "Prompt required" });
    try {
        const response = await ai.models.generateImages({
            model: "imagen-3.0-generate-002",
            prompt: `A funny meme about ${prompt}. High quality digital art.`,
            config: { numberOfImages: 1, aspectRatio: "1:1" },
        });
        const bytes = response.generatedImages?.[0]?.image?.imageBytes;
        if (!bytes)
            throw new Error("No image generated");
        res.json({ imageUrl: `data:image/png;base64,${bytes}` });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
};
const chatHandler = async (req, res) => {
    const { message } = req.body;
    if (!message)
        return res.status(400).json({ error: "Message required" });
    try {
        const reply = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: message,
            config: {
                systemInstruction: "You are ThinkBot, witty sarcastic crypto meme AI.",
            },
        });
        res.json({ response: reply.text });
    }
    catch (e) {
        res.status(500).json({ error: "AI failed" });
    }
};
// ---------------- BATTLE -----------------
const battleEnterHandler = async (req, res) => {
    const { wallet, memeId } = req.body;
    try {
        const cost = 5;
        const [result] = await pool.query(`
      UPDATE users 
      SET tbot_balance = tbot_balance - ?
      WHERE wallet_address = ? AND tbot_balance >= ?
    `, [cost, wallet, cost]);
        if (result.affectedRows === 0)
            return res.status(400).json({ error: "Insufficient funds" });
        await pool.query("INSERT INTO battle_entries (submitter_wallet, meme_id) VALUES (?, ?)", [wallet, memeId]);
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: "DB error" });
    }
};
const battleVoteHandler = async (req, res) => {
    const { wallet, entryId } = req.body;
    try {
        await pool.query("INSERT INTO battle_votes (voter_wallet, battle_entry_id) VALUES (?, ?)", [wallet, entryId]);
        const [[{ votes }]] = await pool.query("SELECT COUNT(*) AS votes FROM battle_votes WHERE battle_entry_id = ?", [entryId]);
        broadcastBattleUpdate(entryId, votes);
        broadcastLeaderboardUpdate();
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: "Vote failed" });
    }
};
// ---------------- HEIST -----------------
const heistStartHandler = async (req, res) => {
    const { wallet } = req.body;
    try {
        const cost = 0.5;
        const [result] = await pool.query(`
      UPDATE users 
      SET tbot_balance = tbot_balance - ?
      WHERE wallet_address = ? AND tbot_balance >= ?
    `, [cost, wallet, cost]);
        if (result.affectedRows === 0)
            return res.status(400).json({ error: "Insufficient funds" });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: "Heist error" });
    }
};
const heistScoreHandler = async (req, res) => {
    const { wallet, score } = req.body;
    try {
        await pool.query("UPDATE users SET neuts_balance = neuts_balance + ? WHERE wallet_address = ?", [score, wallet]);
        await pool.query("INSERT INTO heist_scores (player_wallet, score) VALUES (?, ?)", [wallet, score]);
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: "Score error" });
    }
};
// ---------------- CONVERT -----------------
const convertHandler = async (req, res) => {
    const { wallet, amountNeuts } = req.body;
    if (amountNeuts % 100 !== 0)
        return res.status(400).json({ error: "Must be multiple of 100" });
    try {
        const tbot = amountNeuts / 100;
        const [result] = await pool.query(`
      UPDATE users 
      SET neuts_balance = neuts_balance - ?, 
          tbot_balance = tbot_balance + ?
      WHERE wallet_address = ? AND neuts_balance >= ?
    `, [amountNeuts, tbot, wallet, amountNeuts]);
        if (result.affectedRows === 0)
            return res.status(400).json({ error: "Insufficient NEUTS" });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: "Conversion failed" });
    }
};
// ---------------- LEADERBOARDS -----------------
const leaderboardHandler = async (req, res) => {
    try {
        const [rows] = await pool.query(`
      SELECT wallet_address AS wallet, leaderboard_score AS score 
      FROM users 
      ORDER BY leaderboard_score DESC 
      LIMIT 10
    `);
        res.json(rows);
    }
    catch (e) {
        res.status(500).json({ error: "Leaderboard error" });
    }
};
const heistLeaderboardHandler = async (req, res) => {
    try {
        const [rows] = await pool.query(`
      SELECT player_wallet AS wallet, MAX(score) AS score
      FROM heist_scores
      GROUP BY player_wallet
      ORDER BY score DESC
      LIMIT 10
    `);
        res.json(rows);
    }
    catch (e) {
        res.status(500).json({ error: "Heist leaderboard error" });
    }
};
const mintHandler = async (req, res) => {
    const { wallet } = req.body;
    if (!wallet)
        return res.status(400).json({ error: "Wallet required" });
    try {
        const cost = 50;
        const [result] = await pool.query('UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?', [cost, wallet, cost]);
        if (result.affectedRows === 0) {
            return res.status(400).json({ error: 'Insufficient TBOT balance' });
        }
        await pool.query('INSERT INTO nfts (wallet_address) VALUES (?)', [wallet]);
        await pool.query('UPDATE users SET leaderboard_score = leaderboard_score + 100 WHERE wallet_address = ?', [wallet]);
        // broadcast update
        broadcastLeaderboardUpdate();
        res.json({ success: true, message: "Minted successfully" });
    }
    catch (error) {
        res.status(500).json({ error: 'Minting failed' });
    }
};
// ------------------------------------------------------
//                    ROUTES
// ------------------------------------------------------
app.get("/api/health", healthHandler);
app.get("/api/stats", statsHandler);
app.post("/api/auth/login", loginHandler);
app.post("/api/auth/logout", logoutHandler);
app.post("/api/balance", balanceHandler);
app.post("/api/memes", createMemeHandler);
app.post("/api/ai/generate-image", generateImageHandler);
app.post("/api/ai/chat", chatHandler);
app.post("/api/mint", mintHandler);
app.post("/api/battle/enter", battleEnterHandler);
app.post("/api/battle/vote", battleVoteHandler);
app.post("/api/heist/start", heistStartHandler);
app.post("/api/heist/score", heistScoreHandler);
app.post("/api/convert", convertHandler);
app.post("/api/deposit/verify", depositVerifyHandler);
app.post("/api/withdraw", withdrawHandler);
app.get("/api/leaderboard", leaderboardHandler);
app.get("/api/heist/leaderboard", heistLeaderboardHandler);
// ------------------------------------------------------
//                    WEBSOCKETS
// ------------------------------------------------------
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
// --- Broadcast Helpers ---
function broadcastLeaderboardUpdate() {
    const msg = JSON.stringify({ type: "leaderboardUpdate" });
    wss.clients.forEach((c) => {
        if (c.readyState === 1)
            c.send(msg);
    });
}
function broadcastNewMeme(meme) {
    const msg = JSON.stringify({ type: "newMeme", meme });
    wss.clients.forEach((c) => {
        if (c.readyState === 1)
            c.send(msg);
    });
}
function broadcastBattleUpdate(entryId, votes) {
    const msg = JSON.stringify({
        type: "battleUpdate",
        entryId,
        votes,
    });
    wss.clients.forEach((c) => {
        if (c.readyState === 1)
            c.send(msg);
    });
}
console.log("🔥 WebSocket Broadcast System Ready");
// ------------------------------------------------------
//                    START SERVER
// ------------------------------------------------------
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
