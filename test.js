// Offline self-test: fake Razorpay + fake mailer. Run: npm test
process.env.RAZORPAY_KEY_SECRET='sec'; process.env.RAZORPAY_WEBHOOK_SECRET='wh'; process.env.RAZORPAY_KEY_ID='rzp_test_x';
process.env.GMAIL_USER='me@x.com'; process.env.SITE_URL='https://site.test';
const assert=require('assert'); const {createApp,priceCart,hmac}=require('./server');
const sent=[]; let created;
const rzp={orders:{create:async o=>{created=o;return {id:'order_1',amount:o.amount,notes:o.notes,receipt:o.receipt}}}};
const mailer={sendMail:async m=>sent.push(m)};
const srv=createApp({rzp,mailer}).listen(0,async()=>{
 const base='http://127.0.0.1:'+srv.address().port, J=(p,b)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
 const cust={name:'Asha',phone:'9876543210',email:'a@b.com',address:'12 Test Road, Kanpur',pin:'208001'};
 try{
  // 1 pillar 6in (299) + 2 x Ladoo (25)=349 ; +79 shipping
  let c=priceCart([{s:'Rose',id:19,k:1,q:1},{s:'Rose',id:44,q:2}]); console.log('cart',c.total,c.lines);
  assert.strictEqual(priceCart([{s:'Rose',id:20,k:0,q:6}],'knotty10').disc>0,true);
  assert.throws(()=>priceCart([{s:'Rose',id:9999,q:1}]));
  assert.throws(()=>priceCart([{s:'Rose',id:1,q:0}]));
  // Buy 3 Get 1 Free: 4 items -> cheapest free; coupon ignored; hampers excluded
  const P=require('./products.json'),pr=id=>P.find(x=>x.id===id).p;
  const four=[1,2,3,4].map(id=>({id,q:1,s:'Rose'})); const c4=priceCart(four,'KNOTTY10');
  assert.strictEqual(c4.bogo,Math.min(...[1,2,3,4].map(pr)),'cheapest free'); assert.strictEqual(c4.disc,c4.bogo,'coupon not stacked');
  assert.strictEqual(priceCart([{s:'Rose',id:1,q:3}]).bogo,0); assert.strictEqual(priceCart([{s:'Rose',id:53,q:4}]).bogo,0,'hampers excluded');
  assert.strictEqual(priceCart([{s:'Rose',id:2,q:8}]).bogo,2*pr(2));
  assert.throws(()=>priceCart([{id:1,q:1}]),/fragrance/,'scent required'); assert.throws(()=>priceCart([{id:1,q:1,s:'Mud'}]),/fragrance/);
  assert.match(priceCart([{id:1,q:1,s:'Rose'}]).lines[0],/Fragrance: Rose/); assert.doesNotThrow(()=>priceCart([{id:3,q:1}]),'fixed-scent item needs none');
  // tampering: client cannot send a price
  let r=await J('/api/create-order',{customer:cust,items:[{s:'Rose',id:1,q:1,price:1}],coupon:''}); let d=await r.json();
  assert.strictEqual(created.amount,(499+79)*100,'server price used'); assert.ok(d.id&&d.key);
  r=await J('/api/create-order',{customer:{...cust,phone:'123'},items:[{s:'Rose',id:1,q:1}]}); assert.strictEqual(r.status,400);
  // verify
  const good=hmac('sec','order_1|pay_1');
  assert.strictEqual((await (await J('/api/verify',{order_id:'order_1',payment_id:'pay_1',signature:good})).json()).ok,true);
  assert.strictEqual((await (await J('/api/verify',{order_id:'order_1',payment_id:'pay_1',signature:'bad'})).json()).ok,false);
  // webhook
  const ev=JSON.stringify({event:'order.paid',payload:{order:{entity:{id:'order_1',amount:57800,receipt:'KN123',notes:created.notes}},payment:{entity:{id:'pay_1',method:'upi'}}}});
  let w=await fetch(base+'/api/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-razorpay-signature':'wrong'},body:ev}); assert.strictEqual(w.status,400);
  w=await fetch(base+'/api/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-razorpay-signature':hmac('wh',ev)},body:ev}); assert.strictEqual(w.status,200);
  assert.strictEqual(sent.length,2); console.log('\n--- OWNER EMAIL ---\n'+sent[0].subject+'\n'+sent[0].text);
  console.log('ALL TESTS PASSED');
 }catch(e){console.error('FAILED',e);process.exitCode=1}
 srv.close();
});
