const chatbot = require("../services/chatbot.service")
const { getTelemetry } = require("../telemetry")

async function ask(req, res) {
    const { message, history } = req.body || {}
    const t = getTelemetry?.()
    const started = Date.now()
    try {
        const out = await chatbot.ask({
            userId: req.user.id,
            message,
            history
        })
        t?.metrics?.chatbotRequests?.add(1, { source: out.source || "unknown", status: "ok" })
        t?.metrics?.chatbotLatencyMs?.record(Date.now() - started, { source: out.source || "unknown" })
        return res.status(200).json({ reply: out.text, source: out.source })
    } catch (err) {
        t?.metrics?.chatbotRequests?.add(1, { source: "error", status: "fail" })
        console.error("[chatbot.ask] failed:", err.message)
        return res.status(500).json({ message: "The assistant is temporarily unavailable. Please try again." })
    }
}

module.exports = { ask }
