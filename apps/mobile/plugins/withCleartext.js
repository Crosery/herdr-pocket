// Allow http:// relays (LAN / self-hosted without TLS). Use https in production.
// Android: cleartext traffic. iOS: App Transport Security lets plain http/ws through
// (fetch, the main socket and the native voice and alert sockets all follow it).
const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");
module.exports = (config) => {
  config = withAndroidManifest(config, (c) => {
    c.modResults.manifest.application[0].$["android:usesCleartextTraffic"] = "true";
    return c;
  });
  return withInfoPlist(config, (c) => {
    c.modResults.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true };
    return c;
  });
};
