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

// Track active auctions
const activeAuctions = new Map<
    string,
    { bids: SolverBid[]; resolve: (result: AuctionResult) => void; timer: ReturnType<typeof setTimeout> }
>();

// Track winning solver sockets (requestId → socket)
const auctionWinners = new Map<string, Socket>();

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

    // Solver receives execute_order event — handled below in submit-signature

    socket.on("disconnect", () => {
        console.log(`❌ Solver disconnected: ${solverName} [${socket.id}]`);
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
    const { requestId, winnerAddress, signedPayload } = req.body;

    if (!requestId || !winnerAddress || !signedPayload) {
        res.status(400).json({ error: "Missing requestId, winnerAddress, or signedPayload" });
        return;
    }

    const winnerSocket = auctionWinners.get(`${requestId}:${winnerAddress}`);

    if (!winnerSocket || !winnerSocket.connected) {
        console.log(`\n⚠️  Winner socket not found for ${winnerAddress}`);
        res.status(404).json({ error: "Winner solver not connected" });
        return;
    }

    console.log(`\n🔐 ========== SIGNATURE RECEIVED ==========`);
    console.log(`   Forwarding to winner: ${winnerAddress}`);

    // Send ONLY to the winning solver
    winnerSocket.emit("execute_order", {
        requestId,
        signedPayload,
    });

    // Clean up
    auctionWinners.delete(`${requestId}:${winnerAddress}`);

    console.log(`   ✅ Order forwarded exclusively to winner!`);
    res.json({ success: true, message: "Signature forwarded to winning solver" });
});

// Health check
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        connectedSolvers: solverNamespace.sockets.size,
        activeAuctions: activeAuctions.size,
    });
});

// ============================================================
// Start Server
// ============================================================

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║     🏛️  OmniSpend Auctioneer Node v1.0       ║
║     Listening on http://localhost:${PORT}       ║
║     Auction window: ${AUCTION_TIMEOUT_MS}ms                  ║
║     Solver namespace: /solver                 ║
╚═══════════════════════════════════════════════╝
  `);
});
