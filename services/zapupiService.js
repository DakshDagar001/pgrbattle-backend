/**
 * ZapUPI Service
 *
 * Encapsulates all communication with the ZapUPI payment gateway:
 *   - createOrder()    – create a new payment order
 *   - getOrderStatus() – query the status of an existing order
 *
 * Uses axios (already a project dependency).
 * Reads ZAPUPI_KEY from process.env (sent as zap_key in JSON body).
 *
 * API Reference: see /ZAPUPI.md in project root.
 */

const axios = require('axios');

// ── Constants ─────────────────────────────────────────────────────────────────

const ZAPUPI_CREATE_ORDER_URL = 'https://pay.zapupi.com/api/create-order';
const ZAPUPI_ORDER_STATUS_URL = 'https://pay.zapupi.com/api/order-status';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the ZapUPI API key from the environment.
 * Throws if missing (should be caught at startup by envValidator).
 */
function getZapKey() {
  const zapKey = process.env.ZAPUPI_KEY;

  if (!zapKey) {
    throw new Error('[ZapUPI] Missing ZAPUPI_KEY environment variable');
  }

  return zapKey;
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
 * @param {string} [params.webhookUrl]  – optional custom webhook URL
 *
 * @returns {Promise<{ paymentUrl: string, orderId: string, paymentData: string|null, autoCheckUrl: string|null, utrCheckUrl: string|null }>}
 * @throws {Error} on network failure or ZapUPI error response
 */
async function createOrder({ orderId, amount, customerMobile, remark, redirectUrl, webhookUrl }) {
  const zapKey = getZapKey();

  const body = {
    zap_key: zapKey,
    order_id: String(orderId),
    amount: String(Math.round(amount))
  };

  if (customerMobile) body.customer_mobile = String(customerMobile);
  if (remark) body.remark = String(remark);
  if (redirectUrl) body.redirect_url = String(redirectUrl);
  if (webhookUrl || process.env.ZAPUPI_WEBHOOK_URL) {
    body.webhook_url = webhookUrl || process.env.ZAPUPI_WEBHOOK_URL;
  }

  console.log(`[ZapUPI] Creating order: orderId=${orderId}, amount=${amount}`);

  try {
    const response = await axios.post(ZAPUPI_CREATE_ORDER_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000 // 15 second timeout
    });

    const data = response.data;

    if (!data || data.status !== 'success') {
      const msg = (data && data.message) || 'Unknown ZapUPI error';
      console.error(`[ZapUPI] Create order failed: ${msg}`);
      throw new Error(`ZapUPI order creation failed: ${msg}`);
    }

    console.log(`[ZapUPI] Order created: orderId=${data.order_id || orderId}, paymentUrl=${data.payment_url}`);

    return {
      paymentUrl: data.payment_url,
      orderId: data.order_id || orderId,
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
 * @returns {Promise<{ status: string, amount: number, utr: string|null, txnId: string|null, customerMobile: string|null, remark: string|null, createdAt: string|null, environment: string|null, orderId: string }>}
 * @throws {Error} on network failure or ZapUPI error response
 */
async function getOrderStatus(orderId) {
  const zapKey = getZapKey();

  const body = {
    zap_key: zapKey,
    order_id: String(orderId)
  };

  console.log(`[ZapUPI] Checking order status: orderId=${orderId}`);

  try {
    const response = await axios.post(ZAPUPI_ORDER_STATUS_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const data = response.data;

    if (!data || data.status !== 'success' || !data.data) {
      const msg = (data && data.message) || 'Unknown ZapUPI error';
      console.error(`[ZapUPI] Order status failed: ${msg}`);
      throw new Error(`ZapUPI order status failed: ${msg}`);
    }

    const orderData = data.data;

    console.log(`[ZapUPI] Order status: orderId=${orderData.order_id}, status=${orderData.status}, amount=${orderData.amount || orderData.pay_amount}`);

    return {
      status: orderData.status,
      amount: parseFloat(orderData.pay_amount || orderData.amount) || 0,
      utr: orderData.utr || null,
      txnId: orderData.txn_id || null,
      customerMobile: orderData.customer_mobile || orderData.custumer_mobile || null,
      remark: orderData.remark || null,
      createdAt: orderData.create_at || null,
      environment: orderData.environment || null,
      orderId: orderData.order_id || orderId
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
