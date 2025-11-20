import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer, getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Google GenAI
// Ensure you have run `npm install` if seeing "Cannot find module" errors
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Middleware
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}) as any);
app.use(express.json() as any);

// --- RATE LIMITER (SIMPLE IN-MEMORY) ---
const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
const rateLimitMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = (req as any).ip || 'unknown';
    const now = Date.now();
    const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
    const MAX_REQUESTS = 300; 

    const record = rateLimitMap.get(ip) || { count: 0, lastReset: now };

    if (now - record.lastReset > WINDOW_MS) {
        record.count = 0;
        record.lastReset = now;
    }

    if (record.count >= MAX_REQUESTS) {
        return (res as any).status(429).json({ error: "Too many requests, please try again later." });
    }

    record.count++;
    rateLimitMap.set(ip, record);
    next();
};
app.use(rateLimitMiddleware);

// Database Connection (MySQL)
const pool = mysql.createPool({
    uri: process.env.DATABASE_URL, 
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
});

// Test DB Connection
pool.getConnection()
    .then(conn => {
        console.log("✅ Connected to MySQL Database successfully");
        conn.release();
    })
    .catch(err => {
        console.error("❌ Failed to connect to MySQL:", err.message);
    });

// --- SOLANA CONFIGURATION ---
// Robust RPC Fallback List
const RPC_ENDPOINTS = [
    process.env.SOLANA_RPC,
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.g.alchemy.com/v2/demo',
    'https://rpc.ankr.com/solana'
].filter(Boolean) as string[];

// Helper to get a working connection
const getConnection = async (): Promise<Connection> => {
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const conn = new Connection(rpc, 'confirmed');
            // Simple ping to check health
            await conn.getSlot();
            console.log(`Connected to RPC: ${rpc}`);
            return conn;
        } catch (e) {
            console.warn(`RPC ${rpc} failed, trying next...`);
        }
    }
    console.error("All RPCs failed, defaulting to mainnet-beta");
    return new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
};

// Initialize connection holder
let connection: Connection;
getConnection().then(c => connection = c);

const TBOT_MINT = new PublicKey('7zsocfctvwecd4y4rpehzhweeoftzu7rgjikfjnstbe2'); 
const NEUTS_MINT = new PublicKey('GyekgaVcTKiAk2VLgPa1UwMx8a5PMF4ssfqfcev9pump'); 
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let hotWalletKeypair: Keypair | undefined;
let TREASURY_WALLET: string | undefined;

try {
    if (process.env.SOLANA_PRIVATE_KEY) {
        const secret = process.env.SOLANA_PRIVATE_KEY.includes('[') 
            ? Uint8Array.from(JSON.parse(process.env.SOLANA_PRIVATE_KEY)) 
            : bs58.decode(process.env.SOLANA_PRIVATE_KEY);
        hotWalletKeypair = Keypair.fromSecretKey(secret);
        TREASURY_WALLET = hotWalletKeypair.publicKey.toString();
        console.log(`✅ Treasury Wallet Loaded: ${TREASURY_WALLET}`);
    } else {
        console.warn("⚠️ Bridge features disabled: SOLANA_PRIVATE_KEY missing.");
    }
} catch (e) {
    console.error("❌ Error loading Hot Wallet:", e);
}

// --- HANDLERS ---

const healthHandler = (req: express.Request, res: any) => {
    res.json({ status: 'ok', timestamp: new Date() });
};

const statsHandler = async (req: express.Request, res: any) => {
    try {
        const [memesRes, nftsRes, usersRes] = await Promise.all([
            pool.query('SELECT COUNT(*) as count FROM memes'),
            pool.query('SELECT COUNT(*) as count FROM nfts'),
            pool.query('SELECT COUNT(*) as count FROM users')
        ]);
        
        res.json({
            memesForged: parseInt((memesRes[0] as any[])[0].count) || 0,
            nftsMinted: parseInt((nftsRes[0] as any[])[0].count) || 0,
            activeUsers: parseInt((usersRes[0] as any[])[0].count) || 0
        });
    } catch (error) {
        console.error("Stats error:", error);
        res.json({ memesForged: 0, nftsMinted: 0, activeUsers: 0 });
    }
};

const loginHandler = async (req: any, res: any) => {
    const { walletAddress } = req.body;
    if (!walletAddress) return res.status(400).json({ error: 'Wallet address required' });

    try {
        await pool.query(
            `INSERT INTO users (wallet_address, last_login) VALUES (?, NOW()) 
             ON DUPLICATE KEY UPDATE last_login = NOW()`,
            [walletAddress]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ error: 'Database error' });
    }
};

const balanceHandler = async (req: any, res: any) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "Wallet required" });

    try {
        const pubKey = new PublicKey(wallet);
        let solBalance = 0;
        let walletTbotBalance = 0;
        let walletNeutsBalance = 0;

        // 1. Fetch Real On-Chain Balances
        try {
            // Ensure connection is ready
            if (!connection) connection = await getConnection();

            const solBalanceLamports = await connection.getBalance(pubKey);
            solBalance = solBalanceLamports / 1e9;

            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubKey, {
                programId: TOKEN_PROGRAM_ID
            });

            tokenAccounts.value.forEach((accountInfo) => {
                const parsedInfo = accountInfo.account.data.parsed.info;
                const mint = parsedInfo.mint;
                const amount = parsedInfo.tokenAmount.uiAmount;

                if (mint === TBOT_MINT.toString()) {
                    walletTbotBalance = amount;
                } else if (mint === NEUTS_MINT.toString()) {
                    walletNeutsBalance = amount;
                }
            });

        } catch (chainErr) {
            console.warn("Chain fetch warning:", chainErr);
        }

        // 2. Fetch Game Tokens from DB (Off-Chain)
        const [users] = await pool.query('SELECT tbot_balance, neuts_balance FROM users WHERE wallet_address = ?', [wallet]);
        const user = (users as any[])[0];
        
        res.json({
            solBalance,
            walletTbotBalance,
            walletNeutsBalance,
            tbotBalance: user ? parseFloat(user.tbot_balance) : 0,
            neutsBalance: user ? parseFloat(user.neuts_balance) : 0
        });
    } catch (e) {
        console.error("Balance fetch error:", e);
        res.json({ solBalance: 0, walletTbotBalance: 0, walletNeutsBalance: 0, tbotBalance: 0, neutsBalance: 0 });
    }
};

const depositVerifyHandler = async (req: any, res: any) => {
    const { wallet, txHash } = req.body;
    if (!wallet || !txHash) return res.status(400).json({ error: "Missing data" });

    try {
        // Idempotency check
        const [existing] = await pool.query('SELECT id FROM deposits WHERE tx_hash = ?', [txHash]);
        if ((existing as any[]).length > 0) {
             return res.status(400).json({ error: "Transaction already processed" });
        }

        if (!connection) connection = await getConnection();

        // Fetch TX
        const tx = await connection.getParsedTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx) return res.status(400).json({ error: "Transaction not found" });
        if (tx.meta?.err) return res.status(400).json({ error: "Transaction failed on chain" });

        // Verify Receiver (Treasury) & Mint (TBOT)
        if (!TREASURY_WALLET) {
             return res.status(500).json({ error: "Treasury not configured" });
        }

        // Look for TBOT balance change for Treasury
        const preBalances = tx.meta?.preTokenBalances || [];
        const postBalances = tx.meta?.postTokenBalances || [];

        const treasuryPre = preBalances.find(b => b.owner === TREASURY_WALLET && b.mint === TBOT_MINT.toString());
        const treasuryPost = postBalances.find(b => b.owner === TREASURY_WALLET && b.mint === TBOT_MINT.toString());

        const amountPre = treasuryPre?.uiTokenAmount?.uiAmount || 0;
        const amountPost = treasuryPost?.uiTokenAmount?.uiAmount || 0;
        
        const diff = amountPost - amountPre;

        if (diff <= 0) {
             return res.status(400).json({ error: "No TBOT deposit detected for treasury" });
        }

        // Update DB
        await pool.query('INSERT INTO deposits (tx_hash, wallet, amount) VALUES (?, ?, ?)', [txHash, wallet, diff]);
        await pool.query('UPDATE users SET tbot_balance = tbot_balance + ? WHERE wallet_address = ?', [diff, wallet]);

        res.json({ success: true, added: diff });

    } catch (e: any) {
        console.error("Verify Error:", e);
        res.status(500).json({ error: e.message || "Verification failed" });
    }
};

const withdrawHandler = async (req: any, res: any) => {
    const { wallet, amount, signature, message } = req.body;
    if(!wallet || !amount || !signature || !message) return res.status(400).json({error: "Missing fields"});

    try {
         // 1. Validate Signature
         const msgBytes = new TextEncoder().encode(message);
         const sigBytes = bs58.decode(signature);
         const pubKeyBytes = new PublicKey(wallet).toBytes();
         
         if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes)) {
             return res.status(400).json({ error: "Invalid signature" });
         }

         // 2. Check DB Balance
         const [rows] = await pool.query('SELECT tbot_balance FROM users WHERE wallet_address = ?', [wallet]);
         const user = (rows as any[])[0];
         if(!user || user.tbot_balance < amount) {
             return res.status(400).json({error: "Insufficient game balance"});
         }

         if (!hotWalletKeypair) return res.status(503).json({error: "Treasury unavailable"});

         if (!connection) connection = await getConnection();

         // 3. Perform Transfer - Deduct DB first to prevent race/double spend
         await pool.query('UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ?', [amount, wallet]);

         try {
             // Get Mint Info for decimals (usually 6)
             const mintInfo = await getMint(connection, TBOT_MINT);
             const decimals = mintInfo.decimals;
             const rawAmount = BigInt(Math.floor(amount * Math.pow(10, decimals)));

             const fromTokenAccount = await getOrCreateAssociatedTokenAccount(connection, hotWalletKeypair, TBOT_MINT, hotWalletKeypair.publicKey);
             const toTokenAccount = await getOrCreateAssociatedTokenAccount(connection, hotWalletKeypair, TBOT_MINT, new PublicKey(wallet));

             await transfer(
                 connection,
                 hotWalletKeypair,
                 fromTokenAccount.address,
                 toTokenAccount.address,
                 hotWalletKeypair.publicKey,
                 rawAmount
             );
         } catch (transferErr) {
             console.error("Transfer failed, refunding DB", transferErr);
             // Refund on failure
             await pool.query('UPDATE users SET tbot_balance = tbot_balance + ? WHERE wallet_address = ?', [amount, wallet]);
             throw transferErr;
         }

         res.json({ success: true });

    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: "Withdrawal failed" });
    }
};

const createMemeHandler = async (req: any, res: any) => {
    const { wallet, imageUrl, caption, isRegeneration } = req.body;
    if(!wallet || !imageUrl) return res.status(400).json({error: "Missing data"});

    try {
        const cost = isRegeneration ? 2.5 : 5;
        
        const [result] = await pool.query(
            'UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?',
            [cost, wallet, cost]
        );

        if ((result as any).affectedRows === 0) {
            return res.status(400).json({ error: 'Insufficient TBOT balance' });
        }

        await pool.query(
            'INSERT INTO memes (creator_wallet, image_url, caption) VALUES (?, ?, ?)',
            [wallet, imageUrl, caption]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
};

const generateImageHandler = async (req: any, res: any) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    try {
        const response = await ai.models.generateImages({
            model: 'imagen-3.0-generate-002',
            prompt: `A funny meme about ${prompt}. High quality, digital art style.`,
            config: { numberOfImages: 1, aspectRatio: '1:1' },
        });

        if (!response.generatedImages?.[0]?.image?.imageBytes) {
             throw new Error("No image generated");
        }

        const base64Image = response.generatedImages[0].image.imageBytes;
        const imageUrl = `data:image/png;base64,${base64Image}`;

        res.json({ imageUrl });
    } catch (error: any) {
        console.error("AI Gen Error:", error);
        res.status(500).json({ error: error.message || 'Failed to generate image' });
    }
};

const chatHandler = async (req: any, res: any) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: message,
            config: {
                systemInstruction: "You are ThinkBot, a witty, sarcastic, and knowledgeable AI assistant for a meme platform. You love crypto, memes, and making jokes. Keep responses concise.",
            },
        });

        res.json({ response: response.text });
    } catch (error: any) {
        console.error("Chat Error:", error);
        res.status(500).json({ error: 'Failed to get response' });
    }
};

const mintHandler = async (req: any, res: any) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "Wallet required" });

    try {
        const cost = 50;
        const [result] = await pool.query(
            'UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?',
            [cost, wallet, cost]
        );

        if ((result as any).affectedRows === 0) {
            return res.status(400).json({ error: 'Insufficient TBOT balance' });
        }

        await pool.query('INSERT INTO nfts (wallet_address) VALUES (?)', [wallet]);
        await pool.query(
            'UPDATE users SET leaderboard_score = leaderboard_score + 100 WHERE wallet_address = ?',
            [wallet]
        );

        res.json({ success: true, message: "Minted successfully" });
    } catch (error) {
        res.status(500).json({ error: 'Minting failed' });
    }
};

const battleEnterHandler = async (req: any, res: any) => {
    const { wallet, memeId } = req.body;
    try {
         const cost = 5;
         const [result] = await pool.query(
            'UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?',
            [cost, wallet, cost]
        );
        if ((result as any).affectedRows === 0) return res.status(400).json({ error: 'Insufficient funds' });

        await pool.query('INSERT INTO battle_entries (submitter_wallet, meme_id) VALUES (?, ?)', [wallet, memeId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: "DB Error"}); }
};

const battleVoteHandler = async (req: any, res: any) => {
    const { wallet, entryId } = req.body;
    try {
        await pool.query('INSERT INTO battle_votes (voter_wallet, battle_entry_id) VALUES (?, ?)', [wallet, entryId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: "Vote failed"}); }
};

const heistStartHandler = async (req: any, res: any) => {
    const { wallet } = req.body;
    try {
         const cost = 0.5;
         const [result] = await pool.query(
            'UPDATE users SET tbot_balance = tbot_balance - ? WHERE wallet_address = ? AND tbot_balance >= ?',
            [cost, wallet, cost]
        );
        if ((result as any).affectedRows === 0) return res.status(400).json({ error: 'Insufficient funds' });
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: "DB Error"}); }
};

const heistScoreHandler = async (req: any, res: any) => {
    const { wallet, score } = req.body;
    try {
        await pool.query('UPDATE users SET neuts_balance = neuts_balance + ? WHERE wallet_address = ?', [score, wallet]);
        await pool.query('INSERT INTO heist_scores (player_wallet, score) VALUES (?, ?)', [wallet, score]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: "DB Error"}); }
};

const convertHandler = async (req: any, res: any) => {
    const { wallet, amountNeuts } = req.body;
    if (amountNeuts % 100 !== 0) return res.status(400).json({ error: "Must be multiple of 100" });
    
    try {
        const tbotAmount = amountNeuts / 100;
        const [result] = await pool.query(
            'UPDATE users SET neuts_balance = neuts_balance - ?, tbot_balance = tbot_balance + ? WHERE wallet_address = ? AND neuts_balance >= ?',
            [amountNeuts, tbotAmount, wallet, amountNeuts]
        );

        if ((result as any).affectedRows === 0) return res.status(400).json({ error: 'Insufficient NEUTS' });
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: "Conversion failed"}); }
};

const leaderboardHandler = async (req: any, res: any) => {
    try {
        const [rows] = await pool.query(
            'SELECT wallet_address as wallet, leaderboard_score as score FROM users ORDER BY leaderboard_score DESC LIMIT 10'
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
};

const heistLeaderboardHandler = async (req: any, res: any) => {
    try {
        const [rows] = await pool.query(
            `SELECT player_wallet as wallet, MAX(score) as score 
             FROM heist_scores 
             GROUP BY player_wallet 
             ORDER BY score DESC 
             LIMIT 10`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch heist leaderboard' });
    }
};

// --- ROUTES ---
app.get('/api/health', healthHandler);
app.get('/api/stats', statsHandler);
app.get('/api/leaderboard', leaderboardHandler);
app.get('/api/heist/leaderboard', heistLeaderboardHandler);
app.post('/api/auth/login', loginHandler);
app.post('/api/balance', balanceHandler);
app.post('/api/memes', createMemeHandler);
app.post('/api/ai/generate-image', generateImageHandler);
app.post('/api/ai/chat', chatHandler);
app.post('/api/mint', mintHandler);
app.post('/api/battle/enter', battleEnterHandler);
app.post('/api/battle/vote', battleVoteHandler);
app.post('/api/heist/start', heistStartHandler);
app.post('/api/heist/score', heistScoreHandler);
app.post('/api/convert', convertHandler);
app.post('/api/deposit/verify', depositVerifyHandler);
app.post('/api/withdraw', withdrawHandler);

app.get('/stats', statsHandler);
app.get('/health', healthHandler);

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});