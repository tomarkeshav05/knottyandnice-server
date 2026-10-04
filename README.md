# Knotty & Nice – payment server (setup guide)

What it does: customers pay on your website with Razorpay (UPI / cards / netbanking). When a payment really succeeds,
this server emails YOU the full order (customer, address, items, amount). You only ever receive PAID orders. 
Prices are checked on the server, so nobody can change a price in their browser.

Do the steps in order. Use Razorpay TEST mode first. No real money moves until you switch to LIVE keys.

## Step 1 – Razorpay account
1. Sign up at razorpay.com. Complete KYC (PAN, bank account, business details). Live payments need KYC approval.
2. Dashboard -> top switch -> **Test Mode**. Go to Account & Settings -> **API Keys** -> Generate key.
   Copy the **Key ID** and **Key Secret** (shown once).

## Step 2 – Gmail app password (so the server can email you)
1. On knottyandnice754@gmail.com: Google Account -> Security -> turn on 2-Step Verification.
2. Search "App passwords" -> create one named "Knotty server" -> copy the 16-letter password.

## Step 3 – Put the server online (Render.com, free plan works to start)
1. Create a free account at github.com and a new repository. Upload everything in this folder
   (do NOT upload a `.env` file or the `node_modules` folder).
2. On render.com: New -> **Web Service** -> connect that repository.
   Build command: `npm install`   Start command: `npm start`
3. In Render -> **Environment**, add these (copy names from `.env.example`):
   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET (invent a long random text),
   GMAIL_USER, GMAIL_APP_PASSWORD, OWNER_EMAIL, SITE_URL (your website address, no trailing slash).
4. Deploy. You get an address like `https://knottyandnice-server.onrender.com`. Opening it should say "Knotty & Nice server is running."
   Note: Render's free plan "sleeps" when unused, so the first order after a quiet time can take ~50 seconds to start.
   Their paid plan (about $7/month) removes this. Many sellers upgrade once orders begin.

## Step 4 – Razorpay webhook (this is what triggers your order email)
Razorpay Dashboard -> Account & Settings -> **Webhooks** -> Add new webhook:
- URL: `https://YOUR-SERVER-ADDRESS/api/webhook`
- Secret: exactly the same text as RAZORPAY_WEBHOOK_SECRET
- Event: tick **order.paid** only. Save.

## Step 5 – Connect the website
1. Open `index.html` (inside the `knottyandnice-site` folder) in a text editor. Find the line `const BACKEND_URL="";` and put your server address inside the quotes.
2. Upload the whole `knottyandnice-site` folder to Netlify (drag and drop). Keep ALL files together: the shop plus the policy pages. Use your website address as SITE_URL in Step 3.

## Step 6 – Test (Test Mode)
Place an order on your site and pay with Razorpay's test UPI/card details (shown in Razorpay docs: "Test cards").
You should see "Payment received!" on the site AND get a "PAID order" email within a minute.
The order also appears in Razorpay Dashboard -> Transactions -> Orders.

## Step 7 – Go live
Complete KYC -> switch Razorpay to **Live Mode** -> generate Live keys -> replace the two RAZORPAY keys in Render
-> create the same webhook again in Live Mode. Place one small real order to confirm.

## Good to know
- Refunds: do them from the Razorpay Dashboard.
- Changing prices or products later: edit `products.json` here AND the product list in the website file (both must match,
  otherwise the server will reject the old price). Ask me and I'll update both together.
- Run `npm test` anytime to check the pricing and security logic still works.
- Never share your Key Secret, webhook secret or Gmail app password with anyone or paste them into the website.
