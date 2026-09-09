/**
 * Demo bill-provider adapter.
 *
 * This is a clearly isolated stand-in for a real bill-fetch integration
 * (BBPS / TSP APIs). In production this module would be swapped for one
 * that calls an external service. Nothing here reaches the outside world —
 * we simply generate a plausible amount for the given category/biller,
 * seeded deterministically off the biller name so callers see a stable
 * amount for the same input within a run.
 */

function hash(s) {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
    return Math.abs(h)
}

const RANGES = {
    PHONE:       [200, 1000],
    CREDIT_CARD: [500, 25000],
    EMI:         [1000, 20000],
    STREAMING:   [149, 799],
    ELECTRICITY: [200, 6000],
    INTERNET:    [499, 1999],
    FUEL:        [500, 6000],
    WATER:       [150, 1500],
    GAS:         [400, 1500],
    OTHER:       [100, 5000]
}

async function fetchAmount({ billerName, category }) {
    const key = `${category}:${billerName}`
    const [lo, hi] = RANGES[category] || RANGES.OTHER
    const h = hash(key)
    const amt = lo + (h % (hi - lo))
    return {
        source: "demo-provider",
        amount: Math.round(amt * 100) / 100,
        currency: "INR",
        fetchedAt: new Date().toISOString()
    }
}

module.exports = { fetchAmount }
