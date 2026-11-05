/** Static Karate knowledge for the built-in suggestion engine. The karate.* and configure lists were checked against the Karate 2.1.4 jar. */

export interface ApiMember { name: string; signature: string; detail: string }

export const KARATE_API: ReadonlyArray<ApiMember> = [
    { name: 'abort', signature: 'abort()', detail: 'Stop the scenario without failing' },
    { name: 'append', signature: 'append(list, items...)', detail: 'Append items to a list' },
    { name: 'appendTo', signature: "appendTo('name', items...)", detail: 'Append to a variable that is a list' },
    { name: 'call', signature: "call('file.feature', arg)", detail: 'Call a feature or function' },
    { name: 'callSingle', signature: "callSingle('file.feature')", detail: 'Call once per suite and cache the result' },
    { name: 'configure', signature: "configure('key', value)", detail: 'Change a runtime setting' },
    { name: 'distinct', signature: 'distinct(list)', detail: 'Unique values of a list' },
    { name: 'doc', signature: "doc({ read: 'file.html' })", detail: 'Render an HTML template into the report' },
    { name: 'embed', signature: 'embed(bytes, mimeType)', detail: 'Embed content in the report' },
    { name: 'env', signature: 'env', detail: 'The karate.env value' },
    { name: 'eval', signature: "eval('js')", detail: 'Evaluate a JavaScript string' },
    { name: 'exec', signature: "exec('command')", detail: 'Run an OS command' },
    { name: 'expect', signature: 'expect(value)', detail: 'Chai-style assertion' },
    { name: 'extract', signature: 'extract(text, regex, group)', detail: 'First regex match group' },
    { name: 'extractAll', signature: 'extractAll(text, regex, group)', detail: 'All regex match groups' },
    { name: 'fail', signature: "fail('message')", detail: 'Fail the scenario' },
    { name: 'feature', signature: 'feature', detail: 'Info about the current feature' },
    { name: 'filter', signature: 'filter(list, fn)', detail: 'Filter a list with a function' },
    { name: 'filterKeys', signature: 'filterKeys(map, keys)', detail: 'Keep only the given keys' },
    { name: 'forEach', signature: 'forEach(listOrMap, fn)', detail: 'Run a function for each item' },
    { name: 'fromString', signature: 'fromString(text)', detail: 'Parse JSON or XML text' },
    { name: 'get', signature: "get('name', default)", detail: 'Get a variable, or a default' },
    { name: 'http', signature: "http('url')", detail: 'Start a fluent HTTP request' },
    { name: 'info', signature: 'info', detail: 'Runtime information' },
    { name: 'jsonPath', signature: "jsonPath(json, '$.path')", detail: 'Evaluate a JsonPath expression' },
    { name: 'keysOf', signature: 'keysOf(map)', detail: 'Keys of an object' },
    { name: 'log', signature: 'log(values...)', detail: 'Write to the log' },
    { name: 'map', signature: 'map(list, fn)', detail: 'Transform each item of a list' },
    { name: 'match', signature: 'match(actual, expected)', detail: 'Match programmatically; returns { pass, message }' },
    { name: 'merge', signature: 'merge(a, b)', detail: 'Merge two objects' },
    { name: 'os', signature: 'os', detail: 'Operating system info' },
    { name: 'pause', signature: 'pause(millis)', detail: 'Wait (ignored in performance runs)' },
    { name: 'pretty', signature: 'pretty(json)', detail: 'Pretty-print JSON' },
    { name: 'prettyXml', signature: 'prettyXml(xml)', detail: 'Pretty-print XML' },
    { name: 'properties', signature: 'properties', detail: 'JVM system properties' },
    { name: 'proceed', signature: 'proceed(url)', detail: 'Continue a mock request to the real server' },
    { name: 'read', signature: "read('file')", detail: 'Read a file (classpath: or relative)' },
    { name: 'readAsBytes', signature: "readAsBytes('file')", detail: 'Read a file as bytes' },
    { name: 'readAsString', signature: "readAsString('file')", detail: 'Read a file as text' },
    { name: 'remove', signature: "remove('name', '$.path')", detail: 'Remove a path from a variable' },
    { name: 'repeat', signature: 'repeat(count, fn)', detail: 'Build a list by calling a function' },
    { name: 'scenario', signature: 'scenario', detail: 'Info about the current scenario' },
    { name: 'scenarioOutline', signature: 'scenarioOutline', detail: 'Info about the current outline' },
    { name: 'set', signature: "set('name', value)", detail: 'Set a variable (or a path in one)' },
    { name: 'setup', signature: "setup('name')", detail: 'Run a @setup scenario' },
    { name: 'setupOnce', signature: "setupOnce('name')", detail: 'Run a @setup scenario once' },
    { name: 'setXml', signature: "setXml('name', '/path', xml)", detail: 'Set an XML path' },
    { name: 'signal', signature: 'signal(result)', detail: 'Complete a listen wait' },
    { name: 'sizeOf', signature: 'sizeOf(listOrMap)', detail: 'Number of items' },
    { name: 'sort', signature: 'sort(list, fn)', detail: 'Sort a list' },
    { name: 'split', signature: "split(text, ',')", detail: 'Split text into a list' },
    { name: 'stop', signature: 'stop(port)', detail: 'Pause for a debugger' },
    { name: 'tags', signature: 'tags', detail: 'Tags of the current scenario' },
    { name: 'tagValues', signature: 'tagValues', detail: 'Tag values of the current scenario' },
    { name: 'target', signature: 'target(options)', detail: 'Start a target service' },
    { name: 'toAbsolutePath', signature: "toAbsolutePath('file')", detail: 'Absolute path of a file' },
    { name: 'toBean', signature: 'toBean(json, className)', detail: 'Convert JSON to a Java bean' },
    { name: 'toBytes', signature: 'toBytes(list)', detail: 'Convert numbers to bytes' },
    { name: 'toCsv', signature: 'toCsv(list)', detail: 'Convert a list of objects to CSV' },
    { name: 'toJava', signature: 'toJava(value)', detail: 'Convert to a Java object' },
    { name: 'toJson', signature: 'toJson(value)', detail: 'Convert to JSON' },
    { name: 'urlEncode', signature: 'urlEncode(text)', detail: 'URL-encode text' },
    { name: 'uuid', signature: 'uuid()', detail: 'Random UUID' },
    { name: 'valuesOf', signature: 'valuesOf(map)', detail: 'Values of an object' },
    { name: 'waitForHttp', signature: "waitForHttp('url')", detail: 'Wait until a URL responds' },
    { name: 'write', signature: "write(value, 'file')", detail: 'Write a file under the output folder' },
    { name: 'xmlPath', signature: "xmlPath(xml, '/path')", detail: 'Evaluate an XPath expression' }
];

export const CONFIGURE_KEYS: ReadonlyArray<{ key: string; detail: string }> = [
    { key: 'headers', detail: 'Default request headers (object or function)' },
    { key: 'cookies', detail: 'Default cookies' },
    { key: 'ssl', detail: 'Enable TLS, or set a trust store' },
    { key: 'proxy', detail: 'HTTP proxy' },
    { key: 'connectTimeout', detail: 'Connect timeout in milliseconds' },
    { key: 'readTimeout', detail: 'Read timeout in milliseconds' },
    { key: 'followRedirects', detail: 'Follow HTTP redirects' },
    { key: 'charset', detail: 'Default character set' },
    { key: 'retry', detail: 'Retry count and interval for retry until' },
    { key: 'report', detail: 'Report detail: showLog, showAllSteps' },
    { key: 'logPrettyRequest', detail: 'Pretty-print requests in the log' },
    { key: 'logPrettyResponse', detail: 'Pretty-print responses in the log' },
    { key: 'printEnabled', detail: 'Enable or silence print' },
    { key: 'lowerCaseResponseHeaders', detail: 'Lower-case response header names' },
    { key: 'abortedStepsShouldPass', detail: 'Treat aborted steps as passed' },
    { key: 'continueOnStepFailure', detail: 'Keep running after a failed step' },
    { key: 'afterScenario', detail: 'Function run after each scenario' },
    { key: 'afterFeature', detail: 'Function run after each feature' },
    { key: 'localAddress', detail: 'Local network address to bind' },
    { key: 'ntlmAuth', detail: 'NTLM credentials' },
    { key: 'logModifier', detail: 'Mask sensitive data in logs' }
];

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

export const STATUS_CODES: ReadonlyArray<{ code: number; detail: string }> = [
    { code: 200, detail: 'OK' }, { code: 201, detail: 'Created' }, { code: 202, detail: 'Accepted' }, { code: 204, detail: 'No Content' },
    { code: 301, detail: 'Moved Permanently' }, { code: 302, detail: 'Found' }, { code: 304, detail: 'Not Modified' },
    { code: 400, detail: 'Bad Request' }, { code: 401, detail: 'Unauthorized' }, { code: 403, detail: 'Forbidden' },
    { code: 404, detail: 'Not Found' }, { code: 405, detail: 'Method Not Allowed' }, { code: 409, detail: 'Conflict' },
    { code: 415, detail: 'Unsupported Media Type' }, { code: 422, detail: 'Unprocessable Entity' }, { code: 429, detail: 'Too Many Requests' },
    { code: 500, detail: 'Internal Server Error' }, { code: 502, detail: 'Bad Gateway' }, { code: 503, detail: 'Service Unavailable' }
];

export const HEADER_NAMES = ['Authorization', 'Content-Type', 'Accept', 'Accept-Language', 'Cache-Control', 'Cookie', 'If-Match', 'If-None-Match', 'Origin', 'User-Agent', 'X-Api-Key', 'X-Request-Id', 'X-Correlation-Id'];

export const CONTENT_TYPES = ['application/json', 'application/xml', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'text/html', 'application/octet-stream'];

export const BUILTIN_TAGS: ReadonlyArray<{ tag: string; detail: string }> = [
    { tag: '@ignore', detail: 'Skip this scenario or feature' },
    { tag: '@setup', detail: 'Setup scenario, run with karate.setup()' },
    { tag: '@parallel=false', detail: 'Run this feature on its own thread' },
    { tag: '@report=false', detail: 'Hide from the report' },
    { tag: '@env=', detail: 'Run only for this karate.env' },
    { tag: '@envnot=', detail: 'Do not run for this karate.env' }
];

export const BUILTIN_VARIABLES = ['response', 'responseStatus', 'responseHeaders', 'responseTime', 'responseCookies', 'responseType', 'karate', 'read', '__arg', '__loop'];

/** Default expected status per HTTP method. */
export const DEFAULT_STATUS: Record<string, number> = { get: 200, post: 201, put: 200, patch: 200, delete: 204, head: 200, options: 200 };
