const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');

/**
 * FIREBASE ADMIN INITIALIZATION
 * Ensure GOOGLE_APPLICATION_CREDENTIALS env var is set or provide serviceAccountKey.json
 */
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
}

const db = admin.firestore();
const auth = admin.auth();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'TEST'; // TEST or PRODUCTION
const CF_URL = CASHFREE_ENV === 'PRODUCTION' 
    ? 'https://api.cashfree.com/pg' 
    : 'https://sandbox.cashfree.com/pg';

// --- MIDDLEWARE: AUTHENTICATION ---
const verifyToken = async (req, res, next) => {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.uid = decodedToken.uid;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// --- AUTH ENDPOINTS ---

app.post('/auth/signup', verifyToken, async (req, res) => {
    const { username, email, referralCode } = req.body;
    const userRef = db.collection('users').doc(req.uid);

    try {
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (userDoc.exists) return;

            let referredBy = null;
            if (referralCode) {
                const rQuery = await db.collection('users').where('referralCode', '==', referralCode).limit(1).get();
                if (!rQuery.empty) referredBy = rQuery.docs[0].id;
            }

            const newReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();

            t.set(userRef, {
                username,
                email,
                wallet: 0,
                totalXP: 0,
                joinedMatches: [],
                referralCode: newReferralCode,
                referredBy,
                matchesPlayed: 0,
                totalKills: 0,
                dailyStreak: 0,
                lastDailyReward: null,
                isVIP: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- MATCH ENDPOINTS ---

app.post('/match/join', verifyToken, async (req, res) => {
    const { matchId, gameUids } = req.body; // gameUids array: size 1, 2, or 4
    if (!Array.isArray(gameUids) || ![1, 2, 4].includes(gameUids.length)) {
        return res.status(400).json({ error: 'Invalid team size' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    const userRef = db.collection('users').doc(req.uid);
    const teamRef = matchRef.collection('teams').doc(req.uid);

    try {
        const result = await db.runTransaction(async (t) => {
            const mDoc = await t.get(matchRef);
            const uDoc = await t.get(userRef);

            if (!mDoc.exists) throw new Error('Match not found');
            const match = mDoc.data();

            if (match.status !== 'upcoming') throw new Error('Match is no longer upcoming');
            if (match.joinedCount + gameUids.length > match.maxPlayers) throw new Error('Match is full');
            if (uDoc.data().wallet < match.entryFee) throw new Error('Insufficient wallet balance');
            
            // Check if user already joined
            const existingTeam = await t.get(teamRef);
            if (existingTeam.exists) throw new Error('User already joined this match');

            // Check if any gameUid is already taken in this match
            const teamsSnapshot = await t.get(matchRef.collection('teams'));
            teamsSnapshot.forEach(doc => {
                const data = doc.data();
                gameUids.forEach(id => {
                    if (data.gameUids.includes(id)) throw new Error(`Game UID ${id} already registered`);
                });
            });

            // Deduct Fee
            t.update(userRef, {
                wallet: admin.firestore.FieldValue.increment(-match.entryFee),
                joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
            });

            // Create Team
            t.set(teamRef, {
                ownerUid: req.uid,
                ownerUsername: uDoc.data().username,
                gameUids: gameUids,
                joinedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Update Match Count
            t.update(matchRef, {
                joinedCount: admin.firestore.FieldValue.increment(gameUids.length)
            });

            // Log Transaction
            const transRef = db.collection('transactions').doc();
            t.set(transRef, {
                userId: req.uid,
                type: 'MATCH_JOIN',
                amount: match.entryFee,
                status: 'SUCCESS',
                matchId: matchId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return { success: true };
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// --- REWARDS ---

app.post('/rewards/daily', verifyToken, async (req, res) => {
    const userRef = db.collection('users').doc(req.uid);
    const REWARD_AMOUNT = 5;

    try {
        await db.runTransaction(async (t) => {
            const uDoc = await t.get(userRef);
            const data = uDoc.data();
            const now = new Date();
            const lastReward = data.lastDailyReward?.toDate();

            if (lastReward && (now - lastReward < 24 * 60 * 60 * 1000)) {
                throw new Error('Reward already claimed in last 24h');
            }

            t.update(userRef, {
                wallet: admin.firestore.FieldValue.increment(REWARD_AMOUNT),
                dailyStreak: admin.firestore.FieldValue.increment(1),
                lastDailyReward: admin.firestore.FieldValue.serverTimestamp()
            });

            const transRef = db.collection('transactions').doc();
            t.set(transRef, {
                userId: req.uid,
                type: 'DAILY_REWARD',
                amount: REWARD_AMOUNT,
                status: 'SUCCESS',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// --- WALLET & CASHFREE ---

app.post('/wallet/createOrder', verifyToken, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Invalid amount' });

    const orderId = `ORDER_${Date.now()}_${req.uid}`;

    try {
        const response = await axios.post(`${CF_URL}/orders`, {
            order_id: orderId,
            order_amount: amount,
            order_currency: "INR",
            customer_details: {
                customer_id: req.uid,
                customer_email: "user@example.com", // Fetch real email from userDoc in production
                customer_phone: "9999999999"
            }
        }, {
            headers: {
                'x-client-id': CASHFREE_APP_ID,
                'x-client-secret': CASHFREE_SECRET_KEY,
                'x-api-version': '2022-09-01'
            }
        });

        await db.collection('transactions').doc(orderId).set({
            userId: req.uid,
            type: 'WALLET_TOPUP',
            amount: amount,
            status: 'PENDING',
            orderId: orderId,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

app.post('/webhook/cashfree', async (req, res) => {
    const signature = req.headers['x-webhook-signature'];
    const rawBody = JSON.stringify(req.body);

    // Verify Signature (Pseudocode/Simplified - Check Cashfree SDK for exact logic)
    const expectedSignature = crypto
        .createHmac('sha256', CASHFREE_SECRET_KEY)
        .update(rawBody)
        .digest('base64');

    // In production, use the actual verification logic provided by Cashfree
    const { data } = req.body;
    const orderId = data.order.order_id;
    const amount = data.order.order_amount;
    const paymentStatus = data.payment.payment_status;

    const transRef = db.collection('transactions').doc(orderId);

    try {
        await db.runTransaction(async (t) => {
            const tDoc = await t.get(transRef);
            if (!tDoc.exists) throw new Error('Order not found');
            if (tDoc.data().status !== 'PENDING') return; // Idempotency check

            if (paymentStatus === 'SUCCESS') {
                const userRef = db.collection('users').doc(tDoc.data().userId);
                t.update(userRef, {
                    wallet: admin.firestore.FieldValue.increment(amount)
                });
                t.update(transRef, { status: 'SUCCESS' });
            } else {
                t.update(transRef, { status: 'FAILED' });
            }
        });
        res.status(200).send('OK');
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.post('/wallet/withdraw', verifyToken, async (req, res) => {
    const { amount, upiId } = req.body;
    const userRef = db.collection('users').doc(req.uid);

    try {
        await db.runTransaction(async (t) => {
            const uDoc = await t.get(userRef);
            if (uDoc.data().wallet < amount) throw new Error('Insufficient balance');

            t.update(userRef, {
                wallet: admin.firestore.FieldValue.increment(-amount)
            });

            const transRef = db.collection('transactions').doc();
            t.set(transRef, {
                userId: req.uid,
                type: 'WITHDRAWAL',
                amount: amount,
                upiId: upiId,
                status: 'PENDING',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// --- ADMIN ENDPOINTS ---

app.post('/admin/match/distribute', async (req, res) => {
    // Note: Secure this endpoint with Admin check middleware in production
    const { matchId, gameUid, rank, kills } = req.body;

    const matchRef = db.collection('matches').doc(matchId);

    try {
        const result = await db.runTransaction(async (t) => {
            const mDoc = await t.get(matchRef);
            if (!mDoc.exists) throw new Error('Match not found');
            const match = mDoc.data();

            // Find Team by gameUid
            const teamsQuery = await matchRef.collection('teams').where('gameUids', 'array-contains', gameUid).limit(1).get();
            if (teamsQuery.empty) throw new Error('Team not found for this gameUid');
            
            const teamDoc = teamsQuery.docs[0];
            const team = teamDoc.data();
            const ownerUid = team.ownerUid;

            // Check if already distributed for this specific team in this match
            // Creating a unique key for distribution tracking
            const distKey = `DIST_${matchId}_${ownerUid}`;
            const distRef = db.collection('internal_ledger').doc(distKey);
            const distDoc = await t.get(distRef);
            if (distDoc.exists) throw new Error('Prize already distributed to this team');

            const rankPrize = match.rankPrizes[rank] || 0;
            const killPrize = kills * match.perKillRate;
            const totalPrize = rankPrize + killPrize;
            const xpGained = (kills * 10) + (rank === 1 ? 100 : 20);

            const userRef = db.collection('users').doc(ownerUid);
            t.update(userRef, {
                wallet: admin.firestore.FieldValue.increment(totalPrize),
                totalXP: admin.firestore.FieldValue.increment(xpGained),
                matchesPlayed: admin.firestore.FieldValue.increment(1),
                totalKills: admin.firestore.FieldValue.increment(kills)
            });

            t.set(distRef, {
                matchId,
                ownerUid,
                gameUid,
                totalPrize,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            const transRef = db.collection('transactions').doc();
            t.set(transRef, {
                userId: ownerUid,
                type: 'MATCH_PRIZE',
                amount: totalPrize,
                matchId: matchId,
                status: 'SUCCESS',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return { success: true, prize: totalPrize };
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
