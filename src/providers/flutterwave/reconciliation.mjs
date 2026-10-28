/**
 * Flutterwave Transaction Verification Adapter for Automated Reconciliation (ADR-11).
 */
export const FlutterwaveReconciliationAdapter = {
  /**
   * Queries Flutterwave transaction verification API by merchant tx_ref.
   *
   * @param {object} params
   * @param {string} params.secretKey
   * @param {string} params.merchantReference
   * @param {number} [params.timeoutMs=10000]
   * @param {string} [params.baseUrl='https://api.flutterwave.com/v3']
   * @returns {Promise<{
   *   success: boolean,
   *   status: string,
   *   verifiedAmountMinor: number | null,
   *   verifiedCurrency: string | null,
   *   verifiedReference: string | null,
   *   rawResponse: Record<string, any>
   * }>}
   */
  async verifyTransaction({
    secretKey,
    merchantReference,
    timeoutMs = 10000,
    baseUrl = 'https://api.flutterwave.com/v3',
  }) {
    const url = `${baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(merchantReference)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    /** @type {any} */
    let data;
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok || data.status !== 'success' || !data.data) {
      return {
        success: false,
        status: data?.data?.status ?? 'not_found',
        verifiedAmountMinor: null,
        verifiedCurrency: null,
        verifiedReference: null,
        rawResponse: data,
      };
    }

    const tx = data.data;
    // Flutterwave returns amount in major units (e.g. 250 NGN); convert to minor units (25000)
    const amountMinor = typeof tx.amount === 'number' ? Math.round(tx.amount * 100) : null;
    const currency = typeof tx.currency === 'string' ? tx.currency.toUpperCase() : null;
    const reference = typeof tx.tx_ref === 'string' ? tx.tx_ref : null;

    return {
      success: true,
      status: tx.status === 'successful' ? 'successful' : (tx.status ?? 'unknown'),
      verifiedAmountMinor: amountMinor,
      verifiedCurrency: currency,
      verifiedReference: reference,
      rawResponse: data,
    };
  },
};
