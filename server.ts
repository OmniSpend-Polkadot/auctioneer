import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3001");
const AUCTION_TIMEOUT_MS = parseInt(process.env.AUCTION_TIMEOUT_MS || "500");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});

// ============================================================
// Types
// ============================================================

interface RFQRequest {
    requestId: string;
    user: string;
    legs: { chain: string; chainId: number; amount: string }[];
    destination: { chain: string; chainId: number };
    totalOutputAmount: string;
    target: string;
    callData: string;
}

interface SolverBid {
    solverAddress: string;
    solverName: string;
    fee: string; // in USDC (human readable, e.g., "0.3")
    requestId: string;
}

interface AuctionResult {
    requestId: string;
    winner: SolverBid | null;
    allBids: SolverBid[];
    auctionDurationMs: number;
}

// Intent status types
type IntentStatus =
    | "pending"
    | "solver_accepted"
    | "origin_escrow_started"
    | "origin_escrow_complete"
    | "destination_executing"
    | "destination_success"
    | "destination_failed"
    | "completed";

interface IntentStep {
    status: IntentStatus;
    message: string;
    txHash?: string;
    timestamp: number;
}

interface Intent {
    requestId: string;
    user: string;
    winnerAddress: string;
    winnerName: string;
    legs: { chain: string; chainId: number; amount: string }[];
    destination: { chain: string; chainId: number };
    totalOutputAmount: string;
    nftName?: string;
    steps: IntentStep[];
    currentStep: number;
    status: IntentStatus;
    createdAt: number;
    updatedAt: number;
}

// ============================================================
// Storage
// ============================================================

// Track active auctions
const activeAuctions = new Map<
    string,
    { bids: SolverBid[]; resolve: (result: AuctionResult) => void; timer: ReturnType<typeof setTimeout> }
>();

// Track winning solver sockets (requestId → socket)
const auctionWinners = new Map<string, Socket>();

// Intent tracking storage (in-memory for now, can be persisted)
const intents = new Map<string, Intent>();

// User socket connections (userAddress → socket)
const userSockets = new Map<string, Socket>();

// ============================================================
// WebSocket: Solver Namespace
// ============================================================

const solverNamespace = io.of("/solver");

solverNamespace.on("connection", (socket: Socket) => {
    const solverName = (socket.handshake.query.name as string) || "Unknown";
    const solverAddress = (socket.handshake.query.address as string) || "0x0000";

    console.log(`\n🤖 Solver connected: ${solverName} (${solverAddress}) [${socket.id}]`);

    // Solver submits a bid for an active RFQ
    socket.on("bid", (bid: SolverBid) => {
        const auction = activeAuctions.get(bid.requestId);
        if (!auction) {
            socket.emit("error", { message: "Auction expired or not found" });
            return;
        }

        console.log(`  📩 Bid from ${bid.solverName}: fee=${bid.fee} USDC`);
        auction.bids.push(bid);

        // Store the socket reference for this solver
        if (!auctionWinners.has(`${bid.requestId}:${bid.solverAddress}`)) {
            auctionWinners.set(`${bid.requestId}:${bid.solverAddress}`, socket);
        }
    });

    // Solver emits execution status update
    socket.on("intent_status", (data: {
        requestId: string;
        status: IntentStatus;
        message: string;
        txHash?: string;
    }) => {
        console.log(`  📊 Intent ${data.requestId} status: ${data.status} - ${data.message}`);

        const intent = intents.get(data.requestId);
        if (!intent) {
            console.log(`  ⚠️ Intent not found: ${data.requestId}`);
            return;
        }

        // Update intent
        intent.steps.push({
            status: data.status,
            message: data.message,
            txHash: data.txHash,
            timestamp: Date.now(),
        });
        intent.status = data.status;
        intent.updatedAt = Date.now();

        // Determine current step based on status
        const stepMap: Record<IntentStatus, number> = {
            pending: 0,
            solver_accepted: 1,
            origin_escrow_started: 2,
            origin_escrow_complete: 3,
            destination_executing: 4,
            destination_success: 5,
            destination_failed: -1,
            completed: 5,
        };
        intent.currentStep = stepMap[data.status];

        // Emit to user
        const userSocket = userSockets.get(intent.user.toLowerCase());
        if (userSocket && userSocket.connected) {
            userSocket.emit("intent_update", {
                requestId: data.requestId,
                status: data.status,
                message: data.message,
                txHash: data.txHash,
                step: intent.currentStep,
            });
        }

        // Also emit via REST-saved userId if different
        if (intent.user !== intent.user.toLowerCase()) {
            const lowerUserSocket = userSockets.get(intent.user.toLowerCase());
            if (lowerUserSocket && lowerUserSocket.connected) {
                lowerUserSocket.emit("intent_update", {
                    requestId: data.requestId,
                    status: data.status,
                    message: data.message,
                    txHash: data.txHash,
                    step: intent.currentStep,
                });
            }
        }
    });

    socket.on("disconnect", () => {
        console.log(`❌ Solver disconnected: ${solverName} [${socket.id}]`);
    });
});

// ============================================================
// WebSocket: Client Namespace (for frontend)
// ============================================================

const clientNamespace = io.of("/client");

clientNamespace.on("connection", (socket: Socket) => {
    const userAddress = (socket.handshake.query.address as string || "").toLowerCase();

    if (userAddress) {
        userSockets.set(userAddress, socket);
        console.log(`\n👤 Client connected: ${userAddress} [${socket.id}]`);
    }

    // User subscribes to specific intent updates
    socket.on("subscribe_intent", (requestId: string) => {
        socket.join(`intent:${requestId}`);
        console.log(`  📡 Client subscribed to intent: ${requestId}`);

        // Send current intent status if exists
        const intent = intents.get(requestId);
        if (intent) {
            socket.emit("intent_update", {
                requestId: intent.requestId,
                status: intent.status,
                message: intent.steps[intent.steps.length - 1]?.message || "Processing...",
                step: intent.currentStep,
                legs: intent.legs,
                totalOutputAmount: intent.totalOutputAmount,
                winnerName: intent.winnerName,
            });
        }
    });

    socket.on("unsubscribe_intent", (requestId: string) => {
        socket.leave(`intent:${requestId}`);
    });

    socket.on("disconnect", () => {
        if (userAddress) {
            userSockets.delete(userAddress);
            console.log(`\n👤 Client disconnected: ${userAddress}`);
        }
    });
});

// ============================================================
// REST API: Widget Endpoints
// ============================================================

/**
 * POST /api/request-quote
 * Widget sends an RFQ. Auctioneer broadcasts to all solvers,
 * waits AUCTION_TIMEOUT_MS, and returns the lowest bid.
 */
app.post("/api/request-quote", async (req, res) => {
    const rfq: RFQRequest = req.body;

    if (!rfq.requestId || !rfq.legs || !rfq.destination) {
        res.status(400).json({ error: "Invalid RFQ payload" });
        return;
    }

    console.log(`\n🔔 ========== NEW RFQ ==========`);
    console.log(`   Request ID: ${rfq.requestId}`);
    console.log(`   User: ${rfq.user}`);
    console.log(`   Legs: ${rfq.legs.map((l) => `${l.amount} USDC on ${l.chain}`).join(" + ")}`);
    console.log(`   Destination: ${rfq.destination.chain}`);
    console.log(`   Total Output: ${rfq.totalOutputAmount} USDC`);
    console.log(`   ⏱  Auction window: ${AUCTION_TIMEOUT_MS}ms`);
    console.log(`   📡 Broadcasting to ${solverNamespace.sockets.size} solver(s)...`);

    // Create auction promise
    const auctionPromise = new Promise<AuctionResult>((resolve) => {
        const timer = setTimeout(() => {
            const auction = activeAuctions.get(rfq.requestId);
            if (auction) {
                activeAuctions.delete(rfq.requestId);

                // Find lowest bid
                const sorted = auction.bids.sort(
                    (a, b) => parseFloat(a.fee) - parseFloat(b.fee)
                );
                const winner = sorted.length > 0 ? sorted[0] : null;

                resolve({
                    requestId: rfq.requestId,
                    winner,
                    allBids: auction.bids,
                    auctionDurationMs: AUCTION_TIMEOUT_MS,
                });
            }
        }, AUCTION_TIMEOUT_MS);

        activeAuctions.set(rfq.requestId, { bids: [], resolve, timer });
    });

    // Broadcast RFQ to all connected solvers
    solverNamespace.emit("rfq", rfq);

    // Wait for auction to complete
    const result = await auctionPromise;

    console.log(`\n🏁 ========== AUCTION RESULT ==========`);
    console.log(`   Total bids: ${result.allBids.length}`);
    if (result.winner) {
        console.log(`   🏆 WINNER: ${result.winner.solverName} (${result.winner.solverAddress})`);
        console.log(`   💰 Fee: ${result.winner.fee} USDC`);
    } else {
        console.log(`   ⚠️  No bids received`);
    }

    res.json(result);
});

/**
 * POST /api/submit-signature
 * Widget sends the signed Permit2 payload.
 * Auctioneer forwards it ONLY to the winning solver.
 */
app.post("/api/submit-signature", (req, res) => {
    const { requestId, winnerAddress, signedPayload, nftName, user, legs, destination, totalOutputAmount } = req.body;

    if (!requestId || !winnerAddress || !signedPayload) {
        res.status(400).json({ error: "Missing requestId, winnerAddress, or signedPayload" });
        return;
    }

    // Create intent tracking record
    const intent: Intent = {
        requestId,
        user: user?.toLowerCase() || "",
        winnerAddress,
        winnerName: "", // Will be filled from the auction
        legs: legs || [],
        destination: destination || { chain: "Polkadot", chainId: 420420417 },
        totalOutputAmount: totalOutputAmount || "0",
        nftName,
        steps: [{
            status: "pending",
            message: "Intent submitted, waiting for solver...",
            timestamp: Date.now(),
        }],
        currentStep: 0,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    intents.set(requestId, intent);

    // Get winner name from active auctions if available
    const auction = activeAuctions.get(requestId);
    if (auction) {
        const winner = auction.bids.find(b => b.solverAddress === winnerAddress);
        if (winner) {
            intent.winnerName = winner.solverName;
        }
    }

    // Notify subscribed client
    clientNamespace.to(`intent:${requestId}`).emit("intent_update", {
        requestId,
        status: "pending",
        message: "Intent submitted, waiting for solver...",
        step: 0,
    });

    const winnerSocket = auctionWinners.get(`${requestId}:${winnerAddress}`);

    if (!winnerSocket || !winnerSocket.connected) {
        console.log(`\n⚠️  Winner socket not found for ${winnerAddress}`);

        // Still store intent but warn user
        res.json({
            success: true,
            message: "Signature received, solver may be offline. Intent will be processed when solver reconnects.",
            intentId: requestId
        });
        return;
    }

    console.log(`\n🔐 ========== SIGNATURE RECEIVED ==========`);
    console.log(`   Forwarding to winner: ${winnerAddress}`);
    console.log(`   Intent ID: ${requestId}`);

    // Send ONLY to the winning solver
    winnerSocket.emit("execute_order", {
        requestId,
        signedPayload,
    });

    // Clean up auction winner reference
    auctionWinners.delete(`${requestId}:${winnerAddress}`);

    console.log(`   ✅ Order forwarded exclusively to winner!`);
    res.json({ success: true, message: "Signature forwarded to winning solver", intentId: requestId });
});

/**
 * GET /api/intent/:requestId
 * Get current intent status (for polling fallback)
 */
app.get("/api/intent/:requestId", (req, res) => {
    const { requestId } = req.params;
    const intent = intents.get(requestId);

    if (!intent) {
        res.status(404).json({ error: "Intent not found" });
        return;
    }

    res.json({
        requestId: intent.requestId,
        status: intent.status,
        currentStep: intent.currentStep,
        steps: intent.steps,
        legs: intent.legs,
        totalOutputAmount: intent.totalOutputAmount,
        winnerName: intent.winnerName,
        nftName: intent.nftName,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
    });
});

/**
 * GET /api/intents/:userAddress
 * Get all intents for a user
 */
app.get("/api/intents/:userAddress", (req, res) => {
    const { userAddress } = req.params;
    const userIntents: Intent[] = [];

    intents.forEach((intent) => {
        if (intent.user.toLowerCase() === userAddress.toLowerCase()) {
            userIntents.push(intent);
        }
    });

    // Sort by createdAt descending
    userIntents.sort((a, b) => b.createdAt - a.createdAt);

    res.json(userIntents);
});

// Health check
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        connectedSolvers: solverNamespace.sockets.size,
        connectedClients: clientNamespace.sockets.size,
        activeAuctions: activeAuctions.size,
        trackedIntents: intents.size,
    });
});

// ============================================================
// Start Server
// ============================================================

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║     🏛️  OmniSpend Auctioneer Node v1.1        ║
║     Listening on http://localhost:${PORT}       ║
║     Auction window: ${AUCTION_TIMEOUT_MS}ms                   ║
║     Solver namespace: /solver                 ║
║     Client namespace: /client                 ║
╚═══════════════════════════════════════════════╝
  `);
});
