import * as http from 'http';
import { randomUUID } from 'crypto';

export interface ScoutDemo { url: string; close(): Promise<void>; setFixed(value: boolean): void; expireSessions(): void }

/** Local-only demonstration fixture. Defects are intentional and controllable for regression tests. */
export async function startScoutDemo(options: { fixed?: boolean; requireAuth?: boolean } = {}): Promise<ScoutDemo> {
    let fixed = options.fixed === true;
    const carts = new Map<string, { quantity: number; orders: number }>();
    const sessions = new Set<string>();
    let sequence = 0;
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
        const html = (content: string) => { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(content); };
        const session = (request.headers.cookie || '').match(/scout-demo=([^;]+)/)?.[1];
        const authenticated = !options.requireAuth || !!session && sessions.has(session);
        if (url.pathname === '/sso') { html('<!doctype html><title>Sample popup SSO</title><h1>Company sign-in</h1><button onclick="window.open(\'/login?popup=1\', \'signin\', \'width=500,height=500\')">Continue with company sign-in</button>'); return; }
        if (url.pathname === '/login') {
            if (request.method === 'POST') {
                const token = randomUUID(); sessions.add(token);
                response.setHeader('Set-Cookie', `scout-demo=${token}; HttpOnly; SameSite=Lax; Path=/`);
                if (url.searchParams.has('popup')) html('<!doctype html><script>if(window.opener){window.opener.location.href="/";window.close()}else{location.href="/"}</script>');
                else { response.writeHead(302, { Location: '/' }); response.end(); }
            } else html('<!doctype html><title>Sample SSO</title><h1>Sample sign-in</h1><p>Local fixture only. Use any sample values.</p><form method="post"><label>User <input name="username"></label><label>Password <input name="password" type="password"></label><label>MFA <input name="otp" autocomplete="one-time-code"></label><button>Sign in</button></form>');
            return;
        }
        if (url.pathname === '/logout') { if (session) sessions.delete(session); response.writeHead(302, { Location: '/login' }); response.end(); return; }
        if (!authenticated) {
            if (url.pathname.startsWith('/api/')) json(401, { error: 'Sign in required' });
            else { response.writeHead(302, { Location: '/login' }); response.end(); }
            return;
        }
        if (url.pathname === '/') { html(DEMO_HTML); return; }
        if (url.pathname === '/reset') { carts.clear(); json(200, { reset: true }); return; }
        if (url.pathname === '/api/session') { json(200, { signedIn: true }); return; }
        let raw = '';
        for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 4096) { json(413, {}); return; } }
        let data: Record<string, unknown>;
        try { data = JSON.parse(raw || '{}'); } catch { json(400, { error: 'Invalid JSON' }); return; }
        if (url.pathname === '/api/cart' && request.method === 'POST') {
            const quantity = Number(data.quantity);
            if (fixed && (!Number.isInteger(quantity) || quantity < 1 || quantity > 5)) { json(422, { error: 'Quantity must be between 1 and 5' }); return; }
            const cartId = `cart-${++sequence}`; carts.set(cartId, { quantity, orders: 0 });
            json(201, { cartId, quantity }); return;
        }
        if (url.pathname === '/api/checkout' && request.method === 'POST') {
            const cart = carts.get(String(data.cartId));
            if (!cart) { json(404, { error: 'Cart not found' }); return; }
            if (fixed && cart.orders > 0) { json(200, { cartId: data.cartId, orderId: `order-${sequence}`, orderCount: 1 }); return; }
            cart.orders++; json(200, { cartId: data.cartId, orderId: `order-${++sequence}`, orderCount: cart.orders }); return;
        }
        json(404, { error: 'Not found' });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as import('net').AddressInfo;
    return { url: `http://127.0.0.1:${address.port}`, setFixed(value) { fixed = value; }, expireSessions() { sessions.clear(); }, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const DEMO_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Scout sample shop</title><style>
body{font:16px system-ui;margin:0;background:#f4f6f5;color:#192d29}main{max-width:720px;margin:70px auto;padding:32px}header{font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#457468}h1{font-size:40px;letter-spacing:-1.5px}section{background:white;border:1px solid #dce4e0;padding:28px;margin:24px 0;border-radius:10px}label{display:block;margin:18px 0}input{display:block;padding:12px;font:inherit;width:110px;margin-top:8px;border:1px solid #a4bab0;border-radius:4px}button{background:#156f58;color:white;border:0;border-radius:5px;padding:12px 20px;font:inherit;cursor:pointer;margin-right:8px}button:disabled{opacity:.45}pre{padding:18px;background:#ecf3ef;white-space:pre-wrap;min-height:55px}small{color:#597067}a{color:#156f58}p{line-height:1.65}
</style></head><body><main><header>Karate Scout / local sample</header><h1>One journey. Hidden branches.</h1><p>Start teaching in Scout, change the quantity, create a cart, then check out once. Stop teaching and explore the recorded journey.</p><section><h2>Field notebook</h2><small>€12 each · maximum 5 per order</small><label for="quantity">Quantity<input id="quantity" name="quantity" type="number" min="1" max="5" required value="1"></label><button id="create-cart" data-testid="create-cart">Create cart</button><button id="checkout" data-testid="checkout" disabled>Check out</button><pre id="result" aria-live="polite">Ready for a new cart.</pre></section><p>This fixture intentionally accepts invalid quantities and repeats checkout. In Scout, confirm a repeat-checkout rule with HTTP 200 and <code>/orderCount at-most 1</code>.</p><small>Reset page: <code>/reset</code>. Data stays in this local process. <a href="/logout">Sign out</a></small></main><script>
let cartId;
async function send(path, data) { const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();document.getElementById('result').textContent=JSON.stringify(result,null,2);return result; }
document.getElementById('create-cart').onclick=async()=>{const cart=await send('/api/cart',{quantity:Number(document.getElementById('quantity').value)});cartId=cart.cartId;document.getElementById('checkout').disabled=!cartId;};
document.getElementById('checkout').onclick=()=>send('/api/checkout',{cartId});
</script></body></html>`;
