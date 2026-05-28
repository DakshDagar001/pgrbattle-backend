/**
 * Payment Email Parser
 *
 * Modular parser chain for extracting payment details from emails.
 * Each parser implements:
 *   - canParse(email)  → boolean  (does this parser recognise the email?)
 *   - parse(body, subject) → parsed object or null
 *
 * Current parsers (evaluated in order):
 *   1. FamPayParser   – emails from no-reply@famapp.in
 *   2. GenericUPIParser – fallback for any UPI-style payment notification
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Strip all HTML tags and decode common entities so regex can work on plain text.
 */
function stripHtml(html) {
  if (!html) return '';

  return html
    // Remove style / script blocks entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Replace <br>, <p>, <div> boundaries with newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#8377;/g, '₹')
    .replace(/&rupee;/gi, '₹')
    .replace(/&#x20B9;/gi, '₹')
    // Collapse multiple blank lines / spaces
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Normalise a body string: if it looks like HTML, strip tags first.
 */
function normaliseBody(raw) {
  if (!raw) return '';
  // Heuristic: contains an HTML tag → treat as HTML
  if (/<[a-zA-Z][^>]*>/.test(raw)) {
    return stripHtml(raw);
  }
  return raw.trim();
}

/**
 * Try to parse an Indian date string like "10:35 PM IST, 04 February 2026" into
 * an ISO timestamp.  Returns the original string on failure.
 */
function parseIndianDate(dateStr) {
  if (!dateStr) return null;

  // "10:35 PM IST, 04 February 2026"
  const match = dateStr.match(
    /(\d{1,2}:\d{2}\s*(?:AM|PM))\s*IST\s*,\s*(\d{1,2}\s+\w+\s+\d{4})/i
  );

  if (match) {
    const timePart = match[1].trim(); // "10:35 PM"
    const datePart = match[2].trim(); // "04 February 2026"
    const combined = `${datePart} ${timePart}`;
    const parsed = new Date(combined);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  // Fallback: try Date constructor directly
  const fallback = new Date(dateStr);
  if (!isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }

  return dateStr; // return raw string if nothing worked
}

// ── FamPay Parser ──────────────────────────────────────────────────────────────

const FamPayParser = {
  name: 'FamPay',

  /**
   * Returns true if the email looks like a FamPay notification.
   */
  canParse(email) {
    const { body, subject } = email;
    const text = `${subject || ''} ${body || ''}`.toLowerCase();
    return (
      text.includes('famapp') ||
      text.includes('fampay') ||
      text.includes('famx') ||
      text.includes('fmpib')
    );
  },

  /**
   * Extract payment details from a FamPay email.
   *
   * Expected format:
   *   Subject: You received ₹10.0 in your FamX account
   *   Body:
   *     Hey Daksh,
   *     You have successfully received ₹10.0 from PRIYANKA DEVI
   *     Transaction ID: FMPIB4514809293
   *     Date: 10:35 PM IST, 04 February 2026
   *     Updated Balance: ₹38.0
   */
  parse(body, subject) {
    const text = normaliseBody(body);
    const combined = `${subject || ''}\n${text}`;

    // ── Amount ──
    let amount = null;
    // Try body first: "received ₹XX.X"
    const amtMatch = combined.match(/received\s*₹\s*([\d,]+(?:\.\d+)?)/i);
    if (amtMatch) {
      amount = parseFloat(amtMatch[1].replace(/,/g, ''));
    }
    // Fallback: "₹XX" anywhere
    if (!amount) {
      const amtFallback = combined.match(/₹\s*([\d,]+(?:\.\d+)?)/);
      if (amtFallback) {
        amount = parseFloat(amtFallback[1].replace(/,/g, ''));
      }
    }

    // ── UTR / Transaction ID ──
    let utr = null;
    const utrMatch = text.match(/Transaction\s*ID\s*[:：]\s*([A-Za-z0-9]+)/i);
    if (utrMatch) {
      utr = utrMatch[1].trim();
    }

    // ── Sender Name ──
    let senderName = null;
    const senderMatch = text.match(/from\s+([A-Z][A-Z\s]+)/);
    if (senderMatch) {
      senderName = senderMatch[1].trim();
    }
    // Fallback: case-insensitive
    if (!senderName) {
      const senderFallback = text.match(/from\s+([A-Za-z][A-Za-z\s]{2,})/i);
      if (senderFallback) {
        senderName = senderFallback[1].trim();
      }
    }

    // ── Date / Timestamp ──
    let timestamp = null;
    const dateMatch = text.match(/Date\s*[:：]\s*(.+)/i);
    if (dateMatch) {
      timestamp = parseIndianDate(dateMatch[1].trim());
    }

    if (!utr && !amount) return null; // nothing useful extracted

    return {
      utr: utr || null,
      amount: amount || 0,
      timestamp: timestamp || null,
      senderName: senderName || 'Unknown',
      source: 'FamPay'
    };
  }
};

// ── Generic UPI Parser ─────────────────────────────────────────────────────────

const GenericUPIParser = {
  name: 'GenericUPI',

  /**
   * Always returns true – this is the catch-all fallback parser.
   */
  canParse(_email) {
    return true;
  },

  /**
   * Attempt to extract payment info using common UPI patterns.
   */
  parse(body, subject) {
    const text = normaliseBody(body);
    const combined = `${subject || ''}\n${text}`;

    // ── UTR ──
    let utr = null;
    const utrPatterns = [
      /UTR\s*[:：]\s*([A-Za-z0-9]+)/i,
      /Transaction\s*ID\s*[:：]\s*([A-Za-z0-9]+)/i,
      /Txn\s*ID\s*[:：]\s*([A-Za-z0-9]+)/i,
      /UPI\s*Ref\s*[:：#]?\s*([A-Za-z0-9]+)/i,
      /Reference\s*(?:No|Number|ID)\s*[:：]?\s*([A-Za-z0-9]+)/i
    ];

    for (const pattern of utrPatterns) {
      const match = combined.match(pattern);
      if (match) {
        utr = match[1].trim();
        break;
      }
    }

    // ── Amount ──
    let amount = null;
    const amountPatterns = [
      /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)/i,
      /(?:received|credited|paid|amount)\s*[:：]?\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d+)?)/i
    ];

    for (const pattern of amountPatterns) {
      const match = combined.match(pattern);
      if (match) {
        amount = parseFloat(match[1].replace(/,/g, ''));
        break;
      }
    }

    // ── Sender ──
    let senderName = null;
    const senderPatterns = [
      /from\s+([A-Z][A-Z\s]+)/,
      /from\s+([A-Za-z][A-Za-z\s]{2,})/i,
      /sender\s*[:：]\s*(.+)/i
    ];

    for (const pattern of senderPatterns) {
      const match = combined.match(pattern);
      if (match) {
        senderName = match[1].trim();
        break;
      }
    }

    // ── Date ──
    let timestamp = null;
    const datePatterns = [
      /Date\s*[:：]\s*(.+)/i,
      /Time\s*[:：]\s*(.+)/i,
      /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i
    ];

    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        timestamp = parseIndianDate(match[1].trim());
        break;
      }
    }

    if (!utr && !amount) return null;

    return {
      utr: utr || null,
      amount: amount || 0,
      timestamp: timestamp || null,
      senderName: senderName || 'Unknown',
      source: 'GenericUPI'
    };
  }
};

// ── Parser Chain ───────────────────────────────────────────────────────────────

/** Ordered list of parsers. First match wins. */
const parsers = [FamPayParser, GenericUPIParser];

/**
 * Parse a payment email and return structured data.
 *
 * @param {string} emailBody  – raw email body (plain text or HTML)
 * @param {string} subject    – email subject line
 * @returns {{ utr: string|null, amount: number, timestamp: string|null, senderName: string, source: string } | null}
 */
function parsePaymentEmail(emailBody, subject) {
  const email = { body: emailBody, subject };

  for (const parser of parsers) {
    try {
      if (parser.canParse(email)) {
        const result = parser.parse(emailBody, subject);
        if (result) {
          console.log(`[Parser] ${parser.name} matched – UTR: ${result.utr}, Amount: ${result.amount}`);
          return result;
        }
      }
    } catch (err) {
      console.error(`[Parser] ${parser.name} threw:`, err.message);
    }
  }

  console.log('[Parser] No parser could extract payment data');
  return null;
}

module.exports = { parsePaymentEmail };
