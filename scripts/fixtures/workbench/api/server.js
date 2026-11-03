// Loopback API for Workbench integration tests. Usage: node server.js [port]  (port 0 picks a free one)
const http = require('http');
const users = {};
let next = 42;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/users') {
      const user = Object.assign({ id: next++, role: 'member' }, JSON.parse(body || '{}'));
      users[user.id] = user;
      res.statusCode = 201;
      return res.end(JSON.stringify(user));
    }
    const match = req.url.match(/^\/users\/(\d+)$/);
    if (req.method === 'GET' && match && users[match[1]]) {
      return res.end(JSON.stringify(users[match[1]]));
    }
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  });
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => {
  console.log('PORT=' + server.address().port);
});
module.exports = server;
