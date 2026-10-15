// Knotty & Nice payment server. Stateless: Razorpay stores each order (with customer + items in "notes"),
// and this server emails you only when Razorpay confirms the payment.
require('dotenv').config();
const express = require('express'), cors = require('cors'), helmet = require('helmet');
const rateLimit = require('express-rate-limit'), crypto = require('crypto');
const PRODUCTS = require('./products.json');
const E = process.env;
const SCENTS = ['Lavender','Rose','Jasmine','Vanilla','Sandalwood','Lemon','Orange','Mint','Ocean Breeze','Coffee','Chocolate','Lily']; // must match the website list
const inr = n => 'Rs.' + Number(n).toLocaleString('en-IN');

const FREE_SHIP_FROM = 1499;   // free shipping when the order (after any discount) is Rs.1499 or more
const SHIP_FEE = 79;
const FIRST_ORDER_PCT = 0.10;  // 10% off the first paid order from a phone number

// ---- Pricing: always computed here, never trusted from the browser ----
// firstOrder = true when this phone number has no earlier PAID order (see paidPhoneBook below).
function priceCart(items, firstOrder) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error('Your cart is empty or too large.');
  let sub = 0; const lines = [];
  for (const it of items) {
    const q = Math.floor(+it.q);
    if (!(q >= 1 && q <= 20)) throw new Error('Invalid quantity.');
    if (Array.isArray(it.h)) {                      // custom hamper: 3 candles, 10% off
      if (it.h.length !== 3) throw new Error('A hamper needs exactly 3 candles.');
      let s = 0; const names = [];
      for (const id of it.h) {
        const p = PRODUCTS.find(x => x.id === +id && x.c === 'Candles');
        if (!p) throw new Error('Invalid hamper item.');
        s += p.p; names.push(p.n);
      }
      const price = Math.round(s * 0.9); sub += price * q;
      lines.push(`${q} x Custom hamper (${names.join(' + ')}) @ ${inr(price)}`);
    } else {
      const p = PRODUCTS.find(x => x.id === +it.id);
      if (!p) throw new Error('Unknown product.');
      const v = p.v ? p.v[+it.k || 0] : null;
      if (p.v && !v) throw new Error('Invalid option.');
      if (p.sc && !SCENTS.includes(it.s)) throw new Error('Please choose a fragrance for ' + p.n + '.');
      const price = v ? v[1] : p.p; sub += price * q;
      lines.push(`${q} x ${p.n}${v ? ' (' + v[0] + ')' : ''}${p.sc ? ' [Fragrance: ' + it.s + ']' : ''} @ ${inr(price)}`);
    }
  }
  // The only offer: 10% off the whole cart on a customer's first paid order.
  const disc = firstOrder ? Math.round(sub * FIRST_ORDER_PCT) : 0;
  const net = sub - disc, ship = net >= FREE_SHIP_FROM ? 0 : SHIP_FEE;
  return { sub, first: !!firstOrder, disc, ship, total: net + ship, lines };
}

function checkCustomer(c = {}) {
  const t = k => String(c[k] || '').trim();
  if (t('name').length < 2) throw new Error('Enter your name.');
  if (!/^\d{10}$/.test(t('phone'))) throw new Error('Enter a 10-digit phone number.');
  if (t('address').length < 8) throw new Error('Enter your full address.');
  if (!/^\d{6}$/.test(t('pin'))) throw new Error('Enter a 6-digit PIN code.');
  if (t('email') && !/^\S+@\S+\.\S+$/.test(t('email'))) throw new Error('Enter a valid email.');
  return { name: t('name').slice(0, 80), phone: t('phone'), email: t('email').slice(0, 120), address: t('address').slice(0, 240), pin: t('pin') };
}

// ---- "First order" check ----
// The server stores nothing itself (Render's free plan forgets files). Razorpay is the record: every order keeps the
// customer's phone number in its notes, and Razorpay marks it status "paid". We read those orders (and keep the set of
// phones in memory, topped up from Razorpay every few seconds and instantly by the payment webhook).
// Only PAID orders count, so someone who started a checkout but never paid still gets the offer.
function paidPhoneBook(rzp) {
  const phones = new Set(); let loaded = false, syncedAt = 0, running = null;
  async function pull() {
    const startedAt = Math.floor(Date.now() / 1000);
    const from = loaded ? Math.max(1, syncedAt - 3 * 86400) : undefined;   // later top-ups re-read the last 3 days, to catch orders paid late
    for (let page = 0; page < 100; page++) {                                // up to 10,000 orders on a full load
      const r = await rzp.orders.all(from ? { from, count: 100, skip: page * 100 } : { count: 100, skip: page * 100 });
      const items = (r && r.items) || [];
      for (const o of items) { const ph = String((o.notes || {}).phone || ''); if (o.status === 'paid' && /^\d{10}$/.test(ph)) phones.add(ph); }
      if (items.length < 100) break;
    }
    syncedAt = startedAt; loaded = true;
  }
  const sync = () => (running = running || pull().finally(() => { running = null; }));
  return {
    add: ph => { if (/^\d{10}$/.test(String(ph || ''))) phones.add(String(ph)); },
    // true = no paid order yet from this phone. If Razorpay cannot be reached this throws, and the order is not created.
    async isFirstOrder(ph) {
      if (phones.has(ph)) return false;
      if (!loaded || Date.now() / 1000 - syncedAt > 15) await sync();
      return !phones.has(ph);
    }
  };
}

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

function orderEmail(order, payment) {
  const n = order.notes || {};
  const items = [1, 2, 3, 4, 5, 6].map(i => n['items' + i]).filter(Boolean).join('').split(' ;; ').join('\n');
  return {
    subject: `PAID order ${order.receipt} - ${inr(order.amount / 100)}`,
    text: `You have a new PAID order. Please pack and ship it.\n\nOrder: ${order.receipt}\nAmount paid: ${inr(order.amount / 100)} (${payment.method || 'online'})\nPayment ID: ${payment.id}\n\nCUSTOMER\n${n.name}\nPhone: ${n.phone}\nEmail: ${n.email || '-'}\n${n.address}\nPIN: ${n.pin}\n\nITEMS\n${items}\n\nOffer: ${n.coupon || 'none'}\n${n.totals || ''}\n`
  };
}

// Email can go out two ways: Gmail (SMTP) or Resend (HTTPS). Resend works on Render's free plan, because Render blocks SMTP there.
const FROM = () => E.RESEND_FROM || (E.RESEND_API_KEY ? 'Knotty & Nice <onboarding@resend.dev>' : E.GMAIL_USER);
const OWNER_TO = () => E.OWNER_EMAIL || E.GMAIL_USER;
// Resend's test sender can only email your own account address, so customer receipts need RESEND_FROM (a verified domain).
const mailCustomers = () => !E.RESEND_API_KEY || !!E.RESEND_FROM;
function resendMailer(apiKey) {
  return { async sendMail({ from, to, subject, text }) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }) });
    if (!r.ok) throw new Error('Resend refused the email (' + r.status + '): ' + (await r.text()).slice(0, 300));
    return r.json();
  } };
}

function createApp({ rzp, mailer }) {
  const app = express();
  const book = paidPhoneBook(rzp);
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: (E.SITE_URL || '').split(',').map(s => s.trim()).filter(Boolean) }));

  // Razorpay webhook (needs the raw body). This is the ONLY place the owner email is sent.
  app.post('/api/webhook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
    const sig = req.get('x-razorpay-signature') || '';
    if (!E.RAZORPAY_WEBHOOK_SECRET) { console.error('WEBHOOK REJECTED: RAZORPAY_WEBHOOK_SECRET is not set in the server settings'); return res.status(400).send('bad signature'); }
    if (!safeEq(hmac(E.RAZORPAY_WEBHOOK_SECRET, req.body), sig)) { console.error('WEBHOOK REJECTED: secret mismatch. The secret in Razorpay must be exactly the same as RAZORPAY_WEBHOOK_SECRET here'); return res.status(400).send('bad signature'); }
    try {
      const ev = JSON.parse(req.body.toString());
      console.log('Webhook received: ' + ev.event);
      if (ev.event === 'order.paid') {
        const order = ev.payload.order.entity, payment = ev.payload.payment.entity;
        book.add((order.notes || {}).phone);   // this phone has now used its first-order offer
        const m = orderEmail(order, payment);
        await mailer.sendMail({ from: FROM(), to: OWNER_TO(), subject: m.subject, text: m.text });
        console.log('Owner email sent for order ' + order.receipt);
        const cust = (order.notes || {}).email;
        if (cust && !mailCustomers()) console.log('Customer receipt skipped: verify a domain in Resend and set RESEND_FROM to enable receipts');
        if (cust && mailCustomers()) await mailer.sendMail({ from: FROM(), to: cust, subject: `Your Knotty & Nice order ${order.receipt}`,
          text: `Thank you for your order!\n\nWe received your payment of ${inr(order.amount / 100)}. We will pack it and ship it soon.\nOrder number: ${order.receipt}\n\nKnotty & Nice - Handmade with love\n` });
      }
      res.send('ok');
    } catch (e) { console.error('WEBHOOK ERROR (email could not be sent):', e.message, /timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message) ? '(the hosting plan is probably blocking email ports; see Render plan)' : '');  res.status(500).send('error'); }  // Razorpay will retry
  });

  app.use(express.json({ limit: '50kb' }));
  app.use('/api/', rateLimit({ windowMs: 60000, max: 40 }));
  app.get('/', (_, res) => res.send('Knotty & Nice server is running.'));

  // Lets the checkout page show the real total (with or without the first-order 10%) before payment starts.
  app.post('/api/quote', rateLimit({ windowMs: 60000, max: 15 }), async (req, res) => {
    try {
      const phone = String((req.body || {}).phone || '').trim();
      if (!/^\d{10}$/.test(phone)) throw new Error('Enter a 10-digit phone number.');
      const c = priceCart(req.body.items, await book.isFirstOrder(phone));
      res.json({ first: c.first, sub: c.sub, disc: c.disc, ship: c.ship, total: c.total });
    } catch (e) { res.status(400).json({ error: e.error ? 'Could not check your offer. Please try again.' : e.message }); }
  });

  app.post('/api/create-order', async (req, res) => {
    try {
      const customer = checkCustomer(req.body.customer);
      const cart = priceCart(req.body.items, await book.isFirstOrder(customer.phone));
      const text = cart.lines.join(' ;; ');
      if (text.length > 1500) throw new Error('Cart too large. Please place two separate orders.');
      const receipt = 'KN' + Date.now().toString().slice(-8);
      const notes = { ...customer, coupon: cart.first ? 'First-order 10% off' : '', totals: `Subtotal ${inr(cart.sub)}, discount ${inr(cart.disc)}, shipping ${inr(cart.ship)}` };
      text.match(/[\s\S]{1,250}/g).forEach((c, i) => { notes['items' + (i + 1)] = c; });
      const order = await rzp.orders.create({ amount: cart.total * 100, currency: 'INR', receipt, notes });
      res.json({ id: order.id, amount: order.amount, receipt, key: E.RAZORPAY_KEY_ID });
    } catch (e) { res.status(400).json({ error: e.error ? 'Payment service error. Please try again.' : e.message }); }
  });

  // Lets the customer's browser confirm the payment is genuine (email is sent by the webhook, not here).
  app.post('/api/verify', (req, res) => {
    const { order_id, payment_id, signature } = req.body || {};
    const ok = !!(order_id && payment_id && signature && E.RAZORPAY_KEY_SECRET && safeEq(hmac(E.RAZORPAY_KEY_SECRET, order_id + '|' + payment_id), String(signature)));
    res.json({ ok });
  });
  return app;
}

module.exports = { createApp, priceCart, paidPhoneBook, hmac, resendMailer };

if (require.main === module) {
  const Razorpay = require('razorpay'), nodemailer = require('nodemailer');
  const rzp = new Razorpay({ key_id: E.RAZORPAY_KEY_ID, key_secret: E.RAZORPAY_KEY_SECRET });
  let mailer;
  if (E.RESEND_API_KEY) { mailer = resendMailer(E.RESEND_API_KEY); console.log('Email: using Resend (works on the free Render plan). Orders go to ' + OWNER_TO()); }
  else {
    mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: E.GMAIL_USER, pass: E.GMAIL_APP_PASSWORD }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    mailer.verify().then(() => console.log('Gmail check: OK (login accepted)'), e => console.error('Gmail check: FAILED - ' + e.message + (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message) ? ' (the connection is blocked: Render FREE plans block email ports. Use RESEND_API_KEY instead, or upgrade the Render plan)' : ' (check GMAIL_USER and GMAIL_APP_PASSWORD, or create a new app password)')));
  }
  const need = ['RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET','SITE_URL', ...(E.RESEND_API_KEY ? ['OWNER_EMAIL'] : ['GMAIL_USER','GMAIL_APP_PASSWORD'])].filter(k => !E[k]);
  if (need.length) console.error('MISSING SETTINGS: ' + need.join(', '));
  createApp({ rzp, mailer }).listen(E.PORT || 3000, () => console.log('Server running'));
}
