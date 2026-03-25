require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION O2SWITCH ---
const PORT = process.env.PORT || 3000;
const REFRESH_RATE = 2000;
const baseRoute = "/api-node"; // Doit correspondre à l'URL cPanel

// --- GESTION ERREURS ---
process.on("uncaughtException", (err) => {
	console.error("Erreur critique Node :", err);
});

// --- POOL SQL ---
const pool = mysql.createPool({
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	waitForConnections: true,
	connectionLimit: 5,
	queueLimit: 0,
});

let clients = [];
let globalState = {
	counts: { approved: 0, pending: 0, users: 0 },
	logs: [],
};

// --- ROUTE SSE CORRIGÉE ---
app.get([`${baseRoute}/events`, "/events"], (req, res) => {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		Connection: "keep-alive",
		"Cache-Control": "no-cache",
	});

	const data = `data: ${JSON.stringify(globalState)}\n\n`;
	res.write(data);

	const clientId = Date.now();
	const newClient = { id: clientId, res };
	clients.push(newClient);

	req.on("close", () => {
		clients = clients.filter((client) => client.id !== clientId);
	});
});

// Route de test pour voir si Node répond
app.get([`${baseRoute}`, `${baseRoute}/`], (req, res) => {
	res.send(
		"Le serveur Node est bien vivant sur www.portraitsanciens.fr/api-node",
	);
});

// --- ROUTE COMPTEUR VISITES ---
// Appelée par le frontend 1 fois par jour par visiteur unique
app.post([`${baseRoute}/visit`, "/visit"], async (req, res) => {
    try {
        const connection = await pool.getConnection();
        // Insère 1 pour aujourd'hui, ou ajoute +1 si la ligne existe déjà
        await connection.query(`
            INSERT INTO daily_visits (date, count) 
            VALUES (CURDATE(), 1) 
            ON DUPLICATE KEY UPDATE count = count + 1
        `);
        connection.release();
        res.json({ success: true });
    } catch (error) {
        console.error("Erreur compteur visite:", error);
        res.status(500).send("Erreur serveur");
    }
});

// --- LOGIQUE DE POLLING ---
async function updateState() {
    try {
        const connection = await pool.getConnection();

        const [rowsTotal] = await connection.query(
            "SELECT COUNT(*) as count FROM photos",
        );

        const [rowsIdentified] = await connection.query(
            "SELECT COUNT(*) as count FROM photos WHERE is_unknown = 0",
        );

        const [rowsApproved] = await connection.query(
            "SELECT COUNT(*) as count FROM photos WHERE status = 'publish'",
        );

        const [rowsPending] = await connection.query(
            "SELECT COUNT(*) as count FROM photos WHERE status = 'pending'",
        );
        const [rowsUsers] = await connection.query(
            "SELECT COUNT(*) as count FROM users WHERE is_confirmed = 1",
        );
        const [rowsLogs] = await connection.query(`
            SELECT l.id, l.entity, l.action_type, l.message, l.created_at, u.username
            FROM logs l LEFT JOIN users u ON u.id = l.user_id
            ORDER BY l.id DESC LIMIT 5
        `);
        const [rowsVisits] = await connection.query(
            "SELECT count FROM daily_visits WHERE date = CURDATE()",
        );
        
        connection.release(); // Très important de relâcher la connexion

        const dailyVisits = rowsVisits.length > 0 ? rowsVisits[0].count : 0;

        // Construction du nouvel état
        const newCounts = {
            total: rowsTotal[0].count,      // Correspondra au total
            identified: rowsIdentified[0].count,  // Correspondra aux identifiées
            pending: rowsPending[0].count,
            approved: rowsApproved[0].count,
            users: rowsUsers[0].count,
            dailyVisits: dailyVisits,
        };

        // ... (Logique de comparaison et d'envoi existante)
        const hasChanged =
            JSON.stringify(newCounts) !== JSON.stringify(globalState.counts) ||
            JSON.stringify(rowsLogs) !== JSON.stringify(globalState.logs);

        if (hasChanged) {
            globalState = { counts: newCounts, logs: rowsLogs };
            // Envoi à tous les clients connectés
            clients.forEach((c) =>
                c.res.write(`data: ${JSON.stringify(globalState)}\n\n`),
            );
        }
    } catch (error) {
        console.error("Erreur BDD:", error);
    }
}

setInterval(updateState, REFRESH_RATE);

// --- DÉMARRAGE PASSENGER (O2SWITCH) ---
if (process.env.PASSENGER_APP_ENV) {
	app.listen("passenger");
} else {
	app.listen(PORT, () => console.log(`Démarré sur port ${PORT}`));
}
