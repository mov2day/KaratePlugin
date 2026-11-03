function fn() {
  var env = karate.env || 'dev';
  var System = Java.type('java.lang.System');
  var config = { env: env, baseUrl: System.getenv('WB_BASE_URL') || 'http://127.0.0.1:8099' };
  if (env == 'staging') { config.baseUrl = 'http://127.0.0.1:1'; }
  config.token = karate.callSingle('classpath:auth.feature').token;
  return config;
}
