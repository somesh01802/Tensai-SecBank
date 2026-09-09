/**
 * Given a frequency, return the next scheduled datetime after `from`.
 * ONCE returns null (one-shot events are disabled after running).
 */
function advanceNext(from, frequency) {
    const d = new Date(from.getTime())
    switch (frequency) {
        case "DAILY":     d.setUTCDate(d.getUTCDate() + 1); return d
        case "WEEKLY":    d.setUTCDate(d.getUTCDate() + 7); return d
        case "MONTHLY":   d.setUTCMonth(d.getUTCMonth() + 1); return d
        case "QUARTERLY": d.setUTCMonth(d.getUTCMonth() + 3); return d
        case "YEARLY":    d.setUTCFullYear(d.getUTCFullYear() + 1); return d
        case "ONCE":      return null
        default: return null
    }
}

module.exports = { advanceNext }
