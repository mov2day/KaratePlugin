const assert = require('node:assert/strict');

const secrets = () => require('../../out/generation/adapters/secrets');

module.exports = [
    {
        name: 'secrets: key predicates separate credential keys from ordinary ones',
        run() {
            const s = secrets();
            for (const k of ['Authorization', 'X-Api-Key', 'access_token', 'password', 'Cookie', 'x-auth-user', 'clientSecret']) assert.equal(s.isSecretKey(k), true, k);
            for (const k of ['Content-Type', 'name', 'quantity', 'accept']) assert.equal(s.isSecretKey(k), false, k);
            assert.equal(s.isSecretName('authToken'), true);
            assert.equal(s.isSecretName('userId'), false);
        }
    },
    {
        name: 'secrets: credential value shapes (JWT, Bearer, Basic) are detected as whole values',
        run() {
            const s = secrets();
            assert.equal(s.looksLikeCredentialValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def'), true);
            assert.equal(s.looksLikeCredentialValue('Bearer abc.def.ghi'), true);
            assert.equal(s.looksLikeCredentialValue('Basic dXNlcjpwYXNz'), true);
            assert.equal(s.looksLikeCredentialValue('hello world'), false);
            assert.equal(s.looksLikeCredentialValue('ord-1001'), false);
            assert.equal(s.containsCredentialValue('x=1; Authorization: Bearer abcdefgh12345'), true);
            assert.equal(s.containsCredentialValue('plain text body'), false);
        }
    },
    {
        name: 'secrets: credentialKeys finds credential-like keys in JSON-ish, form, YAML and XML text and returns names only',
        run() {
            const s = secrets();
            assert.deepEqual(s.credentialKeys('{"user":"a","password":"p1"}'), ['password']);
            assert.deepEqual(s.credentialKeys('a=1&access_token=zzz'), ['token']);
            assert.deepEqual(s.credentialKeys('<login><password>x</password></login>'), ['password']);
            assert.deepEqual(s.credentialKeys('client_secret: abc'), ['secret']);
            assert.deepEqual(s.credentialKeys('{"name":"widget"}'), []);
            assert.deepEqual(s.credentialKeys('password={{pw}}'), []);
            assert.ok(!JSON.stringify(s.credentialKeys('password=hunter2')).includes('hunter2'));
        }
    },
    {
        name: 'secrets: env and variable name helpers',
        run() {
            const s = secrets();
            assert.equal(s.upperSnake('x-api-key'), 'X_API_KEY');
            assert.equal(s.upperSnake('accessToken'), 'ACCESS_TOKEN');
            assert.equal(s.upperSnake('---'), 'SECRET');
            assert.equal(s.camelName('x-api-key'), 'xApiKey');
            assert.equal(s.camelName('access_token'), 'accessToken');
            assert.equal(s.camelName('9lives'), 'v9lives');
        }
    },
    {
        name: 'secrets: redactUrl masks credential query values and leaves the rest',
        run() {
            const s = secrets();
            assert.equal(s.redactUrl('https://x.test/a?token=abc&page=2#f'), 'https://x.test/a?token=[REDACTED]&page=2#f');
            assert.equal(s.redactUrl('https://x.test/a'), 'https://x.test/a');
            assert.equal(s.redactUrl('https://x.test/a?q=Bearer%20zzz'.replace('%20', ' ')), 'https://x.test/a?q=[REDACTED]');
        }
    }
];
