import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
    getOrCreateAssociatedTokenAccount,
    transfer,
    getMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { GoogleGenAI } from "@google/genai";
import http from "http";
import { WebSocketServer } from "ws";

dotenv.config();

/* -------------------------------------------------------------------------- */
/*                                EXPRESS SETUP                               */
/* -------------------------------------------------------------------------- */

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
    cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    }) as any
);
app.use(express.json());

/* -------------------------------------------------------------------------- */
/*                             GOOGLE GEN AI CLIENT                            */
/* -------------------------------------------------------------------------- */

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/* -------------------------------------------------------------------------- */
/*                                RATE LIMITER                                */
/* -------------------------------------------------------------------------- */

const rateLimitMap = new Map<
    string,
    { count: number; lastReset: number }
>();

const rateLimitMiddleware = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    const ip = (req as any).ip || "unknown";
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

const pool = mysql.createPool({
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
].filter(Boolean) as string[];

let connection: Connection;

async function getConnection(): Promise<Connection> {
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const conn = new Connection(rpc, "confirmed");
            await conn.getSlot();
            console.log(`Connected to RPC: ${rpc}`);
            return conn;
        } catch {
            console.warn(`RPC failed: ${rpc}`);
        }
    }
    return new Connection("https://api.mainnet-beta.solana.com", "confirmed");
}

getConnection().then((c) => (connection = c));

const TBOT_MINT = new PublicKey(
    "7zsocfctvwecd4y4rpehzhweeoftzu7rgjikfjnstbe2"
);
const NEUTS_MINT = new PublicKey(
    "GyekgaVcTKiAk2VLgPa1UwMx8a5PMF4ssfqfcev9pump"
);
const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

let hotWalletKeypair: Keypair | undefined;
let TREASURY_WALLET: string | undefined;

try {
    if (process.env.SOLANA_PRIVATE_KEY) {
        const secret = process.env.SOLANA_PRIVATE_KEY.includes("[")
            ? Uint8Array.from(JSON.parse(process.env.SOLANA_PRIVATE_KEY))
            : bs58.decode(process.env.SOLANA_PRIVATE_KEY);
        hotWalletKeypair = Keypair.fromSecretKey(secret);
        TREASURY_WALLET = hotWalletKeypair.publicKey.toString();
        console.log("🔥 Treasury Wallet:", TREASURY_WALLET);
    } else {
        console.warn("⚠ Missing SOLANA_PRIVATE_KEY — bridge disabled.");
    }
} catch (e) {
    console.error("❌ Failed to load treasury wallet:", e);
}

/* -------------------------------------------------------------------------- */
/*                              WEBSOCKET SERVER                               */
/* -------------------------------------------------------------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let lastActiveCount = 0;

function wsBroadcast(obj: any) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach((client: any) => {
        if (client.readyState === 1) client.send(msg);
    });
}

function broadcastActiveUsers(count: number) {
    const delta = count - lastActiveCount;
    lastActiveCount = count;

    wsBroadcast({ type: "activeUsers", count, delta });
}

function broadcastLeaderboardUpdate() {
    wsBroadcast({ type: "leaderboardUpdate" });
}

function broadcastNewMeme(meme: any) {
    wsBroadcast({ type: "newMeme", meme });
}

function broadcastBattleUpdate(entryId: string, votes: number) {
    wsBroadcast({ type: "battleUpdate", entryId, votes });
}

/* -------------------------------------------------------------------------- */
/*                               ROUTE HANDLERS                               */
/* -------------------------------------------------------------------------- */

app.get("/api/health", (req, res) =>
    res.json({ status: "ok", time: new Date() })
);

/* --------------------------- Stats Handler --------------------------- */

app.get("/api/stats", async (req, res) => {
    try {
        const [memeRows] = await pool.query(
            "SELECT COUNT(*) AS count FROM memes"
        );
        const [nftRows] = await pool.query(
            "SELECT COUNT(*) AS count FROM nfts"
        );
        const [activeRows] = await pool.query(
            "SELECT COUNT(*) AS count FROM users WHERE is_online = 1"
        );

        res.json({
            memesForged: (memeRows as any)[0].count || 0,
            nftsMinted: (nftRows as any)[0].count || 0,
            activeUsers: (activeRows as any)[0].count || 0,
        });
    } catch (err) {
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
        await pool.query(
            "INSERT INTO users (wallet_address, last_login) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_login = NOW()",
            [walletAddress]
        );

        await pool.query(
            "UPDATE users SET is_online = 1 WHERE wallet_address = ?",
            [walletAddress]
        );

        const [rows] = await pool.query(
            "SELECT COUNT(*) AS count FROM users WHERE is_online = 1"
        );
        broadcastActiveUsers((rows as any)[0].count);

        res.json({ success: true });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "DB error" });
    }
});

app.post("/api/auth/logout", async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress)
        return res.status(400).json({ error: "Wallet required" });

    try {
        await pool.query(
            "UPDATE users SET is_online = 0 WHERE wallet_address = ?",
            [walletAddress]
        );

        const [rows] = await pool.query(
            "SELECT COUNT(*) AS count FROM users WHERE is_online = 1"
        );
        broadcastActiveUsers((rows as any)[0].count);

        res.json({ success: true });
    } catch (err) {
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

        const [rows] = await pool.query(
            "UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?",
            [cost, wallet, cost]
        );

        if ((rows as any).affectedRows === 0) {
            return res.status(400).json({ error: "Insufficient TBOT" });
        }

        await pool.query(
            "INSERT INTO memes (creator_wallet, image_url, caption) VALUES (?, ?, ?)",
            [wallet, imageUrl, caption]
        );

        broadcastNewMeme({ wallet, imageUrl, caption });
        broadcastLeaderboardUpdate();

        res.json({ success: true });
    } catch (err) {
        console.error("Meme error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* --------------------------- AI Image Gen --------------------------- */

app.post("/api/ai/generate-image", async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    try {
        const response = await ai.models.generateImages({
            model: "imagen-3.0-generate-002",
            prompt: `A funny meme about ${prompt}. High quality, digital art style.`,
            config: { numberOfImages: 1, aspectRatio: "1:1" },
        });

        const b64 =
            response.generatedImages?.[0]?.image?.imageBytes;

        if (!b64) throw new Error("No image");

        res.json({ imageUrl: `data:image/png;base64,${b64}` });
    } catch (err: any) {
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
                systemInstruction:
                    "You are ThinkBot. Be funny, helpful, sarcastic, keep answers short.",
            },
        });

        res.json({ response: output.text });
    } catch (err) {
        res.status(500).json({ error: "AI error" });
    }
});

/* -------------------------- Leaderboards -------------------------- */

app.get("/api/leaderboard", async (req, res) => {
    const [rows] = await pool.query(
        "SELECT wallet_address AS wallet, leaderboard_score AS score FROM users ORDER BY score DESC LIMIT 10"
    );
    res.json(rows);
});

app.get("/api/heist/leaderboard", async (req, res) => {
    const [rows] = await pool.query(
        `SELECT player_wallet AS wallet, MAX(score) as score
         FROM heist_scores
         GROUP BY player_wallet
         ORDER BY score DESC
         LIMIT 10`
    );
    res.json(rows);
});

/* ------------------------ Battle Voting ------------------------- */

app.post("/api/battle/enter", async (req, res) => {
    const { wallet, memeId } = req.body;

    const cost = 5;

    const [rows] = await pool.query(
        "UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?",
        [cost, wallet, cost]
    );

    if ((rows as any).affectedRows === 0)
        return res.status(400).json({ error: "Insufficient funds" });

    await pool.query(
        "INSERT INTO battle_entries (submitter_wallet, meme_id) VALUES (?, ?)",
        [wallet, memeId]
    );

    res.json({ success: true });
});

app.post("/api/battle/vote", async (req, res) => {
    const { wallet, entryId } = req.body;

    try {
        await pool.query(
            "INSERT INTO battle_votes (voter_wallet, battle_entry_id) VALUES (?, ?)",
            [wallet, entryId]
        );

        const [rows] = await pool.query(
            "SELECT COUNT(*) AS votes FROM battle_votes WHERE battle_entry_id = ?",
            [entryId]
        );

        const votes = (rows as any)[0].votes;
        broadcastBattleUpdate(entryId, votes);
        broadcastLeaderboardUpdate();

        res.json({ success: true });
    } catch {
        res.status(500).json({ error: "Vote failed" });
    }
});

/* -------------------------------------------------------------------------- */
/*                              START THE SERVER                              */
/* -------------------------------------------------------------------------- */

server.listen(PORT, () => {
    console.log(`🚀 Server + WebSocket running on port ${PORT}`);
});
