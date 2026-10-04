// Knotty & Nice payment server. Stateless: Razorpay stores each order (with customer + items in "notes"),
// and this server emails you only when Razorpay confirms the payment.
require('dotenv').config();
const express = require('express'), cors = require('cors'), helmet = require('helmet');
const rateLimit = require('express-rate-limit'), crypto = require('crypto');
const PRODUCTS = require('./products.json');
const E = process.env;
const SCENTS = ['Lavender','Rose','Jasmine','Vanilla','Sandalwood','Lemon','Orange','Mint','Ocean Breeze','Coffee','Chocolate','Lily']; // must match the website list
const inr = n => 'Rs.' + Number(n).toLocaleString('en-IN');

// ---- Pricing: always computed here, never trusted from the browser ----
function priceCart(items, coupon) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error('Your cart is empty or too large.');
  let sub = 0; const lines = [], units = [];   // units: prices of items eligible for Buy 3 Get 1 Free
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
      if (p.c !== 'Hampers') for (let n = 0; n < q; n++) units.push(price);   // hampers are not part of the offer
      lines.push(`${q} x ${p.n}${v ? ' (' + v[0] + ')' : ''}${p.sc ? ' [Fragrance: ' + it.s + ']' : ''} @ ${inr(price)}`);
    }
  }
  // Buy 3 Get 1 Free: for every 4 eligible items, the lowest-priced one is free. Coupons cannot be combined with it.
  units.sort((a, b) => a - b);
  const bogo = units.slice(0, Math.floor(units.length / 4)).reduce((a, b) => a + b, 0);
  const disc = bogo || (String(coupon || '').toUpperCase() === 'KNOTTY10' ? sub * 0.1 : 0);
  const net = sub - disc, ship = net >= 999 ? 0 : 79;
  return { sub, bogo, disc: Math.round(disc), ship, total: Math.round(net + ship), lines };
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

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

function orderEmail(order, payment) {
  const n = order.notes || {};
  const items = [1, 2, 3, 4, 5, 6].map(i => n['items' + i]).filter(Boolean).join('').split(' ;; ').join('\n');
  return {
    subject: `PAID order ${order.receipt} - ${inr(order.amount / 100)}`,
    text: `You have a new PAID order. Please pack and ship it.\n\nOrder: ${order.receipt}\nAmount paid: ${inr(order.amount / 100)} (${payment.method || 'online'})\nPayment ID: ${payment.id}\n\nCUSTOMER\n${n.name}\nPhone: ${n.phone}\nEmail: ${n.email || '-'}\n${n.address}\nPIN: ${n.pin}\n\nITEMS\n${items}\n\nCoupon: ${n.coupon || 'none'}\n${n.totals || ''}\n`
  };
}

function createApp({ rzp, mailer }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: (E.SITE_URL || '').split(',').map(s => s.trim()).filter(Boolean) }));

  // Razorpay webhook (needs the raw body). This is the ONLY place the owner email is sent.
  app.post('/api/webhook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
    const sig = req.get('x-razorpay-signature') || '';
    if (!E.RAZORPAY_WEBHOOK_SECRET || !safeEq(hmac(E.RAZORPAY_WEBHOOK_SECRET, req.body), sig)) return res.status(400).send('bad signature');
    try {
      const ev = JSON.parse(req.body.toString());
      if (ev.event === 'order.paid') {
        const order = ev.payload.order.entity, payment = ev.payload.payment.entity;
        const m = orderEmail(order, payment);
        await mailer.sendMail({ from: E.GMAIL_USER, to: E.OWNER_EMAIL || E.GMAIL_USER, subject: m.subject, text: m.text });
        const cust = (order.notes || {}).email;
        if (cust) await mailer.sendMail({ from: E.GMAIL_USER, to: cust, subject: `Your Knotty & Nice order ${order.receipt}`,
          text: `Thank you for your order!\n\nWe received your payment of ${inr(order.amount / 100)}. We will pack it and ship it soon.\nOrder number: ${order.receipt}\n\nKnotty & Nice - Handmade with love\n` });
      }
      res.send('ok');
    } catch (e) { console.error('webhook error', e.message); res.status(500).send('error'); }  // Razorpay will retry
  });

  app.use(express.json({ limit: '50kb' }));
  app.use('/api/', rateLimit({ windowMs: 60000, max: 40 }));
  app.get('/', (_, res) => res.send('Knotty & Nice server is running.'));

  app.post('/api/create-order', async (req, res) => {
    try {
      const customer = checkCustomer(req.body.customer);
      const cart = priceCart(req.body.items, req.body.coupon);
      const text = cart.lines.join(' ;; ');
      if (text.length > 1500) throw new Error('Cart too large. Please place two separate orders.');
      const receipt = 'KN' + Date.now().toString().slice(-8);
      const notes = { ...customer, coupon: cart.bogo ? 'Buy 3 Get 1 Free' : cart.disc ? 'KNOTTY10' : '', totals: `Subtotal ${inr(cart.sub)}, discount ${inr(cart.disc)}, shipping ${inr(cart.ship)}` };
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

module.exports = { createApp, priceCart, hmac };

if (require.main === module) {
  const Razorpay = require('razorpay'), nodemailer = require('nodemailer');
  const rzp = new Razorpay({ key_id: E.RAZORPAY_KEY_ID, key_secret: E.RAZORPAY_KEY_SECRET });
  const mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: E.GMAIL_USER, pass: E.GMAIL_APP_PASSWORD } });
  createApp({ rzp, mailer }).listen(E.PORT || 3000, () => console.log('Server running'));
}
