/**
 * ZapUPI Service
 *
 * Encapsulates all communication with the ZapUPI payment gateway:
 *   - createOrder()    – create a new payment order
 *   - getOrderStatus() – query the status of an existing order
 *
 * Uses axios (already a project dependency).
 * Reads ZAPUPI_TOKEN_KEY and ZAPUPI_SECRET_KEY from process.env.
 *
 * API Reference: see /ZAPUPI.md in project root.
 */

const axios = require('axios');
const qs = require('querystring');

// ── Constants ─────────────────────────────────────────────────────────────────

const ZAPUPI_CREATE_ORDER_URL = 'https://api.zapupi.com/api/create-order';
const ZAPUPI_ORDER_STATUS_URL = 'https://api.zapupi.com/api/order-status';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the two ZapUPI keys from the environment.
 * Throws if either is missing (should be caught at startup by envValidator).
 */
function getKeys() {
  const tokenKey = process.env.ZAPUPI_TOKEN_KEY;
  const secretKey = process.env.ZAPUPI_SECRET_KEY;

  if (!tokenKey || !secretKey) {
    throw new Error('[ZapUPI] Missing ZAPUPI_TOKEN_KEY or ZAPUPI_SECRET_KEY');
  }

  return { tokenKey, secretKey };
}

// ── Create Order ──────────────────────────────────────────────────────────────

/**
 * Create a payment order on ZapUPI.
 *
 * @param {object} params
 * @param {string} params.orderId       – unique PGR request ID (e.g. PGR4AB7XZ12Q9KL)
 * @param {number} params.amount        – integer amount in INR (e.g. 100)
 * @param {string} [params.customerMobile] – optional customer phone number
 * @param {string} [params.remark]      – optional note for traceability
 * @param {string} [params.redirectUrl] – optional redirect after payment
 *
 * @returns {Promise<{ paymentUrl: string, orderId: string, paymentData: string|null, autoCheckUrl: string|null, utrCheckUrl: string|null }>}
 * @throws {Error} on network failure or ZapUPI error response
 */
async function createOrder({ orderId, amount, customerMobile, remark, redirectUrl }) {
  const { tokenKey, secretKey } = getKeys();

  const body = {
    token_key: tokenKey,
    secret_key: secretKey,
    amount: Math.round(amount), // ZapUPI expects integer
    order_id: orderId
  };

  if (customerMobile) body.custumer_mobile = customerMobile; // ZapUPI uses "custumer" (their typo)
  if (remark) body.remark = remark;
  if (redirectUrl) body.redirect_url = redirectUrl;

  console.log(`[ZapUPI] Creating order: orderId=${orderId}, amount=${amount}`);

  try {
    const response = await axios.post(ZAPUPI_CREATE_ORDER_URL, qs.stringify(body), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000 // 15 second timeout
    });

    const data = response.data;

    if (!data || data.status !== 'success') {
      const msg = (data && data.message) || 'Unknown ZapUPI error';
      console.error(`[ZapUPI] Create order failed: ${msg}`);
      throw new Error(`ZapUPI order creation failed: ${msg}`);
    }

    console.log(`[ZapUPI] Order created: orderId=${data.order_id}, paymentUrl=${data.payment_url}`);

    return {
      paymentUrl: data.payment_url,
      orderId: data.order_id,
      paymentData: data.payment_data || null,
      autoCheckUrl: data.auto_check_every_2_sec || null,
      utrCheckUrl: data.utr_check || null
    };
  } catch (err) {
    if (err.response) {
      // ZapUPI returned an HTTP error
      const errData = err.response.data;
      const msg = (errData && errData.message) || err.response.statusText;
      console.error(`[ZapUPI] Create order HTTP error ${err.response.status}: ${msg}`);
      throw new Error(`ZapUPI create order failed (HTTP ${err.response.status}): ${msg}`);
    }
    // Network / timeout error
    console.error(`[ZapUPI] Create order network error: ${err.message}`);
    throw new Error(`ZapUPI create order failed: ${err.message}`);
  }
}

// ── Order Status ──────────────────────────────────────────────────────────────

/**
 * Query the status of an existing order from ZapUPI.
 *
 * @param {string} orderId – the ZapUPI order_id (= PGR requestId)
 *
 * @returns {Promise<{ status: string, amount: number, utr: string|null, txnId: string|null, customerMobile: string|null, remark: string|null, createdAt: string|null, orderId: string }>}
 * @throws {Error} on network failure or ZapUPI error response
 */
async function getOrderStatus(orderId) {
  const { tokenKey, secretKey } = getKeys();

  const body = {
    token_key: tokenKey,
    secret_key: secretKey,
    order_id: orderId
  };

  console.log(`[ZapUPI] Checking order status: orderId=${orderId}`);

  try {
    const response = await axios.post(ZAPUPI_ORDER_STATUS_URL, qs.stringify(body), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    const data = response.data;

    if (!data || data.status !== 'success' || !data.data) {
      const msg = (data && data.message) || 'Unknown ZapUPI error';
      console.error(`[ZapUPI] Order status failed: ${msg}`);
      throw new Error(`ZapUPI order status failed: ${msg}`);
    }

    const orderData = data.data;

    console.log(`[ZapUPI] Order status: orderId=${orderData.order_id}, status=${orderData.status}, amount=${orderData.amount}`);

    return {
      status: orderData.status,
      amount: parseFloat(orderData.amount) || 0,
      utr: orderData.utr || null,
      txnId: orderData.txn_id || null,
      customerMobile: orderData.custumer_mobile || null,
      remark: orderData.remark || null,
      createdAt: orderData.create_at || null,
      orderId: orderData.order_id
    };
  } catch (err) {
    if (err.response) {
      const errData = err.response.data;
      const msg = (errData && errData.message) || err.response.statusText;
      console.error(`[ZapUPI] Order status HTTP error ${err.response.status}: ${msg}`);
      throw new Error(`ZapUPI order status failed (HTTP ${err.response.status}): ${msg}`);
    }
    console.error(`[ZapUPI] Order status network error: ${err.message}`);
    throw new Error(`ZapUPI order status failed: ${err.message}`);
  }
}

module.exports = {
  createOrder,
  getOrderStatus
};
