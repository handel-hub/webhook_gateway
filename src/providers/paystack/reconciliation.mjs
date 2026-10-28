/**
 * Paystack Transaction Verification Adapter for Automated Reconciliation (ADR-11).
 */
export const PaystackReconciliationAdapter = {
  /**
   * Queries Paystack transaction verification API by merchant reference.
   *
   * @param {object} params
   * @param {string} params.secretKey
   * @param {string} params.merchantReference
   * @param {number} [params.timeoutMs=10000]
   * @param {string} [params.baseUrl='https://api.paystack.co']
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
    baseUrl = 'https://api.paystack.co',
  }) {
    const url = `${baseUrl}/transaction/verify/${encodeURIComponent(merchantReference)}`;

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

    if (!res.ok || !data.status || !data.data) {
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
    // Paystack returns amount in minor units (e.g. 25000 kobo)
    const amountMinor = typeof tx.amount === 'number' ? tx.amount : null;
    const currency = typeof tx.currency === 'string' ? tx.currency.toUpperCase() : null;
    const reference = typeof tx.reference === 'string' ? tx.reference : null;

    return {
      success: true,
      status: tx.status === 'success' ? 'successful' : (tx.status ?? 'unknown'),
      verifiedAmountMinor: amountMinor,
      verifiedCurrency: currency,
      verifiedReference: reference,
      rawResponse: data,
    };
  },
};
