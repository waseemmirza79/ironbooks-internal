/** QBO snapshot builds — keep low to avoid Intuit rate limits. */
export const BUILD_CONCURRENCY = 5;

/** Resend + portal publish per wave. */
export const SEND_CONCURRENCY = 10;

/** Claude summary generation per wave. */
export const GENERATE_WAVE_SIZE = 10;

/** Max packages per single API send request (manager can call again). */
export const SEND_MAX_BATCH = 100;

/** Packages stuck in sending/summary_pending longer than this are auto-recovered. */
export const STALE_CLAIM_MS = 15 * 60 * 1000;

export const AI_SUMMARY_MAX_LEN = 8000;
export const AI_SUMMARY_MIN_LEN = 80;
